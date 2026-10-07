import hashlib
import io
import json
import re

import httpx
import pymupdf
import pytest
from fastapi.testclient import TestClient

from docsum.auth import OtpSender
from docsum.llm import OllamaClient, split_text
from docsum.main import create_app
from docsum.ocr import Line, Page
from docsum.sections import detect_sections

DIM = 64


def fake_embedding(text: str) -> list[float]:
    vec = [0.0] * DIM
    for word in re.findall(r"[a-z]+", text.lower()):
        vec[int(hashlib.md5(word.encode()).hexdigest(), 16) % DIM] += 1.0
    return vec


class FakeOllama:
    """Mimics the Ollama HTTP API; records prompts it receives."""

    def __init__(self):
        self.prompts: list[str] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/tags":
            return httpx.Response(200, json={"models": [{"name": "qwen2.5:7b"}, {"name": "nomic-embed-text:latest"}]})
        body = json.loads(request.content)
        if request.url.path == "/api/embed":
            return httpx.Response(200, json={"embeddings": [fake_embedding(t) for t in body["input"]]})
        if request.url.path == "/api/chat":
            prompt = body["messages"][-1]["content"]
            self.prompts.append(prompt)
            reply = "ANSWER based on [1]" if "Question:" in prompt else f"SUMMARY of {len(prompt)} chars"
            return httpx.Response(200, json={"message": {"role": "assistant", "content": reply}})
        return httpx.Response(404, text="not found")


@pytest.fixture
def fake():
    return FakeOllama()


class CapturingSender(OtpSender):
    def __init__(self):
        self.sent: dict[str, str] = {}
        self.last = ""

    def send(self, ident, code):
        self.sent[ident.value] = self.last = code


def login(client, sender, identifier="user@example.com"):
    assert client.post("/api/auth/request-otp", json={"identifier": identifier}).status_code == 200
    res = client.post("/api/auth/verify-otp", json={"identifier": identifier, "code": sender.last})
    assert res.status_code == 200, res.text
    client.headers["Authorization"] = f"Bearer {res.json()['token']}"
    return res.json()


@pytest.fixture
def sender():
    return CapturingSender()


@pytest.fixture
def app(tmp_path, fake, sender):
    llm = OllamaClient("http://ollama.test", "qwen2.5:7b", "nomic-embed-text", transport=httpx.MockTransport(fake))
    return create_app(llm=llm, data_dir=tmp_path, otp_sender=sender)


@pytest.fixture
def client(app, sender):
    c = TestClient(app)
    login(c, sender)
    return c


def make_pdf() -> bytes:
    doc = pymupdf.open()
    page = doc.new_page()
    y = 72
    for text, size in [
        ("Annual Report", 22),
        ("1. Introduction", 16),
        ("The company grew revenue strongly this year across all regions and markets.", 11),
        ("2. Financial Results", 16),
        ("Revenue reached 4.2 million dollars while operating costs fell by ten percent.", 11),
        ("3. Outlook", 16),
        ("Management expects expansion into solar energy products during the next year.", 11),
    ]:
        page.insert_text((72, y), text, fontsize=size)
        y += size * 2
    data = doc.tobytes()
    doc.close()
    return data


def upload(client, name, data):
    return client.post("/api/documents", files={"file": (name, io.BytesIO(data))})


