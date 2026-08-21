"use client";

import * as React from "react";
import type { Quad } from "@/lib/types";

interface Props {
  /** Corners in pixel coordinates relative to the container. */
  quad: Quad;
  width: number;
  height: number;
  color?: string;
  /** Darken everything outside the outline, like a viewfinder mask. */
  dim?: boolean;
  className?: string;
  children?: React.ReactNode;
}

/**
 * The page outline: a dimming mask, the border itself, and L-shaped corner
 * ticks aligned to the edges they sit on.
 *
 * Corner ticks rather than dots because they say which way the edges run, which
 * is what tells you at a glance that the detector has the page square and not,
 * say, a book's inner margin.
 */
export function QuadOverlay({
  quad,
  width,
  height,
  color = "var(--color-scan-500)",
  dim = true,
  className = "",
  children,
}: Props) {
  if (!width || !height) return null;

  const points = quad.map(([x, y]) => `${x},${y}`).join(" ");
  const outerPath = `M0,0 H${width} V${height} H0 Z`;
  const innerPath = `M${quad.map(([x, y]) => `${x},${y}`).join(" L")} Z`;

  return (
    <svg
      className={`pointer-events-none absolute inset-0 ${className}`}
      width={width}
      height={height}
      aria-hidden="true"
    >
      {dim && (
        <path d={`${outerPath} ${innerPath}`} fillRule="evenodd" fill="rgb(4 6 9 / 0.55)" />
      )}

      <polygon
        points={points}
        fill={color}
        fillOpacity={0.08}
        stroke={color}
        strokeWidth={2}
        strokeLinejoin="round"
      />

      {quad.map((corner, i) => (
        <CornerTick
          key={i}
          corner={corner}
          prev={quad[(i + 3) % 4]}
          next={quad[(i + 1) % 4]}
          color={color}
        />
      ))}

      {children}
    </svg>
  );
}

function CornerTick({
  corner,
  prev,
  next,
  color,
}: {
  corner: [number, number];
  prev: [number, number];
  next: [number, number];
  color: string;
}) {
  const arm = (target: [number, number]) => {
    const dx = target[0] - corner[0];
    const dy = target[1] - corner[1];
    const len = Math.hypot(dx, dy) || 1;
    // A quarter of the edge, capped, so ticks stay proportional on small
    // previews without swallowing short edges entirely.
    const reach = Math.min(26, len * 0.25);
    return [corner[0] + (dx / len) * reach, corner[1] + (dy / len) * reach];
  };

  const [ax, ay] = arm(prev);
  const [bx, by] = arm(next);

  return (
    <path
      d={`M${ax},${ay} L${corner[0]},${corner[1]} L${bx},${by}`}
      fill="none"
      stroke={color}
      strokeWidth={4}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  );
}
