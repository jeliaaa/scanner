"""End-to-end check of the vision pipeline, no camera or browser required.

Synthesises a photograph of a page - text, camera angle, uneven lighting, sensor
noise - then runs detection, de-warping, enhancement and PDF assembly over it
and reports accuracy, timings and output sizes.

    python selftest.py [--keep]

--keep writes the intermediate images next to the script so you can look at them.
"""

from __future__ import annotations

import sys
import time
from pathlib import Path

import cv2
import numpy as np

import cv_utils
import pdf_utils

OUT_DIR = Path(__file__).resolve().parent / ".selftest"


def make_page(width: int = 1240, height: int = 1754) -> np.ndarray:
    """A plausible A4 page: headings, body text, a rule and a table block."""
    page = np.full((height, width, 3), 252, dtype=np.uint8)
    rng = np.random.default_rng(7)

    cv2.putText(page, "QUARTERLY REPORT", (90, 170), cv2.FONT_HERSHEY_DUPLEX, 2.0, (25, 25, 30), 4)
    cv2.line(page, (90, 210), (width - 90, 210), (90, 90, 95), 3)

    y = 300
    for block in range(5):
        for line in range(6):
            length = int(width - 180 - rng.integers(0, 260))
            cv2.putText(page, "-" * 2, (90, y), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1)
            # Body text as filled bars: the detector and the binariser care about
            # ink distribution, not about the glyphs being readable.
            cv2.rectangle(page, (90, y - 14), (length, y), (55, 55, 60), -1)
            y += 34
        y += 40
        if block == 2:
            cv2.rectangle(page, (90, y), (width - 90, y + 220), (120, 120, 125), 2)
            for row in range(1, 5):
                cv2.line(page, (90, y + row * 44), (width - 90, y + row * 44), (150, 150, 155), 1)
            y += 280
    return page


def photograph(page: np.ndarray, canvas: tuple[int, int] = (2000, 1500)) -> tuple[np.ndarray, np.ndarray]:
    """Place the page on a dark desk at an angle, light it badly, add noise."""
    cw, ch = canvas
    rng = np.random.default_rng(3)

    desk = np.full((ch, cw, 3), 62, dtype=np.uint8)
    desk += rng.integers(-12, 12, desk.shape, dtype=np.int16).clip(-60, 60).astype(np.uint8)
    desk = cv2.GaussianBlur(desk, (0, 0), 3)

    h, w = page.shape[:2]
    src = np.array([[0, 0], [w - 1, 0], [w - 1, h - 1], [0, h - 1]], dtype=np.float32)
    dst = np.array([[430, 180], [1610, 300], [1520, 1350], [330, 1210]], dtype=np.float32)

    matrix = cv2.getPerspectiveTransform(src, dst)
    warped = cv2.warpPerspective(page, matrix, (cw, ch), borderValue=(0, 0, 0))
    mask = cv2.warpPerspective(np.full((h, w), 255, np.uint8), matrix, (cw, ch))

    shot = desk.copy()
    shot[mask > 0] = warped[mask > 0]

    # Diagonal falloff plus a soft shadow along one edge - the thing
    # flatten_illumination() has to undo.
    yy, xx = np.mgrid[0:ch, 0:cw].astype(np.float32)
    light = 0.55 + 0.45 * (1.0 - (xx / cw) * 0.8 - (yy / ch) * 0.45)
    light = np.clip(light, 0.35, 1.15)
    shot = np.clip(shot.astype(np.float32) * light[:, :, None], 0, 255).astype(np.uint8)

    shot = np.clip(
        shot.astype(np.int16) + rng.integers(-7, 7, shot.shape, dtype=np.int16), 0, 255
    ).astype(np.uint8)

    truth = dst / np.array([cw, ch], dtype=np.float32)
    return shot, cv_utils.order_quad(truth)


