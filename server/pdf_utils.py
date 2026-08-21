"""Turn processed page images into one compact PDF.

The size wins come from choosing the right codec per page rather than from
squeezing JPEG quality alone:

  * 1-bit pages go in as CCITT Group 4, the fax codec.  A text page lands around
    30-60 kB instead of the ~250 kB the same page costs as a JPEG, and it stays
    lossless, so the glyph edges keep their bite.
  * Everything else goes in as JPEG, embedded by img2pdf without re-encoding, so
    the bytes we measured are exactly the bytes in the file.
"""

from __future__ import annotations

import io
from dataclasses import dataclass
from typing import Iterable, Optional

import cv2
import img2pdf
import numpy as np
from PIL import Image


PAGE_SIZES_MM = {
    "a4": (210.0, 297.0),
    "letter": (215.9, 279.4),
    "legal": (215.9, 355.6),
}


@dataclass
class EncodedPage:
    data: bytes
    width: int
    height: int
    codec: str  # "jpeg" or "g4"


def encode_page(bgr: np.ndarray, quality: int = 80, force_jpeg: bool = False) -> EncodedPage:
    """Compress a single page, picking the codec that suits its content."""
    height, width = bgr.shape[:2]

    if not force_jpeg and _looks_binary(bgr):
        try:
            return EncodedPage(_encode_group4(bgr), width, height, "g4")
        except Exception:
            pass  # Pillow build without G4 support - fall through to JPEG

    # A neutral page carries three identical channels.  Handing cv2 a single
    # channel emits a DeviceGray JPEG instead of DeviceRGB and takes about a
    # third off the page for free, with no change to what it looks like.
    payload = bgr
    codec = "jpeg"
    if _is_neutral(bgr):
        payload = bgr[:, :, 0]
        codec = "jpeg-gray"

    ok, buffer = cv2.imencode(
        ".jpg",
        payload,
        [
            int(cv2.IMWRITE_JPEG_QUALITY), int(quality),
            int(cv2.IMWRITE_JPEG_OPTIMIZE), 1,
            int(cv2.IMWRITE_JPEG_PROGRESSIVE), 0,  # img2pdf rejects progressive JPEG
        ],
    )
    if not ok:
        raise RuntimeError("JPEG encoding failed")
    return EncodedPage(buffer.tobytes(), width, height, codec)


def _is_neutral(bgr: np.ndarray) -> bool:
    """True when every pixel is grey, so the colour channels are redundant.

    Checked over the whole array rather than a sample: a subsample could miss a
    small patch of coloured ink and silently discard it.
    """
    if bgr.ndim != 3 or bgr.shape[2] != 3:
        return True
    return bool(
        np.array_equal(bgr[:, :, 0], bgr[:, :, 1]) and np.array_equal(bgr[:, :, 1], bgr[:, :, 2])
    )


def _looks_binary(bgr: np.ndarray) -> bool:
    sample = bgr[::4, ::4]
    if sample.ndim == 3 and sample.shape[2] == 3:
        # Grey (all channels equal) is a precondition for being 1-bit.
        if not np.array_equal(sample[:, :, 0], sample[:, :, 1]):
            return False
        sample = sample[:, :, 0]
    return bool(np.all((sample == 0) | (sample == 255)))


def _encode_group4(bgr: np.ndarray) -> bytes:
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY) if bgr.ndim == 3 else bgr
    image = Image.fromarray(gray).convert("1", dither=Image.Dither.NONE)
    buffer = io.BytesIO()
    image.save(buffer, format="TIFF", compression="group4")
    return buffer.getvalue()


def _layout_fun(page_size: str, dpi: int):
    """Map pixels to a physical page.

    "auto" derives the page size from the pixel count at the chosen DPI, which
    keeps the aspect ratio of whatever was actually scanned.  A named size fits
    the image inside a standard sheet instead, which is what you want if the
    PDF is going to be printed.
    """
    if page_size == "auto":
        return img2pdf.get_fixed_dpi_layout_fun((dpi, dpi))

    width_mm, height_mm = PAGE_SIZES_MM[page_size]
    return img2pdf.get_layout_fun(
        pagesize=(img2pdf.mm_to_pt(width_mm), img2pdf.mm_to_pt(height_mm)),
        fit=img2pdf.FitMode.into,
        auto_orient=True,
    )


