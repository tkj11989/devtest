# Document Summarizer

Upload a document → OCR → identify sections → store in a RAG vector DB → choose sections →
summarize them with **Qwen running locally in Ollama** → preview (with **Back to sections** / **Home**).
You can also **ask questions** about one document or all uploaded documents (RAG Q&A with cited sources).

- **Web app**: served by the FastAPI server at `/`.
- **Android & iOS app**: React Native / Expo in [`mobile/`](mobile/README.md). It calls the same server
  API, so web and mobile share one Qwen model, one ChromaDB RAG database and the same accounts.
- **Login required**: passwordless, using a one-time code sent to your **email** (SMTP) or **mobile
  number** (SMS via Twilio). Each user sees only their own documents, summaries and Q&A results.

Document processing and AI run on your own server. The only external services are the email/SMS
providers that deliver login codes.

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
4. `cp .env.example .env` and configure login (see [Login](#login-otp)). Also adjust models,
   Ollama URL, OCR language and data dir if needed.

## Run

```bash
uvicorn docsum.main:app --host 0.0.0.0 --port 8000
```
Open <http://localhost:8000> and log in. The top bar shows whether Qwen, the embedding model and
Tesseract are available. For the phone app, see [mobile/README.md](mobile/README.md).

## Login (OTP)

Enter an email address or a mobile number with country code (e.g. `+919876543210`). A 6-digit code is
sent and you type it in to log in. The first login creates the account. An email address and a phone
number are separate accounts.

| Channel | Configure in `.env` |
|---------|---------------------|
| Email | `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM` (Gmail: `smtp.gmail.com` + an App Password) |
| SMS | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` |
| Local testing | `OTP_DEV_MODE=true` prints codes in the server log. **Never enable it in production.** |

Security rules: codes expire after 5 minutes and are single-use. A code is locked after 5 wrong
attempts. Resends are limited to one every 30 s and 5 per hour per email/number. Sessions last 30 days
and end on logout. Codes and session tokens are stored only as HMAC hashes (`data/auth.db`, key in
`AUTH_SECRET` or `data/secret.key`).

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
| `OTP_DEV_MODE` | `false` | Log login codes instead of sending them (dev only) |
| `DEFAULT_COUNTRY_CODE` | – | Prefix for numbers typed without a country code, e.g. `+91` |
| `SMTP_*`, `TWILIO_*` | – | Email / SMS delivery of login codes |
| `AUTH_SECRET` | auto | Secret for hashing codes and tokens |
| `CORS_ORIGINS` | – | Browser origins allowed to call the API (Expo web only) |

If you change the embedding model, delete `data/` (existing vectors use the old model's dimensions).

## API

All endpoints except `/api/health` and `/api/auth/request-otp|verify-otp` need
`Authorization: Bearer <token>`.

| Method | Path | |
|--------|------|---|
| `GET` | `/api/health` | Ollama / model / Tesseract / login channel status |
| `POST` | `/api/auth/request-otp` | `{"identifier": "you@example.com"}` or a `+91…` number → sends a code |
| `POST` | `/api/auth/verify-otp` | `{"identifier": "...", "code": "123456"}` → `{token, user}` |
| `GET` | `/api/auth/me` | Current user |
| `POST` | `/api/auth/logout` | End the session |
| `POST` | `/api/documents` | Upload (multipart `file`) → document with sections |
| `GET` | `/api/documents` | List your documents |
| `GET` | `/api/documents/{id}` | Document + section list |
| `GET` | `/api/documents/{id}/sections/{sid}` | Full section text |
| `POST` | `/api/documents/{id}/summarize` | `{"section_ids": ["s1"], "style": "brief", "refresh": false}` |
| `POST` | `/api/qa` | `{"question": "...", "doc_id": null, "top_k": 5}` → answer + sources |
| `DELETE` | `/api/documents/{id}` | Remove document and its vectors |

## Project layout

```
docsum/
  main.py      FastAPI routes (auth, upload pipeline, summarize, Q&A)
  auth.py      OTP login (email/SMS), sessions, rate limits
  ocr.py       Text extraction + Tesseract OCR
  sections.py  Heading detection / section splitting
  rag.py       Chunking, embeddings, ChromaDB search
  llm.py       Ollama client: summarize (map-reduce), answer, embed
  store.py     Uploaded files, metadata and cached summaries
  static/      Web UI (Login, Home, Sections, Preview, Q&A)
mobile/        Android & iOS app (Expo / React Native)
tests/         pytest suite using a fake Ollama server and a fake OTP sender
```

## Tests

```bash
pip install -r requirements-dev.txt
pytest
```
The tests mock Ollama, so they don't need a running model.
