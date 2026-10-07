# Document Summarizer

Upload a document → OCR → identify sections → store in a RAG vector DB → choose sections →
summarize them with **Qwen running locally in Ollama** → preview (with **Back to sections** / **Home**).
You can also **ask questions** about one document or all uploaded documents (RAG Q&A with cited sources).

Everything runs locally: no document text leaves your machine.

```
Upload ─► Extract text ─► Detect sections ─► Chunk + embed ─► ChromaDB
          (PDF text layer,  (font size, bold,   (Ollama            │
           Tesseract OCR     numbering, CAPS,    nomic-embed-text) │
           for scans/images) Word/MD headings)                     │
                                                                   ▼
Sections page ─► select sections + style ─► Qwen (Ollama) ─► Summary preview
      ▲                                                        │  Copy / Download .md / Regenerate
      └──────────────── ← Back to sections ─── ⌂ Home ◄────────┘

Q&A box (Home = all docs, Sections page = this doc) ─► vector search ─► Qwen answers with [n] citations
```

## Supported files

| Type | How text is obtained |
|------|----------------------|
| PDF (digital) | Native text layer via PyMuPDF (keeps font sizes for heading detection) |
| PDF (scanned) | Pages with no text layer are rendered at 300 dpi and OCR'd with Tesseract |
| PNG / JPG / TIFF (multi-page) / BMP / WEBP | Tesseract OCR |
| DOCX | Paragraphs + Word heading styles |
| TXT / MD | Lines; Markdown `#` headings are used |

## Setup

1. **Python 3.10+**, then:
   ```bash
   python -m venv .venv && source .venv/bin/activate
   pip install -r requirements.txt
   ```
2. **Tesseract OCR** (needed for scanned PDFs and images):
   - Ubuntu/Debian: `sudo apt install tesseract-ocr` (add e.g. `tesseract-ocr-hin` for more languages)
   - macOS: `brew install tesseract`
   - Windows: install the UB Mannheim build and set `TESSERACT_CMD` in `.env`
3. **Ollama** (<https://ollama.com>) with the Qwen and embedding models:
   ```bash
   ollama pull qwen2.5:7b          # summarizer / Q&A model (any Qwen tag works, e.g. qwen2.5:3b, qwen3:8b)
   ollama pull nomic-embed-text    # embeddings for the RAG DB
   ```
4. Optional: `cp .env.example .env` and adjust models, Ollama URL, OCR language, data dir.

## Run

```bash
uvicorn docsum.main:app --port 8000
```
Open <http://localhost:8000>. The top bar shows whether Qwen, the embedding model and Tesseract are available.

## Using it

1. **Home**: drop a file. It is OCR'd, split into sections and indexed, then you land on its sections page.
2. **Sections**: tick the sections you want (or *Select all*), pick a style (*Brief*, *Bullet points*,
   *Detailed*) and click **Summarize selected**. *View full text* shows a section's extracted text.
3. **Preview**: summaries appear one section at a time. Copy them, download as Markdown, or regenerate.
   **← Back to sections** keeps your selection; **⌂ Home** returns to the start.
4. **Ask questions**: on Home (searches all documents) or on a document's page (that document only).
   Answers cite the excerpts used; expand a source to see the exact text.

Summaries are cached per section and style, so revisiting a preview is instant. Long sections are
summarized map-reduce style (part summaries, then a combined summary) to stay within the model's context.

## Configuration (`.env`)

| Variable | Default | |
|----------|---------|---|
| `OLLAMA_URL` | `http://localhost:11434` | Ollama server |
| `OLLAMA_MODEL` | `qwen2.5:7b` | Model for summaries and answers |
| `OLLAMA_EMBED_MODEL` | `nomic-embed-text` | Embedding model for the RAG DB |
| `OLLAMA_TIMEOUT` | `300` | Seconds per model call |
| `DATA_DIR` | `./data` | Uploads, metadata and the Chroma DB |
| `OCR_LANG` | `eng` | Tesseract language(s), e.g. `eng+hin` |
| `TESSERACT_CMD` | – | Path to `tesseract` if not on `PATH` |
| `MAX_UPLOAD_MB` | `50` | Upload size limit |

If you change the embedding model, delete `data/` (existing vectors use the old model's dimensions).

## API

| Method | Path | |
|--------|------|---|
| `GET` | `/api/health` | Ollama / model / Tesseract status |
| `POST` | `/api/documents` | Upload (multipart `file`) → document with sections |
| `GET` | `/api/documents` | List documents |
| `GET` | `/api/documents/{id}` | Document + section list |
| `GET` | `/api/documents/{id}/sections/{sid}` | Full section text |
| `POST` | `/api/documents/{id}/summarize` | `{"section_ids": ["s1"], "style": "brief", "refresh": false}` |
| `POST` | `/api/qa` | `{"question": "...", "doc_id": null, "top_k": 5}` → answer + sources |
| `DELETE` | `/api/documents/{id}` | Remove document and its vectors |

## Project layout

```
docsum/
  main.py      FastAPI routes (upload pipeline, summarize, Q&A)
  ocr.py       Text extraction + Tesseract OCR
  sections.py  Heading detection / section splitting
  rag.py       Chunking, embeddings, ChromaDB search
  llm.py       Ollama client: summarize (map-reduce), answer, embed
  store.py     Uploaded files, metadata and cached summaries
  static/      Single-page UI (Home, Sections, Preview, Q&A)
tests/         pytest suite using a fake Ollama server
```

## Tests

```bash
pip install -r requirements-dev.txt
pytest
```
The tests mock Ollama, so they don't need a running model.