def main() -> int:
    keep = "--keep" in sys.argv
    if keep:
        OUT_DIR.mkdir(exist_ok=True)

    print("building synthetic photograph ...")
    page = make_page()
    shot, truth = photograph(page)
    print(f"  photo {shot.shape[1]}x{shot.shape[0]}")

    started = time.perf_counter()
    quad, confidence = cv_utils.detect_document(shot)
    detect_ms = (time.perf_counter() - started) * 1000

    error_px = float(np.max(np.linalg.norm((quad - truth) * [shot.shape[1], shot.shape[0]], axis=1)))
    print(f"\ndetect: {detect_ms:.0f} ms  confidence {confidence:.2f}  worst corner off by {error_px:.1f} px")

    failures = []
    if confidence <= 0:
        failures.append("detector fell back to the full frame")
    if error_px > 25:
        failures.append(f"corner error {error_px:.1f} px exceeds 25 px")

    if keep:
        marked = shot.copy()
        pts = (quad * [shot.shape[1], shot.shape[0]]).astype(np.int32)
        cv2.polylines(marked, [pts], True, (0, 230, 120), 4)
        for i, point in enumerate(pts):
            cv2.circle(marked, tuple(point), 12, (0, 140, 255), -1)
            cv2.putText(marked, "TL TR BR BL".split()[i], tuple(point + 18),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 140, 255), 2)
        cv2.imwrite(str(OUT_DIR / "01-detected.jpg"), marked)

    warped = cv_utils.warp_document(shot, quad, long_edge=2339)  # 200 dpi A4
    print(f"warp:   {warped.shape[1]}x{warped.shape[0]}")

    rendered = {}
    print("\nenhance:")
    for mode in ("photo", "color", "gray", "bw"):
        started = time.perf_counter()
        result = cv_utils.enhance(warped, mode=mode)
        elapsed = (time.perf_counter() - started) * 1000
        rendered[mode] = result

        encoded = pdf_utils.encode_page(result, quality=80)
        print(f"  {mode:6s} {elapsed:6.0f} ms   page as {encoded.codec:4s} = {len(encoded.data) / 1024:7.1f} kB")
        if keep:
            cv2.imwrite(str(OUT_DIR / f"02-{mode}.jpg"), result)

    if rendered["bw"] is not None and not cv_utils._background(  # noqa: SLF001 - smoke check
        cv2.cvtColor(rendered["bw"], cv2.COLOR_BGR2GRAY)
    ).any():
        failures.append("bw output is empty")

    ink = float(np.mean(cv2.cvtColor(rendered["bw"], cv2.COLOR_BGR2GRAY) < 128))
    print(f"\nbw ink coverage: {ink * 100:.1f}%  (a text page should land roughly 3-25%)")
    if not 0.01 < ink < 0.35:
        failures.append(f"bw ink coverage {ink * 100:.1f}% looks wrong")

    print("\npdf:")
    for mode in ("color", "gray", "bw"):
        pages = [rendered[mode]] * 3
        started = time.perf_counter()
        pdf, report = pdf_utils.build_pdf_under_size(
            pages, quality=80, page_size="a4", dpi=200, title="selftest", max_bytes=None
        )
        elapsed = (time.perf_counter() - started) * 1000
        per_page = len(pdf) / 3 / 1024
        print(f"  {mode:6s} 3 pages {elapsed:6.0f} ms  {len(pdf) / 1024:8.1f} kB total  {per_page:6.1f} kB/page")
        if not pdf.startswith(b"%PDF-"):
            failures.append(f"{mode}: output is not a PDF")
        if keep:
            (OUT_DIR / f"03-{mode}.pdf").write_bytes(pdf)

    print()
    print("size cap:")
    pages = [rendered["color"]] * 4
    pdf, report = pdf_utils.build_pdf_under_size(
        pages, quality=92, page_size="a4", dpi=200, title="capped", max_bytes=400 * 1024
    )
    print(
        f"  asked for <=400 kB, got {len(pdf) / 1024:.1f} kB "
        f"at quality {report['quality']} scale {report['scale']} after "
        f"{report['attempts']} attempt(s) and {report['probes']} probe(s), "
        f"met_target={report['met_target']}"
    )
    if not report["met_target"]:
        failures.append("size cap not met")

    # Regression guard. A document page is naturally >90% pure black and pure
    # white, so any "does this look binary" test applied *after* downscaling
    # also matches ordinary colour scans, and silently flattens them to 1-bit.
    # Downscaling a colour page must leave its mid-tones intact.
    colour = rendered["color"]
    was_binary = pdf_utils._looks_binary(colour)
    shrunk = pdf_utils._prepare(colour, 0.8, was_binary)
    midtones = float(np.mean((shrunk > 60) & (shrunk < 200)))
    print(f"  colour page at 80% scale keeps {midtones * 100:.1f}% mid-tone pixels")
    if was_binary:
        failures.append("a colour page was classified as 1-bit")
    if midtones < 0.005:
        failures.append("downscaling flattened a colour page to 1-bit")

    sizes = [
        len(pdf_utils.encode_page(pdf_utils._prepare(colour, s, was_binary), quality=92).data)
        for s in (1.0, 0.8, 0.5)
    ]
    print("  colour down the scale ladder: " + " -> ".join(f"{n / 1024:.0f} kB" for n in sizes))
    if sizes != sorted(sizes, reverse=True):
        failures.append(f"scale ladder is not monotonic: {sizes}")

    print()
    if failures:
        print("FAILED")
        for failure in failures:
            print(f"  - {failure}")
        return 1

    print("OK - detection, de-warping, enhancement, compression and PDF assembly all pass")
    if keep:
        print(f"images written to {OUT_DIR}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
