"""Document detection, perspective correction and scanner-style enhancement.

Everything here works on BGR uint8 numpy arrays (OpenCV convention).
Quads are always 4 points in TL, TR, BR, BL order.  Quads that cross the API
boundary are normalised to 0..1 of the image width/height, so the browser can
scale them to whatever size it happens to be rendering at.
"""

from __future__ import annotations

from typing import Optional

import cv2
import numpy as np


# --------------------------------------------------------------------------- #
# geometry helpers
# --------------------------------------------------------------------------- #


def order_quad(pts) -> np.ndarray:
    """Return the 4 points sorted as top-left, top-right, bottom-right, bottom-left.

    Sorting by angle around the centroid, rather than the common sum/difference
    trick, stays correct for strongly rotated pages.
    """
    pts = np.asarray(pts, dtype=np.float32).reshape(4, 2)
    centre = pts.mean(axis=0)
    angles = np.arctan2(pts[:, 1] - centre[1], pts[:, 0] - centre[0])
    pts = pts[np.argsort(angles)]  # clockwise, because image y grows downwards
    start = int(np.argmin(pts.sum(axis=1)))  # corner nearest the origin
    return np.roll(pts, -start, axis=0).astype(np.float32)


def quad_area(pts: np.ndarray) -> float:
    x, y = pts[:, 0], pts[:, 1]
    return 0.5 * abs(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1)))


def _rectangularity(pts: np.ndarray) -> float:
    """1.0 for a perfect rectangle, falling towards 0 as the corners skew."""
    score = 1.0
    for i in range(4):
        a = pts[(i - 1) % 4] - pts[i]
        b = pts[(i + 1) % 4] - pts[i]
        na, nb = float(np.linalg.norm(a)), float(np.linalg.norm(b))
        if na < 1e-6 or nb < 1e-6:
            return 0.0
        cos = abs(float(np.dot(a, b)) / (na * nb))
        score *= max(0.0, 1.0 - cos)  # cos is 0 at exactly 90 degrees
    return score ** 0.25


def _aspect_sanity(pts: np.ndarray) -> float:
    """Reject slivers: pages are rarely thinner than about 1:4."""
    w = max(float(np.linalg.norm(pts[1] - pts[0])), float(np.linalg.norm(pts[2] - pts[3])))
    h = max(float(np.linalg.norm(pts[3] - pts[0])), float(np.linalg.norm(pts[2] - pts[1])))
    if w < 1e-6 or h < 1e-6:
        return 0.0
    ratio = max(w, h) / min(w, h)
    return 1.0 if ratio <= 4.0 else max(0.0, 1.0 - (ratio - 4.0) / 4.0)


# --------------------------------------------------------------------------- #
# detection
# --------------------------------------------------------------------------- #


def _edge_variants(gray: np.ndarray):
    """Yield several binary edge maps; different lighting favours different ones."""
    blur = cv2.GaussianBlur(gray, (5, 5), 0)

    # Closing with a chunky kernel dissolves text and ruling lines, so
    # findContours locks onto the sheet outline instead of the words on it.
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (9, 9))
    flat = cv2.morphologyEx(blur, cv2.MORPH_CLOSE, kernel)

    median = float(np.median(flat))
    for lo_factor, hi_factor in ((0.66, 1.33), (0.33, 1.10)):
        lo = int(max(0, lo_factor * median))
        hi = int(min(255, hi_factor * median))
        edges = cv2.Canny(flat, lo, max(hi, lo + 10))
        yield cv2.dilate(edges, np.ones((3, 3), np.uint8), iterations=1)

    # Otsu catches light paper on a dark desk, where the gradient across the
    # edge is weak but the brightness step is obvious.
    _, otsu = cv2.threshold(flat, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    otsu = cv2.morphologyEx(otsu, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))
    yield cv2.morphologyEx(otsu, cv2.MORPH_GRADIENT, np.ones((3, 3), np.uint8))


FULL_FRAME = np.array([[0.02, 0.02], [0.98, 0.02], [0.98, 0.98], [0.02, 0.98]], dtype=np.float32)


