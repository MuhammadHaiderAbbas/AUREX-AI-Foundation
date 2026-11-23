"""Paragraph- and sentence-aware chunking that preserves page and paragraph references."""

import re
from dataclasses import dataclass

from app.research.extract import Section
from app.research.text import sentences

TARGET = 900
HARD_MAX = 1400


@dataclass
class Chunk:
    ordinal: int
    text: str
    page: int | None
    paragraph: int


def chunk_sections(sections: list[Section]) -> list[Chunk]:
    chunks: list[Chunk] = []
    para_no = 0
    for sec in sections:
        buf: list[str] = []
        buf_para = None
        size = 0

        def flush(page=sec.page):
            nonlocal buf, size, buf_para
            if buf:
                chunks.append(Chunk(len(chunks), "\n\n".join(buf).strip(), page, buf_para or 1))
            buf, size, buf_para = [], 0, None

        for para in re.split(r"\n\s*\n", sec.text):
            para = re.sub(r"\s+", " ", para).strip()
            if not para:
                continue
            para_no += 1
            pieces = [para]
            if len(para) > HARD_MAX:  # split oversized paragraphs on sentence boundaries
                pieces, cur = [], ""
                for s in sentences(para):
                    if cur and len(cur) + len(s) + 1 > TARGET:
                        pieces.append(cur)
                        cur = s
                    else:
                        cur = f"{cur} {s}".strip()
                if cur:
                    pieces.append(cur)
            for piece in pieces:
                if size and size + len(piece) > TARGET:
                    flush()
                if buf_para is None:
                    buf_para = para_no
                buf.append(piece)
                size += len(piece) + 2
        flush()
    return chunks
