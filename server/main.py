"""FastAPI service behind the scanner UI.

All computer vision lives here, including the detection that drives the live
camera overlay.  Running one implementation instead of a browser copy and a
server copy means the outline you line the page up against is drawn by exactly
the code that will crop it.
"""

from __future__ import annotations

import json
import time
import urllib.parse
import uuid
from typing import Literal, Optional

import cv2
import numpy as np
from fastapi import Body, FastAPI, File, HTTPException, Request, Response, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

import cv_utils
import pdf_utils
import store

app = FastAPI(title="Scanner CV service", version="1.0.0")

# The browser normally reaches this through the Next.js rewrite, so it is
# same-origin.  CORS is here so the service also works when called directly,
# e.g. from a phone on the LAN pointed at the machine running it.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["X-Scan-Report", "Content-Disposition"],
)

Mode = Literal["color", "gray", "bw", "photo"]
MAX_UPLOAD_BYTES = 40 * 1024 * 1024

# A4 is 11.69 in tall, so long edge in pixels = dpi * 11.69 gives a familiar
# number to put behind a "200 DPI" label without knowing the real paper size.
A4_LONG_EDGE_INCHES = 11.69


def _decode(data: bytes) -> np.ndarray:
    image = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise HTTPException(status_code=400, detail="could not decode image")
    return image


def _jpeg(image: np.ndarray, quality: int = 85) -> bytes:
    ok, buffer = cv2.imencode(".jpg", image, [int(cv2.IMWRITE_JPEG_QUALITY), quality])
    if not ok:
        raise HTTPException(status_code=500, detail="JPEG encoding failed")
    return buffer.tobytes()


def _thumbnail(image: np.ndarray, target: int = 320) -> np.ndarray:
    scale = target / max(image.shape[:2])
    if scale >= 1:
        return image
    return cv2.resize(image, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)


def _long_edge_for(dpi: int) -> int:
    return int(round(dpi * A4_LONG_EDGE_INCHES))


class PageSpec(BaseModel):
    id: str
    quad: Optional[list[list[float]]] = None
    rotate: int = 0
    mode: Optional[Mode] = None


class RenderSettings(BaseModel):
    mode: Mode = "color"
    strength: float = Field(default=1.0, ge=0.0, le=1.5)
    dpi: int = Field(default=200, ge=72, le=600)
    quality: int = Field(default=80, ge=30, le=98)
    page_size: Literal["auto", "a4", "letter", "legal"] = "auto"


class PreviewRequest(BaseModel):
    quad: Optional[list[list[float]]] = None
    rotate: int = 0
    settings: RenderSettings = RenderSettings()
    max_dim: int = Field(default=1100, ge=200, le=2400)


class ExportRequest(BaseModel):
    pages: list[PageSpec]
    settings: RenderSettings = RenderSettings()
    filename: str = "scan.pdf"
    max_mb: Optional[float] = Field(default=None, gt=0.05, le=200)


# --------------------------------------------------------------------------- #
# lifecycle
# --------------------------------------------------------------------------- #


@app.on_event("startup")
def _startup() -> None:
    store.sweep_stale()


@app.get("/health")
def health() -> dict:
    return {"ok": True, "opencv": cv2.__version__, "service": "scanner-cv"}


# --------------------------------------------------------------------------- #
# detection (stateless - drives the live camera overlay)
# --------------------------------------------------------------------------- #


@app.post("/detect")
async def detect(request: Request) -> dict:
    """Detect the page outline in a raw image body.

    Takes the bytes straight off the request rather than as multipart: the
    camera calls this several times a second and multipart parsing is pure
    overhead at that rate.
    """
    body = await request.body()
    if not body:
        raise HTTPException(status_code=400, detail="empty body")
    if len(body) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="image too large")

    started = time.perf_counter()
    image = _decode(body)
    quad, confidence = cv_utils.detect_document(image, work_dim=480)
    return {
        "quad": quad.tolist(),
        "confidence": round(confidence, 3),
        "width": int(image.shape[1]),
        "height": int(image.shape[0]),
        "ms": round((time.perf_counter() - started) * 1000, 1),
    }


# --------------------------------------------------------------------------- #
# pages
# --------------------------------------------------------------------------- #


@app.post("/sessions/{session_id}/pages")
async def add_page(session_id: str, file: UploadFile = File(...)) -> dict:
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="empty upload")
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="image too large")

    image = _decode(data)
    quad, confidence = cv_utils.detect_document(image)
    page_id = uuid.uuid4().hex

    try:
        store.write_page(session_id, page_id, data, _jpeg(_thumbnail(image), 78))
    except store.BadId as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return {
        "id": page_id,
        "width": int(image.shape[1]),
        "height": int(image.shape[0]),
        "quad": quad.tolist(),
        "confidence": round(confidence, 3),
        "bytes": len(data),
    }


