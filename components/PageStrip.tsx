"use client";

import * as React from "react";
import { thumbUrl } from "@/lib/api";
import type { Page } from "@/lib/types";
import { IconChevronLeft, IconChevronRight, IconLayers, IconPlus, IconTrash } from "./ui";

interface Props {
  pages: Page[];
  sessionId: string;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onMove: (id: string, delta: number) => void;
  /** Phone only: a trailing "+" tile that returns to the camera. */
  onAdd?: () => void;
}

export function PageStrip({ pages, sessionId, selectedId, onSelect, onDelete, onMove, onAdd }: Props) {
  if (!pages.length) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed
        border-ink-600 px-4 py-10 text-center">
        <IconLayers className="text-xl text-ink-500" />
        <p className="text-sm text-mute">No pages yet</p>
        <p className="text-xs text-mute/70">Capture or import to begin</p>
      </div>
    );
  }

  return (
    <ol
      className="hide-scrollbar flex snap-x gap-2.5 overflow-x-auto px-0.5 py-1 lg:grid lg:grid-cols-2 lg:gap-2
        lg:overflow-visible lg:p-0"
    >
      {pages.map((page, index) => {
        const active = page.id === selectedId;
        return (
          <li key={page.id} className="group relative shrink-0 snap-start lg:shrink">
            <button
              type="button"
              aria-label={`Open page ${index + 1}`}
              aria-current={active}
              onClick={() => onSelect(page.id)}
              className={`block w-14 overflow-hidden rounded-lg ring-2 transition-all sm:w-20 lg:w-full ${
                active ? "ring-scan-500" : "ring-ink-700 hover:ring-ink-500"
              }`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={thumbUrl(sessionId, page.id)}
                alt={`Page ${index + 1}`}
                className="aspect-[3/4] w-full bg-ink-900 object-cover"
              />
            </button>

            <span
              className={`pointer-events-none absolute left-1.5 top-1.5 grid h-5 min-w-5 place-items-center
                rounded px-1 text-[11px] font-semibold tabular-nums ${
                  active ? "bg-scan-500 text-ink-950" : "bg-ink-950/80 text-mute"
                }`}
            >
              {index + 1}
            </span>

            {page.confidence < 0.25 && (
              <span
                title="The edges were unclear on this page"
                className="pointer-events-none absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-warn-500
                  ring-2 ring-ink-950/80"
              />
            )}

            {/* Reordering and deletion appear on hover or focus, on the roomy
                desktop rail only. On a phone these 24px buttons sat edge to
                edge with Delete beside the arrows, so a slightly-off tap threw
                a page away. The phone gets the same actions, full size, in the
                editor's toolbar and top bar instead. */}
            <div
              className="absolute inset-x-0 bottom-0 hidden items-center justify-center gap-0.5 bg-gradient-to-t
                from-ink-950 to-transparent p-1 opacity-0 transition-opacity group-hover:opacity-100
                group-focus-within:opacity-100 lg:flex"
            >
              <IconButton
                label="Move earlier"
                disabled={index === 0}
                onClick={() => onMove(page.id, -1)}
              >
                <IconChevronLeft />
              </IconButton>
              <IconButton
                label="Move later"
                disabled={index === pages.length - 1}
                onClick={() => onMove(page.id, 1)}
              >
                <IconChevronRight />
              </IconButton>
              <IconButton label="Delete page" onClick={() => onDelete(page.id)} danger>
                <IconTrash />
              </IconButton>
            </div>
          </li>
        );
      })}

      {onAdd && (
        <li className="shrink-0 snap-start lg:hidden">
          <button
            type="button"
            onClick={onAdd}
            aria-label="Add another page"
            className="grid aspect-[3/4] w-14 place-items-center rounded-lg border-2 border-dashed border-ink-500
              text-xl text-mute transition-colors active:scale-95 active:border-scan-500 active:text-scan-400
              sm:w-20 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2
              focus-visible:outline-scan-500"
          >
            <IconPlus />
          </button>
        </li>
      )}
    </ol>
  );
}

function IconButton({
  label,
  onClick,
  children,
  disabled,
  danger,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={`grid h-7 w-7 place-items-center rounded text-xs transition-colors disabled:opacity-30 sm:h-6 sm:w-6
        ${danger ? "text-bad-500 hover:bg-bad-500/20" : "text-text hover:bg-ink-600"}`}
    >
      {children}
    </button>
  );
}
