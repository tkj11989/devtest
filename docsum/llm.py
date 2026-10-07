"""Thin client for a local Ollama server (Qwen for generation, an embedding model for RAG)."""
from __future__ import annotations

import httpx

from .config import settings


class OllamaError(RuntimeError):
    pass


SUMMARY_STYLES = {
    "brief": "Write a concise summary in 3-5 sentences.",
    "detailed": "Write a thorough summary in a few paragraphs covering all key points, figures and conclusions.",
    "bullets": "Summarize as 5-10 bullet points (use '- ' for each bullet), most important first.",
}

SUMMARY_SYSTEM = (
    "You are an expert document analyst. Summarize only the text you are given. "
    "Do not invent facts. Keep names, numbers and dates exact. Reply in the language of the text."
)

QA_SYSTEM = (
    "You answer questions about the user's uploaded documents using ONLY the provided context excerpts. "
    "Cite excerpts inline like [1], [2]. If the context does not contain the answer, say you could not "
    "find it in the documents. Be concise."
)

# Roughly 3-4k tokens of input per call keeps small local models accurate and fast.
MAX_CHARS_PER_CALL = 12000


class OllamaClient:
    def __init__(self, base_url: str | None = None, model: str | None = None,
                 embed_model: str | None = None, timeout: float | None = None,
                 transport: httpx.BaseTransport | None = None):
        self.base_url = (base_url or settings.ollama_url).rstrip("/")
        self.model = model or settings.ollama_model
        self.embed_model = embed_model or settings.embed_model
        self._client = httpx.Client(base_url=self.base_url,
                                    timeout=timeout or settings.ollama_timeout,
                                    transport=transport)

    # -- low level ---------------------------------------------------------
    def _post(self, path: str, payload: dict) -> dict:
        try:
            resp = self._client.post(path, json=payload)
        except httpx.HTTPError as exc:
            raise OllamaError(f"Cannot reach Ollama at {self.base_url}: {exc}") from exc
        if resp.status_code != 200:
            detail = resp.text[:300]
            if resp.status_code == 404 and "not found" in detail.lower():
                model = payload.get("model")
                detail += f" — run `ollama pull {model}`"
            raise OllamaError(f"Ollama error {resp.status_code}: {detail}")
        return resp.json()

    def health(self) -> dict:
        try:
            resp = self._client.get("/api/tags", timeout=5)
            resp.raise_for_status()
            names = [m.get("name", "") for m in resp.json().get("models", [])]
        except (httpx.HTTPError, ValueError) as exc:
            return {"reachable": False, "error": str(exc), "url": self.base_url}

        def has(model: str) -> bool:
            base = model if ":" in model else f"{model}:latest"
            return model in names or base in names

        return {
            "reachable": True,
            "url": self.base_url,
            "model": self.model,
            "model_available": has(self.model),
            "embed_model": self.embed_model,
            "embed_model_available": has(self.embed_model),
        }

    def chat(self, user: str, system: str | None = None, temperature: float = 0.2) -> str:
        messages = ([{"role": "system", "content": system}] if system else []) + [{"role": "user", "content": user}]
        data = self._post("/api/chat", {
            "model": self.model,
            "messages": messages,
            "stream": False,
            "options": {"temperature": temperature},
        })
        return (data.get("message", {}).get("content") or "").strip()

    def embed(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []
        data = self._post("/api/embed", {"model": self.embed_model, "input": texts})
        embeddings = data.get("embeddings")
        if not embeddings or len(embeddings) != len(texts):
            raise OllamaError("Ollama returned no embeddings; is the embedding model an embedding model?")
        return embeddings

    # -- tasks -------------------------------------------------------------
    def summarize(self, title: str, text: str, style: str = "brief") -> str:
        instruction = SUMMARY_STYLES.get(style, SUMMARY_STYLES["brief"])
        chunks = split_text(text, MAX_CHARS_PER_CALL)
        if len(chunks) == 1:
            return self.chat(f"Section: {title}\n\n{instruction}\n\nText:\n\"\"\"\n{text}\n\"\"\"", SUMMARY_SYSTEM)

        # Map-reduce for long sections: summarize each part, then combine.
        partials = [
            self.chat(
                f"Section: {title} (part {i} of {len(chunks)})\n\n"
                f"Summarize this part in detail, keeping key facts.\n\nText:\n\"\"\"\n{chunk}\n\"\"\"",
                SUMMARY_SYSTEM,
            )
            for i, chunk in enumerate(chunks, start=1)
        ]
        joined = "\n\n".join(f"Part {i}:\n{p}" for i, p in enumerate(partials, start=1))
        return self.chat(
            f"Section: {title}\n\nThese are summaries of consecutive parts of one section. "
            f"Combine them into a single summary. {instruction}\n\n{joined}",
            SUMMARY_SYSTEM,
        )

    def answer(self, question: str, contexts: list[dict]) -> str:
        if not contexts:
            return "I could not find anything relevant to that question in the uploaded documents."
        blocks = [
            f"[{i}] (Document: {c['filename']}, Section: {c['section_title']})\n{c['text']}"
            for i, c in enumerate(contexts, start=1)
        ]
        prompt = "Context excerpts:\n\n" + "\n\n".join(blocks) + f"\n\nQuestion: {question}"
        return self.chat(prompt, QA_SYSTEM, temperature=0.1)


def split_text(text: str, max_chars: int, overlap: int = 0) -> list[str]:
    """Split on paragraph/line/sentence boundaries into chunks of at most ``max_chars``."""
    text = text.strip()
    if len(text) <= max_chars:
        return [text] if text else []

    chunks: list[str] = []
    start = 0
    while start < len(text):
        end = min(start + max_chars, len(text))
        if end < len(text):
            window = text[start:end]
            for sep in ("\n\n", "\n", ". ", " "):
                cut = window.rfind(sep)
                if cut > max_chars // 2:
                    end = start + cut + len(sep)
                    break
        chunk = text[start:end].strip()
        if chunk:
            chunks.append(chunk)
        if end >= len(text):
            break
        start = max(end - overlap, start + 1)
    return chunks
