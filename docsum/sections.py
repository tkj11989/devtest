"""Heading detection and section splitting.

Signals used, strongest first:
  1. explicit heading levels (Word heading styles, Markdown ``#``)
  2. font size noticeably larger than the body text (PDF text layer)
  3. short bold lines (PDF / Word)
  4. numbered headings ("1.", "2.3 Scope", "Chapter 4", "IV.") and ALL-CAPS lines
     -- the only signals available for OCR'd text

If no structure is found, the text is split into page-based chunks so the user
still gets selectable sections.
"""
from __future__ import annotations

import re
import statistics
from dataclasses import dataclass

from .ocr import Line, Page

MAX_HEADING_CHARS = 90
FALLBACK_CHUNK_CHARS = 4000
MIN_SECTION_BODY_CHARS = 40

NUMBERED_RE = re.compile(
    r"^(?:"
    r"(?:chapter|section|part|article|appendix|annex)\s+[\dIVXLC]+[A-Z]?\b"
    r"|\d{1,2}(?:\.\d{1,2}){0,3}\.?\s+[A-Za-z]"
    r"|[IVXLC]{1,6}\.\s+[A-Za-z]"
    r"|[A-H]\.\s+[A-Z]"
    r")",
    re.IGNORECASE,
)
SENTENCE_END_RE = re.compile(r"[.;,:]$")
LIST_ITEM_HINT_RE = re.compile(r"\b(the|and|of|to|is|are|was|were|be)\s*$", re.IGNORECASE)


@dataclass
class Section:
    id: str
    title: str
    text: str
    page_start: int
    page_end: int

    def to_dict(self, include_text: bool = True) -> dict:
        data = {
            "id": self.id,
            "title": self.title,
            "page_start": self.page_start,
            "page_end": self.page_end,
            "char_count": len(self.text),
            "word_count": len(self.text.split()),
            "preview": _preview(self.text),
        }
        if include_text:
            data["text"] = self.text
        return data


def _preview(text: str, limit: int = 220) -> str:
    flat = " ".join(text.split())
    return flat if len(flat) <= limit else flat[:limit].rsplit(" ", 1)[0] + "…"


def _body_font_size(pages: list[Page]) -> float | None:
    """Most common font size weighted by characters -- i.e. the body text size."""
    weights: dict[float, int] = {}
    for page in pages:
        for line in page.lines:
            if line.size:
                weights[line.size] = weights.get(line.size, 0) + len(line.text)
    if not weights:
        return None
    return max(weights.items(), key=lambda kv: kv[1])[0]


def _is_all_caps_heading(text: str) -> bool:
    letters = [c for c in text if c.isalpha()]
    return len(letters) >= 3 and all(c.isupper() for c in letters) and len(text.split()) <= 10


def is_heading(line: Line, body_size: float | None, bold_is_rare: bool) -> bool:
    text = line.text.strip()
    if line.heading_level is not None:
        return True
    if not text or len(text) > MAX_HEADING_CHARS or len(text) < 2:
        return False
    if not any(c.isalpha() for c in text):
        return False  # page numbers, figures, separators
    if SENTENCE_END_RE.search(text) or LIST_ITEM_HINT_RE.search(text):
        return False

    if body_size and line.size and line.size >= body_size * 1.15:
        return True
    if line.bold and bold_is_rare and len(text.split()) <= 12:
        return True
    if NUMBERED_RE.match(text) and len(text.split()) <= 12:
        return True
    return _is_all_caps_heading(text)


def detect_sections(pages: list[Page]) -> list[Section]:
    body_size = _body_font_size(pages)
    all_lines = [line for page in pages for line in page.lines]
    bold_chars = sum(len(l.text) for l in all_lines if l.bold)
    total_chars = sum(len(l.text) for l in all_lines) or 1
    bold_is_rare = bold_chars / total_chars < 0.3

    raw: list[dict] = []  # {"title", "lines", "page_start", "page_end"}
    current = {"title": None, "lines": [], "page_start": pages[0].number, "page_end": pages[0].number}

    for page in pages:
        for line in page.lines:
            if is_heading(line, body_size, bold_is_rare):
                raw.append(current)
                current = {"title": line.text.strip(), "lines": [], "page_start": page.number, "page_end": page.number}
            else:
                current["lines"].append(line.text)
                current["page_end"] = page.number
    raw.append(current)

    # Leading text without a heading becomes "Introduction" (if it has substance).
    if raw[0]["title"] is None:
        if len(" ".join(raw[0]["lines"])) >= MIN_SECTION_BODY_CHARS:
            raw[0]["title"] = "Introduction"
        else:
            # Probably a document title / header; fold it into the next section.
            leading = raw.pop(0)
            if raw:
                raw[0]["lines"] = leading["lines"] + raw[0]["lines"]
                raw[0]["page_start"] = min(raw[0]["page_start"], leading["page_start"])
            else:
                raw = [leading | {"title": "Document"}]

    # Headings with (almost) no body get merged into the following section,
    # e.g. "CHAPTER 2" followed by "Methods" -> "CHAPTER 2 — Methods".
    merged: list[dict] = []
    carry: dict | None = None
    for i, sec in enumerate(raw):
        if carry is not None:
            # A bodiless heading at the very top is usually the document title:
            # keep it as text rather than prefixing it onto every section title.
            is_doc_title = i == 1 and not merged
            sec = {
                "title": sec["title"] if is_doc_title else f"{carry['title']} — {sec['title']}",
                "lines": ([carry["title"]] if is_doc_title else []) + carry["lines"] + sec["lines"],
                "page_start": carry["page_start"],
                "page_end": sec["page_end"],
            }
            carry = None
        if len(" ".join(sec["lines"])) < MIN_SECTION_BODY_CHARS:
            carry = sec
            continue
        merged.append(sec)
    if carry is not None:
        if merged:
            merged[-1]["lines"] += [carry["title"], *carry["lines"]]
            merged[-1]["page_end"] = carry["page_end"]
        else:
            merged.append(carry)

    if len(merged) <= 1:
        return _fallback_sections(pages)

    return [
        Section(
            id=f"s{i}",
            title=sec["title"],
            text="\n".join(sec["lines"]).strip(),
            page_start=sec["page_start"],
            page_end=sec["page_end"],
        )
        for i, sec in enumerate(merged, start=1)
    ]


def _fallback_sections(pages: list[Page]) -> list[Section]:
    """No headings found: group pages (or paragraphs of a single page) into chunks."""
    sections: list[Section] = []
    buf: list[str] = []
    start = pages[0].number
    end = start

    def flush() -> None:
        text = "\n".join(buf).strip()
        if not text:
            return
        label = f"Page {start}" if start == end else f"Pages {start}–{end}"
        sections.append(Section(f"s{len(sections) + 1}", f"Part {len(sections) + 1} ({label})", text, start, end))

    for page in pages:
        for line in page.lines:
            if buf and sum(len(b) for b in buf) >= FALLBACK_CHUNK_CHARS:
                flush()
                buf = []
                start = page.number
            buf.append(line.text)
            end = page.number
    flush()

    if len(sections) == 1:
        sections[0].title = "Full document"
    return sections
