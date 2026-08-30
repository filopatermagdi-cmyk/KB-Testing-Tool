#!/usr/bin/env python3
"""
extract_chunks.py — KB Parser/Chunker (Phase 1, step 1)

Reads a Knowledge Base .docx and splits it into structured, addressable
"chunks" (paragraphs + table rows), each with a stable id.

This chunking logic is deliberately the same approach already proven in
CallRunner's evaluate.py (load_kb_chunks): paragraphs become chunks, and
table rows become chunks (deduplicated, since python-docx repeats merged
cells). We extend it here with:

  - a stable chunk id (chunk_001, chunk_002, ...)
  - a language tag (ar/en), detected from the Arabic Unicode block
  - a `group` field so the question generator can find chunks that belong
    together (e.g. rows of the same table) for "combined" questions later

Usage:
    python extract_chunks.py spl_kb.docx data/chunks.json

Output: data/chunks.json — a flat list of chunk objects. This is an
intermediate artifact, not the final questions.json.
"""
import json
import re
import sys
from pathlib import Path

from docx import Document

ARABIC_RE = re.compile(r"[\u0600-\u06FF]")


def detect_language(text: str) -> str:
    """Heuristic: if the text contains any Arabic-block characters, call it
    Arabic. Good enough for a KB that is predominantly one script or the
    other; not a general-purpose language detector."""
    return "ar" if ARABIC_RE.search(text) else "en"


def extract_chunks(docx_path: str) -> list[dict]:
    doc = Document(docx_path)
    chunks: list[dict] = []
    seen_table_rows: set[str] = set()
    next_id = 1

    def new_id() -> str:
        nonlocal next_id
        cid = f"chunk_{next_id:03d}"
        next_id += 1
        return cid

    # Paragraphs (excluding empty ones) — each is its own group, since
    # standalone paragraphs aren't structurally tied to their neighbors the
    # way table rows are tied to their table.
    for p in doc.paragraphs:
        text = p.text.strip()
        if not text:
            continue
        chunks.append(
            {
                "id": new_id(),
                "type": "paragraph",
                "text": text,
                "language": detect_language(text),
                "group": None,  # filled in below if it turns out to be a short "heading"
            }
        )

    # Tables hold the bulk of this KB's content. Each table becomes one
    # "group" — rows in the same table are assumed topically related, which
    # the combined-question generator (Phase 1, step 2) uses to build
    # questions that need more than one chunk.
    for t_idx, table in enumerate(doc.tables):
        group_id = f"table_{t_idx}"
        for row in table.rows:
            cells = [c.text.strip() for c in row.cells if c.text.strip()]
            row_text = " | ".join(cells)
            if not row_text or row_text in seen_table_rows:
                continue
            seen_table_rows.add(row_text)
            chunks.append(
                {
                    "id": new_id(),
                    "type": "table_row",
                    "text": row_text,
                    "language": detect_language(row_text),
                    "group": group_id,
                }
            )

    return chunks


def main() -> None:
    if len(sys.argv) != 3:
        print("Usage: python extract_chunks.py <input.docx> <output.json>", file=sys.stderr)
        sys.exit(1)

    docx_path, out_path = sys.argv[1], sys.argv[2]
    chunks = extract_chunks(docx_path)

    Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(chunks, f, ensure_ascii=False, indent=2)

    langs = {}
    for c in chunks:
        langs[c["language"]] = langs.get(c["language"], 0) + 1
    print(f"Extracted {len(chunks)} chunk(s) -> {out_path}")
    print(f"  by language: {langs}")
    print(f"  by type: paragraph={sum(1 for c in chunks if c['type']=='paragraph')}, "
          f"table_row={sum(1 for c in chunks if c['type']=='table_row')}")


if __name__ == "__main__":
    main()
