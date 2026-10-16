"use client";

import * as React from "react";
import { IconX } from "./ui";

interface Props {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}

/**
 * Phone bottom sheet: a modal that rises from the thumb's side of the screen.
 * Hidden at desktop widths, where the same content sits in the side rail.
 */
export function Sheet({ title, onClose, children }: Props) {
  // Escape closes it, as it does any other dialog.
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label={title}>
      <button
        type="button"
        aria-label={`Close ${title.toLowerCase()}`}
        onClick={onClose}
        className="absolute inset-0 bg-ink-950/70 backdrop-blur-sm"
      />
      <div
        className="absolute inset-x-0 bottom-0 flex max-h-[92dvh] flex-col rounded-t-3xl border-t border-ink-700
          bg-ink-900 shadow-2xl shadow-black/60"
      >
        <div className="flex shrink-0 items-center gap-2 pb-1 pl-5 pr-2 pt-2">
          <div className="absolute left-1/2 top-2 h-1 w-10 -translate-x-1/2 rounded-full bg-ink-600" />
          <h2 className="mt-3 flex-1 text-base font-semibold">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={`Close ${title.toLowerCase()}`}
            className="mt-3 grid h-11 w-11 place-items-center rounded-full text-xl text-mute hover:bg-ink-800"
          >
            <IconX />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pt-3">{children}</div>
      </div>
    </div>
  );
}
