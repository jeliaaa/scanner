"use client";

import * as React from "react";
import { originalUrl, previewPage, redetectPage, settingsPayload } from "@/lib/api";
import { FULL_FRAME, clamp01, contentRect, isConvex, quadToPixels } from "@/lib/geometry";
import { useDebounced, useElementSize } from "@/lib/hooks";
import type { Page, Point, Quad, Settings } from "@/lib/types";
import { QuadOverlay } from "./QuadOverlay";
import { Button, IconAlert, IconCheck, IconCrop, IconRefresh, IconRotate, IconTrash, IconWand } from "./ui";

const LOUPE_PX = 132;
const LOUPE_ZOOM = 3;

interface Props {
  page: Page;
  sessionId: string;
  settings: Settings;
  index: number;
  total: number;
  onChange: (patch: Partial<Page>) => void;
  onDelete: () => void;
  onDone: () => void;
}

type Drag =
  | { kind: "corner"; index: number }
  | { kind: "edge"; index: number; start: Point; a: Point; b: Point }
  | null;

export function PageEditor({ page, sessionId, settings, index, total, onChange, onDelete, onDone }: Props) {
  const [tab, setTab] = React.useState<"adjust" | "result">("adjust");
  const [draft, setDraft] = React.useState<Quad>(page.quad);
  const [drag, setDrag] = React.useState<Drag>(null);
  const [pointer, setPointer] = React.useState<Point | null>(null);
  const [natural, setNatural] = React.useState({ w: page.width, h: page.height });

  const [boxRef, box] = useElementSize<HTMLDivElement>();
  const src = originalUrl(sessionId, page.id);

  const rect = contentRect(box.w, box.h, natural.w, natural.h);
  const pixels = quadToPixels(draft, rect);

  /* --------------------------------- dragging -------------------------------- */

  const pointFromEvent = React.useCallback(
    (event: React.PointerEvent | PointerEvent): Point => {
      const host = boxRef.current;
      if (!host) return [0, 0];
      const bounds = host.getBoundingClientRect();
      return [
        clamp01((event.clientX - bounds.left - rect.x) / rect.w),
        clamp01((event.clientY - bounds.top - rect.y) / rect.h),
      ];
    },
    [boxRef, rect.x, rect.y, rect.w, rect.h]
  );

  const commit = React.useCallback(
    (next: Quad) => {
      // Dragging a corner past its neighbours makes a bowtie, which warps into
      // garbage. Reject the move rather than let the shape self-intersect.
      if (!isConvex(next)) return;
      setDraft(next);
    },
    []
  );

  const onPointerMove = React.useCallback(
    (event: React.PointerEvent) => {
      if (!drag) return;
      const p = pointFromEvent(event);
      setPointer(p);

      if (drag.kind === "corner") {
        const next = [...draft] as Quad;
        next[drag.index] = p;
        commit(next);
        return;
      }

      // Edge drag: slide the whole edge along its own normal, which is what you
      // want when one side of the page is slightly off but its angle is right.
      const [ax, ay] = drag.a;
      const [bx, by] = drag.b;
      const ex = bx - ax;
      const ey = by - ay;
      const length = Math.hypot(ex, ey) || 1;
      const nx = -ey / length;
      const ny = ex / length;
      const shift = (p[0] - drag.start[0]) * nx + (p[1] - drag.start[1]) * ny;

      const next = [...draft] as Quad;
      next[drag.index] = [clamp01(ax + nx * shift), clamp01(ay + ny * shift)];
      next[(drag.index + 1) % 4] = [clamp01(bx + nx * shift), clamp01(by + ny * shift)];
      commit(next);
    },
    [drag, draft, pointFromEvent, commit]
  );

  const endDrag = React.useCallback(() => {
    if (!drag) return;
    setDrag(null);
    setPointer(null);
    onChange({ quad: draft });
  }, [drag, draft, onChange]);

  /* --------------------------------- actions -------------------------------- */

  const [working, setWorking] = React.useState(false);

  const redetect = async () => {
    setWorking(true);
    try {
      const result = await redetectPage(sessionId, page.id);
      setDraft(result.quad);
      onChange({ quad: result.quad, confidence: result.confidence });
    } catch {
      /* leave the current quad alone if the service is unreachable */
    } finally {
      setWorking(false);
    }
  };

  const selectAll = () => {
    setDraft(FULL_FRAME);
    onChange({ quad: FULL_FRAME });
  };

  /* --------------------------------- preview -------------------------------- */

  const previewKey = useDebounced(
    JSON.stringify([page.quad, page.rotate, page.mode ?? settings.mode, settings.strength]),
    260
  );
  const [preview, setPreview] = React.useState<{ url: string; key: string } | null>(null);
  const [failedKey, setFailedKey] = React.useState<string | null>(null);

  // Derived rather than stored: a "loading" flag set inside the effect would
  // cascade an extra render, and it can go stale if a request is superseded.
  const stale = preview?.key !== previewKey;
  const previewError = failedKey === previewKey;
  const previewLoading = tab === "result" && stale && !previewError;

  // Holds whatever URL is currently on screen, so unmount can release it
  // without the effect revoking a URL that is still being displayed.
  const liveUrl = React.useRef<string | null>(null);
  React.useEffect(
    () => () => {
      if (liveUrl.current) URL.revokeObjectURL(liveUrl.current);
    },
    []
  );

  React.useEffect(() => {
    if (tab !== "result" || !stale) return;
    const controller = new AbortController();

    previewPage(
      sessionId,
      page.id,
      {
        quad: page.quad,
        rotate: page.rotate,
        settings: { ...settingsPayload(settings), mode: page.mode ?? settings.mode },
      },
      controller.signal
    )
      .then((url) => {
        // Release the superseded image only once its replacement has arrived.
        if (liveUrl.current) URL.revokeObjectURL(liveUrl.current);
        liveUrl.current = url;
        setPreview({ url, key: previewKey });
      })
      .catch((err: Error) => {
        if (err.name !== "AbortError") setFailedKey(previewKey);
      });

    return () => controller.abort();
    // previewKey folds in every input the render depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, sessionId, page.id, previewKey, stale]);

  /* ---------------------------------- render -------------------------------- */

  const weak = page.confidence < 0.25;

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-lg bg-ink-850 p-0.5">
          {(["adjust", "result"] as const).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setTab(value)}
              className={`rounded-[6px] px-3 py-1.5 text-xs font-medium transition-colors ${
                tab === value ? "bg-ink-600 text-text" : "text-mute hover:text-text"
              }`}
            >
              {value === "adjust" ? "Adjust edges" : "Result"}
            </button>
          ))}
        </div>

        <span className="text-xs text-mute">
          Page {index + 1} of {total}
        </span>

        <div className="flex-1" />

        <Button variant="outline" onClick={() => onChange({ rotate: (page.rotate + 270) % 360 })} title="Rotate left">
          <IconRotate />
        </Button>
        <Button
          variant="outline"
          onClick={() => onChange({ rotate: (page.rotate + 90) % 360 })}
          title="Rotate right"
          className="[&>svg]:-scale-x-100"
        >
          <IconRotate />
        </Button>
        <Button variant="outline" onClick={() => void redetect()} disabled={working} title="Detect the edges again">
          <IconRefresh /> Re-detect
        </Button>
        <Button variant="outline" onClick={selectAll} title="Use the whole photo">
          <IconCrop /> Whole photo
        </Button>
        <Button variant="danger" onClick={onDelete} title="Discard this page">
          <IconTrash />
        </Button>
      </div>

      <div
        ref={boxRef}
        className="relative flex-1 touch-none overflow-hidden rounded-xl bg-ink-900 ring-1 ring-ink-700"
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        {tab === "adjust" ? (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={src}
              alt={`Page ${index + 1}`}
              draggable={false}
              onLoad={(event) => {
                const img = event.currentTarget;
                setNatural({ w: img.naturalWidth, h: img.naturalHeight });
              }}
              className="h-full w-full select-none object-contain"
            />

            {rect.w > 0 && (
              <>
                <QuadOverlay quad={pixels} width={box.w} height={box.h} />

                {/* Edge handles sit at the midpoints, below the corners in the
                    stack so a corner always wins an overlapping grab. */}
                {pixels.map((corner, i) => {
                  const next = pixels[(i + 1) % 4];
                  const mid: Point = [(corner[0] + next[0]) / 2, (corner[1] + next[1]) / 2];
                  return (
                    <button
                      key={`edge-${i}`}
                      type="button"
                      aria-label={`Move edge ${i + 1}`}
                      onPointerDown={(event) => {
                        event.currentTarget.setPointerCapture(event.pointerId);
                        setDrag({
                          kind: "edge",
                          index: i,
                          start: pointFromEvent(event),
                          a: draft[i],
                          b: draft[(i + 1) % 4],
                        });
                      }}
                      style={{ left: mid[0], top: mid[1] }}
                      className="absolute z-10 h-7 w-7 -translate-x-1/2 -translate-y-1/2 cursor-grab touch-none
                        rounded-full border-2 border-scan-500/70 bg-ink-950/60 backdrop-blur-sm
                        transition-transform hover:scale-110 active:cursor-grabbing"
                    />
                  );
                })}

                {pixels.map((corner, i) => (
                  <button
                    key={`corner-${i}`}
                    type="button"
                    aria-label={`Move corner ${i + 1}`}
                    onPointerDown={(event) => {
                      event.currentTarget.setPointerCapture(event.pointerId);
                      setDrag({ kind: "corner", index: i });
                      setPointer(draft[i]);
                    }}
                    style={{ left: corner[0], top: corner[1] }}
                    className="absolute z-20 h-9 w-9 -translate-x-1/2 -translate-y-1/2 cursor-grab touch-none
                      rounded-full border-2 border-scan-500 bg-scan-500/25 backdrop-blur-sm
                      transition-transform hover:scale-110 active:cursor-grabbing"
                  />
                ))}
              </>
            )}

            {drag && pointer && <Loupe src={src} point={pointer} rect={rect} />}

            {weak && !drag && (
              <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center p-3">
                <span className="flex items-center gap-2 rounded-full bg-ink-950/80 px-3 py-1.5 text-xs text-warn-500 backdrop-blur-sm">
                  <IconAlert /> Edges were unclear — drag the corners onto the page
                </span>
              </div>
            )}
          </>
        ) : (
          <div className="relative h-full w-full p-3">
            {preview && (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img
                src={preview.url}
                alt={`Processed page ${index + 1}`}
                className="mx-auto h-full w-auto max-w-full rounded-md object-contain shadow-2xl shadow-black/60"
              />
            )}
            {previewLoading && (
              <div className="absolute inset-0 grid place-items-center">
                <div className="relative h-12 w-12 overflow-hidden rounded-md ring-1 ring-ink-600">
                  <div className="scan-sweep absolute inset-x-0 h-1/3 bg-scan-500/60" />
                </div>
              </div>
            )}
            {previewError && !preview && (
              <div className="absolute inset-0 grid place-items-center">
                <p className="text-sm text-mute">The preview could not be rendered.</p>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="flex items-center gap-2">
        <p className="text-xs text-mute">
          {tab === "adjust"
            ? "Drag the corners, or an edge, to match the page."
            : "This is exactly how the page will look in the PDF."}
        </p>
        <div className="flex-1" />
        <Button variant="ghost" onClick={() => setTab(tab === "adjust" ? "result" : "adjust")}>
          <IconWand /> {tab === "adjust" ? "See result" : "Back to edges"}
        </Button>
        <Button variant="primary" onClick={onDone}>
          <IconCheck /> Done
        </Button>
      </div>
    </div>
  );
}

/**
 * Magnifier that follows the dragged corner.
 *
 * A fingertip or cursor covers exactly the pixels you are trying to line up on,
 * so the loupe re-renders that neighbourhood offset from the pointer where it
 * can actually be seen.
 */
function Loupe({ src, point, rect }: { src: string; point: Point; rect: { x: number; y: number; w: number; h: number } }) {
  const x = rect.x + point[0] * rect.w;
  const y = rect.y + point[1] * rect.h;

  // Flip to the opposite side near the edges so the loupe stays on screen.
  const left = x + (point[0] > 0.75 ? -LOUPE_PX - 24 : 24);
  const top = y + (point[1] < 0.25 ? 24 : -LOUPE_PX - 24);

  return (
    <div
      className="pointer-events-none absolute z-30 overflow-hidden rounded-full border-2 border-scan-500
        shadow-2xl shadow-black/70"
      style={{
        left,
        top,
        width: LOUPE_PX,
        height: LOUPE_PX,
        backgroundImage: `url(${src})`,
        backgroundRepeat: "no-repeat",
        backgroundSize: `${rect.w * LOUPE_ZOOM}px ${rect.h * LOUPE_ZOOM}px`,
        backgroundPosition: `${LOUPE_PX / 2 - point[0] * rect.w * LOUPE_ZOOM}px ${
          LOUPE_PX / 2 - point[1] * rect.h * LOUPE_ZOOM
        }px`,
      }}
    >
      <div className="absolute left-1/2 top-0 h-full w-px -translate-x-1/2 bg-scan-500/70" />
      <div className="absolute left-0 top-1/2 h-px w-full -translate-y-1/2 bg-scan-500/70" />
    </div>
  );
}