def detect_document(bgr: np.ndarray, work_dim: int = 720) -> tuple[np.ndarray, float]:
    """Find the page outline.

    Returns (quad_normalised, confidence).  When nothing convincing turns up the
    quad falls back to a slightly inset full frame and confidence is 0.
    """
    h, w = bgr.shape[:2]
    scale = work_dim / max(h, w)
    small = cv2.resize(bgr, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA) if scale < 1 else bgr
    sh, sw = small.shape[:2]
    frame_area = float(sh * sw)

    gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
    best_quad: Optional[np.ndarray] = None
    best_score = 0.0

    for edges in _edge_variants(gray):
        contours, _ = cv2.findContours(edges, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
        contours = sorted(contours, key=cv2.contourArea, reverse=True)[:12]

        for contour in contours:
            perimeter = cv2.arcLength(contour, True)
            if perimeter < 0.2 * (sw + sh):
                continue
            for eps in (0.02, 0.04, 0.01):
                approx = cv2.approxPolyDP(contour, eps * perimeter, True)
                if len(approx) != 4 or not cv2.isContourConvex(approx):
                    continue
                quad = order_quad(approx.reshape(4, 2))
                area_ratio = quad_area(quad) / frame_area
                if not 0.10 <= area_ratio <= 0.998:
                    continue
                score = area_ratio * _rectangularity(quad) * _aspect_sanity(quad)
                if score > best_score:
                    best_score, best_quad = score, quad
                break

    if best_quad is None:
        return FULL_FRAME.copy(), 0.0

    normalised = best_quad / np.array([sw, sh], dtype=np.float32)
    return np.clip(normalised, 0.0, 1.0), float(min(1.0, best_score * 1.4))


# --------------------------------------------------------------------------- #
# perspective correction
# --------------------------------------------------------------------------- #


def warp_document(bgr: np.ndarray, quad_norm, long_edge: Optional[int] = None) -> np.ndarray:
    """Flatten the quad into a head-on rectangle.

    The output is never upscaled past the resolution actually present in the
    source; inventing pixels only inflates the PDF.
    """
    h, w = bgr.shape[:2]
    quad = order_quad(np.asarray(quad_norm, dtype=np.float32) * np.array([w, h], dtype=np.float32))
    tl, tr, br, bl = quad

    out_w = int(round(max(float(np.linalg.norm(br - bl)), float(np.linalg.norm(tr - tl)))))
    out_h = int(round(max(float(np.linalg.norm(tr - br)), float(np.linalg.norm(tl - bl)))))
    if out_w < 8 or out_h < 8:
        return bgr.copy()

    if long_edge:
        factor = min(1.0, long_edge / max(out_w, out_h))  # shrink only
        out_w = max(8, int(round(out_w * factor)))
        out_h = max(8, int(round(out_h * factor)))

    dst = np.array(
        [[0, 0], [out_w - 1, 0], [out_w - 1, out_h - 1], [0, out_h - 1]], dtype=np.float32
    )
    matrix = cv2.getPerspectiveTransform(quad, dst)
    return cv2.warpPerspective(
        bgr, matrix, (out_w, out_h), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE
    )


# --------------------------------------------------------------------------- #
# enhancement
# --------------------------------------------------------------------------- #


def _background(channel: np.ndarray, strength: int = 24) -> np.ndarray:
    """Estimate the illumination field: shadows, vignetting and paper tint.

    Computed on a thumbnail.  The field is by definition low frequency, so doing
    the morphology at full resolution would be slow for no visible benefit.
    """
    h, w = channel.shape[:2]
    scale = 320 / max(h, w)
    small = cv2.resize(channel, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA) if scale < 1 else channel

    k = max(3, (max(small.shape[:2]) // strength) | 1)
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k))
    bg = cv2.morphologyEx(small, cv2.MORPH_CLOSE, kernel)  # swallow the dark ink
    bg = cv2.GaussianBlur(bg, (0, 0), max(1.0, k / 3.0))
    return cv2.resize(bg, (w, h), interpolation=cv2.INTER_LINEAR)


def flatten_illumination(bgr: np.ndarray) -> np.ndarray:
    """Divide out the illumination field, which whitens paper and kills shadows."""
    out = np.empty_like(bgr)
    for c in range(bgr.shape[2]):
        bg = np.maximum(_background(bgr[:, :, c]), 1)
        out[:, :, c] = cv2.divide(bgr[:, :, c], bg, scale=255)
    return out


def _stretch(img: np.ndarray, low_pct: float = 1.0, high_pct: float = 99.5) -> np.ndarray:
    """Percentile contrast stretch.  Clipping the tails rather than the absolute
    extremes stops a single dust speck from deciding the black point."""
    # Subsampled: the percentiles of every 4th pixel match the full image to
    # well under one grey level, and it avoids sorting nine million values.
    lo, hi = np.percentile(img[::4, ::4], (low_pct, high_pct))
    if hi - lo < 1e-3:
        return img
    scaled = (img.astype(np.float32) - lo) * (255.0 / (hi - lo))
    return np.clip(scaled, 0, 255).astype(np.uint8)


def _unsharp(img: np.ndarray, amount: float = 0.7, radius: float = 1.2) -> np.ndarray:
    blurred = cv2.GaussianBlur(img, (0, 0), radius)
    return cv2.addWeighted(img, 1 + amount, blurred, -amount, 0)


def sauvola(gray: np.ndarray, k: float = 0.22, r: float = 128.0) -> np.ndarray:
    """Local adaptive threshold.

    Beats a global threshold on unevenly lit paper, and beats plain
    cv2.adaptiveThreshold on faint pencil, because the k*std term scales the
    aggressiveness to the local contrast.
    """
    window = max(15, (max(gray.shape[:2]) // 60) | 1)
    g = gray.astype(np.float32)
    mean = cv2.boxFilter(g, cv2.CV_32F, (window, window), normalize=True, borderType=cv2.BORDER_REPLICATE)
    sq_mean = cv2.boxFilter(g * g, cv2.CV_32F, (window, window), normalize=True, borderType=cv2.BORDER_REPLICATE)
    std = np.sqrt(np.maximum(sq_mean - mean * mean, 0.0))
    threshold = mean * (1.0 + k * ((std / r) - 1.0))
    return np.where(g > threshold, 255, 0).astype(np.uint8)


def enhance(bgr: np.ndarray, mode: str = "color", strength: float = 1.0) -> np.ndarray:
    """Apply the scanner look.

    photo - straighten only, keep the original tones
    color - white paper, saturated ink, sharpened
    gray  - neutral greyscale document
    bw    - 1-bit, the smallest and crispest option for plain text
    """
    if mode == "photo":
        return bgr

    flat = flatten_illumination(bgr)

    if mode == "bw":
        gray = cv2.cvtColor(flat, cv2.COLOR_BGR2GRAY)
        # A light bilateral smooths sensor noise while leaving stroke edges
        # standing.  Non-local means would be cleaner but costs seconds per page
        # at scan resolution, and Sauvola's std term already tolerates noise.
        gray = cv2.bilateralFilter(gray, 5, 45, 45)
        binary = sauvola(gray, k=0.18 + 0.10 * (1.0 - strength))
        binary = cv2.medianBlur(binary, 3)  # drop specks without eating thin strokes
        return cv2.cvtColor(binary, cv2.COLOR_GRAY2BGR)

    if mode == "gray":
        gray = cv2.cvtColor(flat, cv2.COLOR_BGR2GRAY)
        gray = cv2.createCLAHE(clipLimit=1.6, tileGridSize=(8, 8)).apply(gray)
        gray = _stretch(gray)
        gray = cv2.bilateralFilter(gray, 7, 50, 50)  # see note in the colour path
        gray = _unsharp(gray, amount=0.6 * strength)
        return cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)

    # colour
    lab = cv2.cvtColor(flat, cv2.COLOR_BGR2LAB)
    l, a, b = cv2.split(lab)
    l = _stretch(cv2.createCLAHE(clipLimit=1.4, tileGridSize=(8, 8)).apply(l), 0.5, 99.7)
    out = cv2.cvtColor(cv2.merge((l, a, b)), cv2.COLOR_LAB2BGR)

    # Denoise before sharpening.  Unsharp masking amplifies sensor grain as
    # readily as it does real detail, and grain is expensive: on the test page
    # this one filter takes 37% off the encoded size while making the paper look
    # cleaner.  Bilateral rather than a blur, so the letterforms keep their edge.
    out = cv2.bilateralFilter(out, 7, 50, 50)

    # A touch of extra saturation stops flattened ink looking washed out.
    hsv = cv2.cvtColor(out, cv2.COLOR_BGR2HSV).astype(np.float32)
    hsv[:, :, 1] = np.clip(hsv[:, :, 1] * (1.0 + 0.18 * strength), 0, 255)
    out = cv2.cvtColor(hsv.astype(np.uint8), cv2.COLOR_HSV2BGR)

    return _unsharp(out, amount=0.55 * strength)


def rotate(bgr: np.ndarray, degrees: int) -> np.ndarray:
    degrees %= 360
    if degrees == 90:
        return cv2.rotate(bgr, cv2.ROTATE_90_CLOCKWISE)
    if degrees == 180:
        return cv2.rotate(bgr, cv2.ROTATE_180)
    if degrees == 270:
        return cv2.rotate(bgr, cv2.ROTATE_90_COUNTERCLOCKWISE)
    return bgr
