"""
In-app documentation — serves the markdown files under docs/ so they can be
read from the UI instead of only from a repo checkout.
"""
from __future__ import annotations

import re
from pathlib import Path

from fastapi import APIRouter, HTTPException

from app.config import get_settings
from app.dependencies import CurrentUser

router = APIRouter()


def _docs_dir() -> Path:
    return Path(get_settings().install_dir) / "docs"


def _title_from_filename(filename: str) -> str:
    stem = Path(filename).stem
    words = re.split(r"[-_]+", stem)
    return " ".join(w if w.isupper() and len(w) <= 3 else w.capitalize() for w in words)


def _is_admin_only(stem: str) -> bool:
    return stem.upper().startswith("ADMIN_") or stem.upper().startswith("ADMIN-")


@router.get("")
async def list_docs(user: CurrentUser) -> list[dict]:
    """List available documents, one per docs/*.md file, sorted by title.

    Admin-only docs (ADMIN_*.md) are omitted for non-admin users.
    """
    docs_dir = _docs_dir()
    if not docs_dir.is_dir():
        return []
    items = [
        {"slug": f.stem, "title": _title_from_filename(f.name)}
        for f in docs_dir.glob("*.md")
        if user["role"] == "admin" or not _is_admin_only(f.stem)
    ]
    items.sort(key=lambda d: d["title"])
    return items


@router.get("/{slug}")
async def get_doc(slug: str, user: CurrentUser) -> dict:
    """Return the raw markdown content of one doc, identified by filename stem."""
    if not re.fullmatch(r"[A-Za-z0-9_-]+", slug):
        raise HTTPException(400, "Invalid document identifier")
    if _is_admin_only(slug) and user["role"] != "admin":
        raise HTTPException(403, "Admin role required")
    path = _docs_dir() / f"{slug}.md"
    if not path.is_file():
        raise HTTPException(404, "Document not found")
    return {"slug": slug, "title": _title_from_filename(path.name), "content": path.read_text()}
