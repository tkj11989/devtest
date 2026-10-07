"""Text extraction: native text layers where available, Tesseract OCR otherwise.

Every extractor returns a list of ``Page`` objects made of ``Line`` objects. Lines
carry layout hints (font size, bold, explicit heading) that the section detector
uses to find headings.
"""
from __future__ import annotations

import io
import shutil
from dataclasses import dataclass, field
from pathlib import Path

from .config import settings

PDF_EXT = {".pdf"}
IMAGE_EXT = {".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp", ".webp"}
DOCX_EXT = {".docx"}
TEXT_EXT = {".txt", ".md"}
SUPPORTED_EXT = PDF_EXT | IMAGE_EXT | DOCX_EXT | TEXT_EXT

# A PDF page with less native text than this is treated as scanned and OCR'd.
MIN_NATIVE_CHARS = 25
OCR_DPI = 300


class ExtractionError(RuntimeError):
    pass


@dataclass
class Line:
    text: str
    size: float | None = None
    bold: bool = False
    heading_level: int | None = None  # explicit heading (docx style / markdown #)


@dataclass
class Page:
    number: int
    lines: list[Line] = field(default_factory=list)
    ocr: bool = False

    @property
    def text(self) -> str:
        return "\n".join(line.text for line in self.lines)


def tesseract_available() -> bool:
    if settings.tesseract_cmd:
        return Path(settings.tesseract_cmd).is_file()
    return shutil.which("tesseract") is not None


def _ocr_image(image) -> list[Line]:
    """OCR a PIL image and return its lines (Tesseract gives no font info)."""
    if not tesseract_available():
        raise ExtractionError(
            "This document needs OCR but Tesseract is not installed. "
            "Install it (e.g. `apt install tesseract-ocr`) or set TESSERACT_CMD."
        )
    import pytesseract

    if settings.tesseract_cmd:
        pytesseract.pytesseract.tesseract_cmd = settings.tesseract_cmd
    text = pytesseract.image_to_string(image, lang=settings.ocr_lang)
    return [Line(t.strip()) for t in text.splitlines() if t.strip()]


def _extract_pdf(path: Path) -> list[Page]:
    import pymupdf
    from PIL import Image

    pages: list[Page] = []
    with pymupdf.open(path) as doc:
        for index, pdf_page in enumerate(doc, start=1):
            lines: list[Line] = []
            for block in pdf_page.get_text("dict").get("blocks", []):
                for raw_line in block.get("lines", []):
                    spans = [s for s in raw_line.get("spans", []) if s.get("text", "").strip()]
                    if not spans:
                        continue
                    text = " ".join(s["text"].strip() for s in spans)
                    size = max(s.get("size", 0) for s in spans)
                    # flags bit 4 (16) = bold; also catch "Bold" font names.
                    bold = all((s.get("flags", 0) & 16) or "bold" in s.get("font", "").lower() for s in spans)
                    lines.append(Line(text=text, size=round(size, 1), bold=bool(bold)))

            if sum(len(line.text) for line in lines) >= MIN_NATIVE_CHARS:
                pages.append(Page(index, lines))
                continue

            pix = pdf_page.get_pixmap(dpi=OCR_DPI)
            image = Image.open(io.BytesIO(pix.tobytes("png")))
            pages.append(Page(index, _ocr_image(image), ocr=True))
    return pages


def _extract_image(path: Path) -> list[Page]:
    from PIL import Image, ImageSequence

    pages = []
    with Image.open(path) as img:
        for index, frame in enumerate(ImageSequence.Iterator(img), start=1):  # multi-page TIFF
            pages.append(Page(index, _ocr_image(frame.convert("RGB")), ocr=True))
    return pages


def _extract_docx(path: Path) -> list[Page]:
    import docx

    document = docx.Document(str(path))
    lines: list[Line] = []
    for para in document.paragraphs:
        text = para.text.strip()
        if not text:
            continue
        style = (para.style.name or "").lower() if para.style is not None else ""
        level = None
        if style == "title":
            level = 1
        elif style.startswith("heading"):
            digits = "".join(ch for ch in style if ch.isdigit())
            level = int(digits) if digits else 1
        bold = bool(para.runs) and all(run.bold for run in para.runs if run.text.strip())
        lines.append(Line(text=text, bold=bold, heading_level=level))
    # Word has no fixed pages; report the whole document as page 1.
    return [Page(1, lines)]


def _extract_text(path: Path) -> list[Page]:
    raw = path.read_bytes()
    try:
        content = raw.decode("utf-8")
    except UnicodeDecodeError:
        content = raw.decode("latin-1")
    lines: list[Line] = []
    for raw_line in content.splitlines():
        text = raw_line.strip()
        if not text:
            continue
        level = None
        if text.startswith("#"):
            hashes = len(text) - len(text.lstrip("#"))
            if 1 <= hashes <= 6 and text[hashes:hashes + 1] == " ":
                level, text = hashes, text[hashes:].strip()
        lines.append(Line(text=text, heading_level=level))
    return [Page(1, lines)]


def extract_pages(path: Path) -> list[Page]:
    ext = path.suffix.lower()
    if ext in PDF_EXT:
        pages = _extract_pdf(path)
    elif ext in IMAGE_EXT:
        pages = _extract_image(path)
    elif ext in DOCX_EXT:
        pages = _extract_docx(path)
    elif ext in TEXT_EXT:
        pages = _extract_text(path)
    else:
        raise ExtractionError(f"Unsupported file type '{ext}'. Supported: {', '.join(sorted(SUPPORTED_EXT))}")

    if not any(page.lines for page in pages):
        raise ExtractionError("No text could be extracted from this document.")
    return pages
