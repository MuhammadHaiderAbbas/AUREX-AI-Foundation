"""Turn uploaded/fetched bytes into text sections (with page numbers for PDFs)."""

import io
from dataclasses import dataclass

from app.core.errors import BusinessRuleViolation
from app.research.text import html_to_text, normalise

MAX_BYTES = 10 * 1024 * 1024
MAX_PDF_PAGES = 400


@dataclass
class Section:
    text: str
    page: int | None = None


@dataclass
class Extracted:
    title: str
    sections: list[Section]
    content_type: str


def sniff(content_type: str | None, filename: str | None, data: bytes) -> str:
    ct = (content_type or "").split(";")[0].strip().lower()
    name = (filename or "").lower()
    if data[:5] == b"%PDF-" or ct == "application/pdf" or name.endswith(".pdf"):
        return "application/pdf"
    head = data[:512].lstrip().lower()
    if ct in ("text/html", "application/xhtml+xml") or name.endswith((".html", ".htm")) \
            or head.startswith((b"<!doctype html", b"<html")):
        return "text/html"
    if ct in ("application/rss+xml", "application/atom+xml") or head.startswith(b"<?xml") \
            and (b"<rss" in data[:2048] or b"<feed" in data[:2048]):
        return "application/rss+xml"
    if ct.startswith("text/") or name.endswith((".txt", ".md")) or not ct:
        return "text/plain"
    raise BusinessRuleViolation(f"Unsupported content type {ct or 'unknown'}")


def _decode(data: bytes) -> str:
    for enc in ("utf-8", "cp1252", "latin-1"):
        try:
            return data.decode(enc)
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", errors="replace")


def extract(data: bytes, content_type: str, fallback_title: str = "") -> Extracted:
    if len(data) > MAX_BYTES:
        raise BusinessRuleViolation("Document exceeds the 10 MB limit")
    if content_type == "application/pdf":
        from pypdf import PdfReader
        from pypdf.errors import PdfReadError

        try:
            reader = PdfReader(io.BytesIO(data))
            if reader.is_encrypted:
                raise BusinessRuleViolation("Encrypted PDFs are not supported")
            pages = reader.pages[:MAX_PDF_PAGES]
            sections = [Section(normalise(p.extract_text() or ""), i + 1)
                        for i, p in enumerate(pages)]
            meta_title = (reader.metadata.title if reader.metadata else None) or ""
        except PdfReadError as e:
            raise BusinessRuleViolation(f"Could not read PDF: {e}") from e
        sections = [s for s in sections if s.text]
        if not sections:
            raise BusinessRuleViolation(
                "No extractable text in PDF (scanned documents need OCR, planned for later)")
        return Extracted(meta_title.strip() or fallback_title, sections, content_type)
    if content_type == "text/html":
        title, text = html_to_text(_decode(data))
        return Extracted(title or fallback_title, [Section(text)], content_type)
    text = normalise(_decode(data))
    return Extracted(fallback_title, [Section(text)], "text/plain")