def test_pdf_flow_sections_summarize_and_qa(client, fake):
    res = upload(client, "report.pdf", make_pdf())
    assert res.status_code == 200, res.text
    doc = res.json()
    titles = [s["title"] for s in doc["sections"]]
    assert titles == ["1. Introduction", "2. Financial Results", "3. Outlook"]
    assert "text" not in doc["sections"][0]
    assert doc["chunks"] == 3

    sec = client.get(f"/api/documents/{doc['id']}/sections/s2").json()
    assert "4.2 million" in sec["text"]

    res = client.post(f"/api/documents/{doc['id']}/summarize", json={"section_ids": ["s2"], "style": "bullets"})
    assert res.status_code == 200
    assert res.json()["summaries"][0]["summary"].startswith("SUMMARY")
    assert "4.2 million" in fake.prompts[-1] and "bullet" in fake.prompts[-1]

    # Cached: no new model call on repeat.
    n = len(fake.prompts)
    client.post(f"/api/documents/{doc['id']}/summarize", json={"section_ids": ["s2"], "style": "bullets"})
    assert len(fake.prompts) == n

    res = client.post("/api/qa", json={"question": "What did revenue reach?", "doc_id": doc["id"], "top_k": 1})
    body = res.json()
    assert body["answer"].startswith("ANSWER")
    assert body["sources"][0]["section_title"] == "2. Financial Results"

    assert client.get("/api/documents").json()[0]["section_count"] == 3
    assert client.delete(f"/api/documents/{doc['id']}").status_code == 200
    assert client.get(f"/api/documents/{doc['id']}").status_code == 404
    assert client.post("/api/qa", json={"question": "revenue"}).json()["sources"] == []


def test_markdown_upload_and_cross_document_qa(client):
    md = b"# Safety\nWear helmets at all times on the construction site.\n# Hours\nThe site is open from seven until five daily."
    a = upload(client, "rules.md", md).json()
    upload(client, "report.pdf", make_pdf())
    assert [s["title"] for s in a["sections"]] == ["Safety", "Hours"]
    sources = client.post("/api/qa", json={"question": "helmets construction site", "top_k": 1}).json()["sources"]
    assert sources[0]["filename"] == "rules.md"


def test_rejects_bad_input(client):
    assert upload(client, "x.exe", b"MZ").status_code == 400
    assert upload(client, "empty.txt", b"   \n").status_code == 422
    assert client.post("/api/documents/nope/summarize", json={"section_ids": ["s1"]}).status_code == 404
    doc = upload(client, "rules.md", b"# A\n" + b"word " * 20 + b"\n# B\n" + b"word " * 20).json()
    assert client.post(f"/api/documents/{doc['id']}/summarize", json={"section_ids": ["s1"], "style": "x"}).status_code == 400
    assert client.post(f"/api/documents/{doc['id']}/summarize", json={"section_ids": ["s9"]}).status_code == 404


def test_ollama_down_returns_503(tmp_path):
    def down(request):
        raise httpx.ConnectError("refused")
    llm = OllamaClient("http://ollama.test", transport=httpx.MockTransport(down))
    sender = CapturingSender()
    client = TestClient(create_app(llm=llm, data_dir=tmp_path, otp_sender=sender))
    login(client, sender)
    assert upload(client, "a.txt", b"hello world " * 20).status_code == 503
    assert client.get("/api/documents").json() == []
    assert client.get("/api/health").json()["ollama"]["reachable"] is False


def test_ocr_style_headings_and_empty_heading_merge():
    lines = ["ACME CORP", "Intro text that is long enough to count as an introduction.",
             "CHAPTER 2", "METHODS", "We sampled water from rivers in three regions over a year.",
             "II. Results", "Nitrate levels were elevated in the northern region compared to the south."]
    sections = detect_sections([Page(1, [Line(t) for t in lines], ocr=True)])
    assert [s.title for s in sections] == ["ACME CORP", "CHAPTER 2 — METHODS", "II. Results"]


def test_fallback_chunks_when_no_headings():
    para = "this sentence has no heading structure at all and just keeps going"
    pages = [Page(n, [Line(para)] * 40) for n in (1, 2, 3)]
    sections = detect_sections(pages)
    assert len(sections) > 1
    assert sections[0].title.startswith("Part 1 (Page")


def test_long_section_uses_map_reduce(fake):
    llm = OllamaClient("http://ollama.test", transport=httpx.MockTransport(fake))
    llm.summarize("Long", "Paragraph of text. " * 2000)
    assert len(fake.prompts) >= 3
    assert "Combine them" in fake.prompts[-1]


def test_split_text_bounds():
    chunks = split_text("abc def. " * 500, 1000, 150)
    assert all(len(c) <= 1000 for c in chunks)
    assert len(chunks) > 4
