"""FastAPI app: upload -> OCR -> sections -> RAG index; summarize sections; Q&A."""
from __future__ import annotations

import logging
from pathlib import Path

from fastapi import Depends, FastAPI, File, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .auth import AuthError, AuthService, OtpSender, User
from .config import settings
from .llm import SUMMARY_STYLES, OllamaClient, OllamaError
from .ocr import SUPPORTED_EXT, ExtractionError, extract_pages, tesseract_available
from .rag import RagStore
from .sections import detect_sections
from .store import DocumentStore

log = logging.getLogger("docsum")
STATIC_DIR = Path(__file__).parent / "static"


class SummarizeRequest(BaseModel):
    section_ids: list[str] = Field(min_length=1)
    style: str = "brief"
    refresh: bool = False


class OtpRequest(BaseModel):
    identifier: str = Field(min_length=3, max_length=254, description="Email or mobile number")


class OtpVerify(OtpRequest):
    code: str = Field(min_length=4, max_length=10)


class QARequest(BaseModel):
    question: str = Field(min_length=1, max_length=2000)
    doc_id: str | None = None
    top_k: int = Field(default=5, ge=1, le=15)


def create_app(llm: OllamaClient | None = None, data_dir: Path | None = None,
               otp_sender: OtpSender | None = None) -> FastAPI:
    llm = llm or OllamaClient()
    data_dir = data_dir or settings.data_dir
    docs = DocumentStore(data_dir / "documents")
    rag = RagStore(data_dir / "chroma", embedder=llm.embed)
    auth = AuthService(data_dir / "auth.db", sender=otp_sender)

    app = FastAPI(title="Document Summarizer")
    if settings.cors_origins:
        app.add_middleware(CORSMiddleware, allow_origins=settings.cors_origins,
                           allow_methods=["*"], allow_headers=["Authorization", "Content-Type"])

    def bearer(authorization: str | None) -> str:
        scheme, _, token = (authorization or "").partition(" ")
        return token.strip() if scheme.lower() == "bearer" else ""

    def current_user(authorization: str | None = Header(default=None)) -> User:
        user = auth.authenticate(bearer(authorization))
        if user is None:
            raise HTTPException(401, "Login required", headers={"WWW-Authenticate": "Bearer"})
        return user

    def get_doc(doc_id: str, user: User) -> dict:
        try:
            meta = docs.get(doc_id)
        except KeyError:
            raise HTTPException(404, "Document not found")
        if meta.get("owner_id") != user.id:
            raise HTTPException(404, "Document not found")  # don't reveal other users' documents
        return meta

    # ---------------------------------------------------------------- auth
    @app.post("/api/auth/request-otp")
    def request_otp(req: OtpRequest):
        try:
            return auth.request_otp(req.identifier)
        except AuthError as exc:
            raise HTTPException(exc.status, str(exc))

    @app.post("/api/auth/verify-otp")
    def verify_otp(req: OtpVerify):
        try:
            token, user = auth.verify_otp(req.identifier, req.code)
        except AuthError as exc:
            raise HTTPException(exc.status, str(exc))
        return {"token": token, "user": user.to_dict()}

    @app.get("/api/auth/me")
    def me(user: User = Depends(current_user)):
        return user.to_dict()

    @app.post("/api/auth/logout")
    def logout(authorization: str | None = Header(default=None)):
        auth.logout(bearer(authorization))
        return {"ok": True}

    # ---------------------------------------------------------------- documents

    @app.get("/api/health")
    def health():
        return {"ollama": llm.health(), "tesseract": tesseract_available(),
                "styles": list(SUMMARY_STYLES), "supported_types": sorted(SUPPORTED_EXT),
                "login": {"email": bool(settings.smtp_host or settings.otp_dev_mode),
                          "phone": bool(settings.twilio_sid or settings.otp_dev_mode),
                          "dev_mode": settings.otp_dev_mode}}

    @app.post("/api/documents")
    def upload(file: UploadFile = File(...), user: User = Depends(current_user)):
        filename = Path(file.filename or "document").name
        if Path(filename).suffix.lower() not in SUPPORTED_EXT:
            raise HTTPException(400, f"Unsupported file type. Supported: {', '.join(sorted(SUPPORTED_EXT))}")

        doc_id = docs.new_id()
        path = docs.upload_path(doc_id, filename)
        limit = settings.max_upload_mb * 1024 * 1024
        size = 0
        with path.open("wb") as out:
            while chunk := file.file.read(1024 * 1024):
                size += len(chunk)
                if size > limit:
                    out.close()
                    docs.delete(doc_id)
                    raise HTTPException(413, f"File exceeds {settings.max_upload_mb} MB")
                out.write(chunk)

        try:
            pages = extract_pages(path)                      # 1. OCR / text extraction
            sections = detect_sections(pages)                # 2. section identification
            chunks = rag.index_document(doc_id, user.id, filename, sections)  # 3. store in RAG DB
        except ExtractionError as exc:
            docs.delete(doc_id)
            raise HTTPException(422, str(exc))
        except OllamaError as exc:
            docs.delete(doc_id)
            raise HTTPException(503, f"Indexing failed: {exc}")
        except Exception as exc:  # corrupt files etc.
            log.exception("Processing failed for %s", filename)
            docs.delete(doc_id)
            raise HTTPException(422, f"Could not process document: {exc}")

        meta = docs.save(doc_id, user.id, filename, sections, pages=len(pages),
                         ocr_pages=sum(p.ocr for p in pages), chunks=chunks)
        return _public(meta)

    @app.get("/api/documents")
    def list_documents(user: User = Depends(current_user)):
        return docs.list(user.id)

    @app.get("/api/documents/{doc_id}")
    def get_document(doc_id: str, user: User = Depends(current_user)):
        return _public(get_doc(doc_id, user))

    @app.get("/api/documents/{doc_id}/sections/{section_id}")
    def get_section(doc_id: str, section_id: str, user: User = Depends(current_user)):
        return _section(get_doc(doc_id, user), section_id)

    @app.delete("/api/documents/{doc_id}")
    def delete_document(doc_id: str, user: User = Depends(current_user)):
        get_doc(doc_id, user)
        rag.delete_document(doc_id)
        docs.delete(doc_id)
        return {"deleted": doc_id}

    @app.post("/api/documents/{doc_id}/summarize")
    def summarize(doc_id: str, req: SummarizeRequest, user: User = Depends(current_user)):
        if req.style not in SUMMARY_STYLES:
            raise HTTPException(400, f"Unknown style. Use one of: {', '.join(SUMMARY_STYLES)}")
        meta = get_doc(doc_id, user)
        selected = [_section(meta, sid) for sid in dict.fromkeys(req.section_ids)]

        results = []
        for sec in selected:
            cached = None if req.refresh else docs.get_summary(doc_id, sec["id"], req.style)
            if cached is None:
                try:
                    cached = llm.summarize(sec["title"], sec["text"], req.style)
                except OllamaError as exc:
                    raise HTTPException(503, str(exc))
                docs.set_summary(doc_id, sec["id"], req.style, cached)
            results.append({"section_id": sec["id"], "title": sec["title"],
                            "page_start": sec["page_start"], "page_end": sec["page_end"],
                            "summary": cached})
        return {"doc_id": doc_id, "filename": meta["filename"], "style": req.style, "summaries": results}

    @app.post("/api/qa")
    def qa(req: QARequest, user: User = Depends(current_user)):
        if req.doc_id:
            get_doc(req.doc_id, user)
        try:
            hits = rag.search(req.question, owner_id=user.id, doc_id=req.doc_id, k=req.top_k)
            answer = llm.answer(req.question, hits)
        except OllamaError as exc:
            raise HTTPException(503, str(exc))
        return {"answer": answer, "sources": [
            {"n": i, **{k: h[k] for k in ("doc_id", "filename", "section_id", "section_title",
                                          "page_start", "page_end", "score", "text")}}
            for i, h in enumerate(hits, start=1)
        ]}

    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

    @app.get("/")
    def index():
        return FileResponse(STATIC_DIR / "index.html")

    return app


def _public(meta: dict) -> dict:
    """Document metadata without full section text or cached summaries."""
    out = {k: v for k, v in meta.items() if k not in ("sections", "summaries", "owner_id")}
    out["sections"] = [{k: v for k, v in s.items() if k != "text"} for s in meta["sections"]]
    return out


def _section(meta: dict, section_id: str) -> dict:
    for sec in meta["sections"]:
        if sec["id"] == section_id:
            return sec
    raise HTTPException(404, f"Section {section_id} not found")


app = create_app()