def build_pdf(
    pages: Iterable[EncodedPage],
    page_size: str = "auto",
    dpi: int = 200,
    title: Optional[str] = None,
) -> bytes:
    payloads = [page.data for page in pages]
    if not payloads:
        raise ValueError("no pages to write")

    kwargs = {"layout_fun": _layout_fun(page_size, dpi)}
    if title:
        kwargs["title"] = title

    return img2pdf.convert(payloads, **kwargs)

# Quality is spent before resolution: JPEG quality mostly discards invisible
# noise, while dropping resolution throws away detail that cannot come back.
_QUALITY_LADDER = (70, 60, 50, 40)
_SCALE_LADDER = (1.0, 0.8, 0.65, 0.5)


def _rungs(quality: int) -> list[tuple[int, float]]:
    """Settings to try, worst-loss last, with duplicates removed."""
    out: list[tuple[int, float]] = []
    for scale in _SCALE_LADDER:
        for q in (quality, *_QUALITY_LADDER):
            if q <= quality and (q, scale) not in out:
                out.append((q, scale))
    return out


def _prepare(image: np.ndarray, scale: float, was_binary: bool) -> np.ndarray:
    """Downscale a page, restoring 1-bit pages to 1-bit afterwards.

    Whether the page is binary is decided by the caller from the *original*
    image, never guessed from the resized one. A document page is naturally
    >90% pure white and pure black, so any "does this look binary" test applied
    after resizing also matches ordinary colour and greyscale scans and would
    silently flatten them to 1-bit.
    """
    if scale >= 1.0:
        return image
    resized = cv2.resize(image, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
    # Resampling a 1-bit page yields grey edges; re-threshold so it can still
    # take the cheap Group 4 path.
    return _rebinarise(resized) if was_binary else resized


def build_pdf_under_size(
    images: list[np.ndarray],
    quality: int,
    page_size: str,
    dpi: int,
    title: Optional[str],
    max_bytes: Optional[int] = None,
) -> tuple[bytes, dict]:
    """Build the PDF, walking quality and resolution down until it fits.

    Returns the PDF bytes plus a report of what it cost, so the UI can tell the
    user that their 2 MB cap meant dropping to 55% quality.

    When a cap is set, the ladder is first searched by encoding a single
    representative page rather than the whole document at every rung: that turns
    the search from pages x rungs encodes into rungs + pages, which is the
    difference between a snappy export and a minute of waiting on a long scan.
    The chosen rung is then verified against the real PDF, and the walk
    continues from there if the estimate was optimistic.
    """
    rungs = _rungs(quality)
    probes = 0
    binary_flags = [_looks_binary(image) for image in images]

    if max_bytes and len(images) > 1:
        # Every page carries a little dictionary and stream overhead on top of
        # its pixels; leaving room for it stops the probe overshooting.
        overhead = 1200 + 400 * len(images)
        budget = max(2048.0, (max_bytes - overhead) / len(images))
        heaviest_index = max(range(len(images)), key=lambda i: images[i].shape[0] * images[i].shape[1])
        heaviest = images[heaviest_index]
        heaviest_binary = binary_flags[heaviest_index]

        for index, (q, scale) in enumerate(rungs):
            probes += 1
            if len(encode_page(_prepare(heaviest, scale, heaviest_binary), quality=q).data) <= budget:
                rungs = rungs[index:]
                break
        else:
            rungs = rungs[-1:]

    attempts = 0
    pdf = b""
    used_quality, used_scale = rungs[0]

    for used_quality, used_scale in rungs:
        staged = [
            encode_page(_prepare(image, used_scale, is_binary), quality=used_quality)
            for image, is_binary in zip(images, binary_flags)
        ]
        pdf = build_pdf(staged, page_size=page_size, dpi=round(dpi * used_scale), title=title)
        attempts += 1
        if not max_bytes or len(pdf) <= max_bytes:
            break

    report = {
        "bytes": len(pdf),
        "quality": used_quality,
        "scale": used_scale,
        "attempts": attempts,
        "probes": probes,
        "met_target": (not max_bytes) or len(pdf) <= max_bytes,
    }
    return pdf, report


def _rebinarise(bgr: np.ndarray) -> np.ndarray:
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY) if bgr.ndim == 3 else bgr
    _, binary = cv2.threshold(gray, 127, 255, cv2.THRESH_BINARY)
    return cv2.cvtColor(binary, cv2.COLOR_GRAY2BGR)