def _load(session_id: str, page_id: str) -> np.ndarray:
    try:
        data = store.read_page(session_id, page_id, "orig")
    except store.BadId as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if data is None:
        raise HTTPException(status_code=404, detail="page not found")
    return _decode(data)


@app.get("/sessions/{session_id}/pages/{page_id}/original")
def get_original(session_id: str, page_id: str) -> Response:
    try:
        data = store.read_page(session_id, page_id, "orig")
    except store.BadId as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if data is None:
        raise HTTPException(status_code=404, detail="page not found")
    return Response(content=data, media_type="image/jpeg", headers={"Cache-Control": "private, max-age=3600"})


@app.get("/sessions/{session_id}/pages/{page_id}/thumb")
def get_thumb(session_id: str, page_id: str) -> Response:
    try:
        data = store.read_page(session_id, page_id, "thumb")
    except store.BadId as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if data is None:
        raise HTTPException(status_code=404, detail="page not found")
    return Response(content=data, media_type="image/jpeg", headers={"Cache-Control": "private, max-age=3600"})


@app.post("/sessions/{session_id}/pages/{page_id}/preview")
def preview(session_id: str, page_id: str, request: PreviewRequest = Body(...)) -> Response:
    """Render one page exactly as the exporter would, but small and fast.

    Working from a downscaled original keeps this interactive while a slider is
    being dragged; the operations are all scale-invariant enough that what you
    see is what the full-resolution export produces.
    """
    image = _load(session_id, page_id)

    quad = request.quad or cv_utils.FULL_FRAME.tolist()
    warped = cv_utils.warp_document(image, quad, long_edge=request.max_dim)
    warped = cv_utils.rotate(warped, request.rotate)
    result = cv_utils.enhance(warped, mode=request.settings.mode, strength=request.settings.strength)
    return Response(content=_jpeg(result, 82), media_type="image/jpeg")


@app.post("/sessions/{session_id}/pages/{page_id}/redetect")
def redetect(session_id: str, page_id: str) -> dict:
    image = _load(session_id, page_id)
    quad, confidence = cv_utils.detect_document(image)
    return {"quad": quad.tolist(), "confidence": round(confidence, 3)}


@app.delete("/sessions/{session_id}/pages/{page_id}")
def remove_page(session_id: str, page_id: str) -> dict:
    try:
        return {"deleted": store.delete_page(session_id, page_id)}
    except store.BadId as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.delete("/sessions/{session_id}")
def remove_session(session_id: str) -> dict:
    try:
        store.delete_session(session_id)
    except store.BadId as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"deleted": True}


# --------------------------------------------------------------------------- #
# export
# --------------------------------------------------------------------------- #


@app.post("/sessions/{session_id}/export")
def export(session_id: str, request: ExportRequest = Body(...)) -> StreamingResponse:
    if not request.pages:
        raise HTTPException(status_code=400, detail="no pages selected")

    settings = request.settings
    long_edge = _long_edge_for(settings.dpi)
    started = time.perf_counter()

    rendered: list[np.ndarray] = []
    for spec in request.pages:
        image = _load(session_id, spec.id)
        quad = spec.quad or cv_utils.FULL_FRAME.tolist()
        warped = cv_utils.warp_document(image, quad, long_edge=long_edge)
        warped = cv_utils.rotate(warped, spec.rotate)
        rendered.append(
            cv_utils.enhance(warped, mode=spec.mode or settings.mode, strength=settings.strength)
        )

    max_bytes = int(request.max_mb * 1024 * 1024) if request.max_mb else None
    pdf, report = pdf_utils.build_pdf_under_size(
        rendered,
        quality=settings.quality,
        page_size=settings.page_size,
        dpi=settings.dpi,
        title=request.filename.rsplit(".", 1)[0],
        max_bytes=max_bytes,
    )

    report["pages"] = len(rendered)
    report["seconds"] = round(time.perf_counter() - started, 2)

    filename = request.filename if request.filename.lower().endswith(".pdf") else request.filename + ".pdf"
    ascii_name = filename.encode("ascii", "ignore").decode() or "scan.pdf"

    return StreamingResponse(
        iter([pdf]),
        media_type="application/pdf",
        headers={
            "Content-Disposition": (
                f'attachment; filename="{ascii_name}"; '
                f"filename*=UTF-8''{urllib.parse.quote(filename)}"
            ),
            "Content-Length": str(len(pdf)),
            "X-Scan-Report": urllib.parse.quote(json.dumps(report)),
        },
    )


@app.exception_handler(store.BadId)
def _bad_id_handler(_request: Request, exc: store.BadId) -> JSONResponse:
    return JSONResponse(status_code=400, content={"detail": str(exc)})
