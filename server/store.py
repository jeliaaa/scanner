"""Disk-backed scratch storage for in-progress scans.

Originals are kept server side so that exporting does not mean re-uploading
every page.  Sessions are plain directories under .data/ and are swept once they
go stale.
"""

from __future__ import annotations

import re
import shutil
import time
from pathlib import Path
from typing import Optional

DATA_ROOT = Path(__file__).resolve().parent / ".data" / "sessions"
SESSION_TTL_SECONDS = 24 * 60 * 60

# Session and page ids come from the browser, so they are treated as hostile
# input and must match this before they are ever concatenated into a path.
_ID_RE = re.compile(r"^[A-Za-z0-9_-]{8,64}$")


class BadId(ValueError):
    pass


def _checked(identifier: str) -> str:
    if not _ID_RE.match(identifier or ""):
        raise BadId(f"invalid id: {identifier!r}")
    return identifier


def session_dir(session_id: str, create: bool = False) -> Path:
    path = DATA_ROOT / _checked(session_id)
    if create:
        path.mkdir(parents=True, exist_ok=True)
    return path


def page_path(session_id: str, page_id: str, kind: str = "orig") -> Path:
    suffix = {"orig": ".orig.jpg", "thumb": ".thumb.jpg"}[kind]
    return session_dir(session_id) / (_checked(page_id) + suffix)


def write_page(session_id: str, page_id: str, original: bytes, thumb: bytes) -> None:
    session_dir(session_id, create=True)
    page_path(session_id, page_id, "orig").write_bytes(original)
    page_path(session_id, page_id, "thumb").write_bytes(thumb)


def read_page(session_id: str, page_id: str, kind: str = "orig") -> Optional[bytes]:
    path = page_path(session_id, page_id, kind)
    return path.read_bytes() if path.exists() else None


def delete_page(session_id: str, page_id: str) -> bool:
    removed = False
    for kind in ("orig", "thumb"):
        path = page_path(session_id, page_id, kind)
        if path.exists():
            path.unlink()
            removed = True
    return removed


def delete_session(session_id: str) -> None:
    shutil.rmtree(session_dir(session_id), ignore_errors=True)


def sweep_stale(ttl: int = SESSION_TTL_SECONDS) -> int:
    """Remove sessions untouched for longer than the TTL.  Returns the count."""
    if not DATA_ROOT.exists():
        return 0
    cutoff = time.time() - ttl
    removed = 0
    for path in DATA_ROOT.iterdir():
        if not path.is_dir():
            continue
        try:
            newest = max((f.stat().st_mtime for f in path.iterdir()), default=path.stat().st_mtime)
        except OSError:
            continue
        if newest < cutoff:
            shutil.rmtree(path, ignore_errors=True)
            removed += 1
    return removed
