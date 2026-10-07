"""RAG store: section text is chunked, embedded with Ollama and kept in ChromaDB."""
from __future__ import annotations

from pathlib import Path
from typing import Callable

import chromadb

from .llm import split_text
from .sections import Section

CHUNK_CHARS = 1000
CHUNK_OVERLAP = 150
COLLECTION = "documents"

Embedder = Callable[[list[str]], list[list[float]]]


class RagStore:
    def __init__(self, path: Path, embedder: Embedder):
        path.mkdir(parents=True, exist_ok=True)
        self._client = chromadb.PersistentClient(path=str(path))
        # Embeddings are always supplied explicitly, so no embedding function is configured.
        self._col = self._client.get_or_create_collection(
            COLLECTION, embedding_function=None, metadata={"hnsw:space": "cosine"}
        )
        self._embed = embedder

    def index_document(self, doc_id: str, owner_id: int, filename: str, sections: list[Section]) -> int:
        ids, texts, metas = [], [], []
        for section in sections:
            for n, chunk in enumerate(split_text(section.text, CHUNK_CHARS, CHUNK_OVERLAP)):
                ids.append(f"{doc_id}:{section.id}:{n}")
                texts.append(chunk)
                metas.append({
                    "doc_id": doc_id,
                    "owner_id": owner_id,
                    "filename": filename,
                    "section_id": section.id,
                    "section_title": section.title,
                    "page_start": section.page_start,
                    "page_end": section.page_end,
                })
        if not ids:
            return 0
        # Prefix the section title so each chunk's embedding keeps its context.
        embed_inputs = [f"{m['section_title']}\n{t}" for m, t in zip(metas, texts)]
        batch = 64
        for i in range(0, len(ids), batch):
            self._col.upsert(
                ids=ids[i:i + batch],
                documents=texts[i:i + batch],
                metadatas=metas[i:i + batch],
                embeddings=self._embed(embed_inputs[i:i + batch]),
            )
        return len(ids)

    def delete_document(self, doc_id: str) -> None:
        self._col.delete(where={"doc_id": doc_id})

    def search(self, query: str, owner_id: int, doc_id: str | None = None, k: int = 5) -> list[dict]:
        if self._col.count() == 0:
            return []
        # Always scope to the user's own documents.
        where = {"owner_id": owner_id}
        if doc_id:
            where = {"$and": [where, {"doc_id": doc_id}]}
        result = self._col.query(
            query_embeddings=self._embed([query]),
            n_results=k,
            where=where,
            include=["documents", "metadatas", "distances"],
        )
        hits = []
        for text, meta, dist in zip(result["documents"][0], result["metadatas"][0], result["distances"][0]):
            hits.append({**meta, "text": text, "score": round(1 - float(dist), 4)})
        return hits
