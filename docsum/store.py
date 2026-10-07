"""File-based document registry: original upload + metadata/sections/summaries as JSON."""
from __future__ import annotations

import json
import shutil
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path

from .sections import Section


class DocumentStore:
    def __init__(self, root: Path):
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()

    def _dir(self, doc_id: str) -> Path:
        if not doc_id.isalnum():
            raise KeyError(doc_id)
        return self.root / doc_id

    def new_id(self) -> str:
        return uuid.uuid4().hex[:12]

    def upload_path(self, doc_id: str, filename: str) -> Path:
        d = self._dir(doc_id)
        d.mkdir(parents=True, exist_ok=True)
        return d / ("original" + Path(filename).suffix.lower())

    def save(self, doc_id: str, filename: str, sections: list[Section], pages: int, ocr_pages: int, chunks: int) -> dict:
        meta = {
            "id": doc_id,
            "filename": filename,
            "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "pages": pages,
            "ocr_pages": ocr_pages,
            "chunks": chunks,
            "sections": [s.to_dict() for s in sections],
            "summaries": {},
        }
        self._write(doc_id, meta)
        return meta

    def _write(self, doc_id: str, meta: dict) -> None:
        path = self._dir(doc_id) / "meta.json"
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(meta, ensure_ascii=False, indent=1))
        tmp.replace(path)

    def get(self, doc_id: str) -> dict:
        path = self._dir(doc_id) / "meta.json"
        if not path.is_file():
            raise KeyError(doc_id)
        return json.loads(path.read_text())

    def list(self) -> list[dict]:
        docs = []
        for meta_path in self.root.glob("*/meta.json"):
            meta = json.loads(meta_path.read_text())
            docs.append({k: meta[k] for k in ("id", "filename", "created_at", "pages", "ocr_pages")}
                        | {"section_count": len(meta["sections"])})
        return sorted(docs, key=lambda d: d["created_at"], reverse=True)

    def delete(self, doc_id: str) -> None:
        d = self._dir(doc_id)
        if not d.is_dir():
            raise KeyError(doc_id)
        shutil.rmtree(d)

    def get_summary(self, doc_id: str, section_id: str, style: str) -> str | None:
        return self.get(doc_id).get("summaries", {}).get(f"{section_id}:{style}")

    def set_summary(self, doc_id: str, section_id: str, style: str, summary: str) -> None:
        with self._lock:
            meta = self.get(doc_id)
            meta.setdefault("summaries", {})[f"{section_id}:{style}"] = summary
            self._write(doc_id, meta)
