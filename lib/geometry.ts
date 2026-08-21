import type { Point, Quad } from "./types";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Where the media actually sits inside its box under `object-fit: contain`.
 *
 * The element and the video/image rarely share an aspect ratio, so the picture
 * is letterboxed. Overlay maths has to run against the content rect, not the
 * element rect, or the outline drifts off the page.
 */
export function contentRect(elW: number, elH: number, mediaW: number, mediaH: number): Rect {
  if (!mediaW || !mediaH || !elW || !elH) return { x: 0, y: 0, w: elW, h: elH };
  const scale = Math.min(elW / mediaW, elH / mediaH);
  const w = mediaW * scale;
  const h = mediaH * scale;
  return { x: (elW - w) / 2, y: (elH - h) / 2, w, h };
}

export const toPixel = (p: Point, r: Rect): Point => [r.x + p[0] * r.w, r.y + p[1] * r.h];

export const toNorm = (p: Point, r: Rect): Point => [
  clamp01((p[0] - r.x) / r.w),
  clamp01((p[1] - r.y) / r.h),
];

export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

export const quadToPixels = (q: Quad, r: Rect): Quad =>
  q.map((p) => toPixel(p, r)) as Quad;

export const FULL_FRAME: Quad = [
  [0.02, 0.02],
  [0.98, 0.02],
  [0.98, 0.98],
  [0.02, 0.98],
];

/**
 * Reject self-intersecting quads.
 *
 * Dragging one corner past its neighbours produces a bowtie, which warps into
 * garbage. Checking that every cross product shares a sign catches it before
 * the shape is committed.
 */
export function isConvex(q: Quad): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = q[i];
    const [bx, by] = q[(i + 1) % 4];
    const [cx, cy] = q[(i + 2) % 4];
    const cross = (bx - ax) * (cy - by) - (by - ay) * (cx - bx);
    if (Math.abs(cross) < 1e-9) continue;
    const s = Math.sign(cross);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

/**
 * Exponentially smooth the live outline so it glides instead of twitching.
 *
 * A large jump means the camera moved to a different page, so the smoothing is
 * skipped and the outline snaps: easing across that would look like lag.
 */
export function smoothQuad(prev: Quad | null, next: Quad, alpha = 0.4): Quad {
  if (!prev) return next;
  const jump = Math.max(
    ...next.map((p, i) => Math.hypot(p[0] - prev[i][0], p[1] - prev[i][1]))
  );
  if (jump > 0.18) return next;
  return next.map((p, i) => [
    prev[i][0] + (p[0] - prev[i][0]) * alpha,
    prev[i][1] + (p[1] - prev[i][1]) * alpha,
  ]) as Quad;
}
