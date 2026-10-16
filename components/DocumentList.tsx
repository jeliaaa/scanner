"use client";

import * as React from "react";
import { pagesOf, plural } from "@/lib/documents";
import type { Doc, Page } from "@/lib/types";
import { IconCheck, IconChevronDown, IconPlus } from "./ui";

interface ListProps {
  documents: Doc[];
  pages: Page[];
  activeId: string;
  /** The hand-off token, so documents already delivered under it can say so. */
  token: string | null;
  onSelect: (id: string) => void;
  /** Present only when the user may add documents of their own. */
  onAdd?: () => void;
}

/** Every document with its page count; tap one to scan into it. */
export function DocumentList({ documents, pages, activeId, token, onSelect, onAdd }: ListProps) {
  return (
    <ul className="flex flex-col gap-2">
      {documents.map((doc, index) => {
        const count = pagesOf(pages, doc.id).length;
        const active = doc.id === activeId;
        const sent = token !== null && doc.sentWith === token;

        return (
          <li key={doc.id}>
            <button
              type="button"
              aria-current={active}
              onClick={() => onSelect(doc.id)}
              className={`flex min-h-14 w-full items-center gap-3 rounded-xl border px-3.5 py-2 text-left
                transition-colors active:scale-[0.99] ${
                  active ? "border-scan-600 bg-scan-500/10" : "border-ink-700 bg-ink-850 hover:border-ink-500"
                }`}
            >
              <span
                className={`grid h-7 w-7 shrink-0 place-items-center rounded-full text-xs font-bold tabular-nums ${
                  sent ? "bg-scan-500 text-ink-950" : active ? "bg-scan-500/20 text-scan-400" : "bg-ink-700 text-mute"
                }`}
              >
                {sent ? <IconCheck /> : index + 1}
              </span>
              <span className="min-w-0 flex-1">
                <span className={`block truncate text-sm font-semibold ${active ? "text-scan-400" : "text-text"}`}>
                  {doc.label}
                </span>
                <span className="block text-xs text-mute">
                  {sent ? "Sent" : count ? plural(count, "page") : "Nothing scanned yet"}
                  {doc.portalId === null && token !== null ? " · not part of the order" : ""}
                </span>
              </span>
            </button>
          </li>
        );
      })}

      {onAdd && (
        <li>
          <button
            type="button"
            onClick={onAdd}
            className="flex min-h-12 w-full items-center justify-center gap-2 rounded-xl border-2 border-dashed
              border-ink-600 text-sm font-medium text-mute transition-colors hover:border-ink-500
              hover:text-text active:scale-[0.99]"
          >
            <IconPlus /> Add a document
          </button>
        </li>
      )}
    </ul>
  );
}

interface ChipProps {
  doc: Doc;
  index: number;
  total: number;
  pageCount: number;
  onClick: () => void;
}

/** Floats over the viewfinder: which document the next capture goes into. */
export function DocumentChip({ doc, index, total, pageCount, onClick }: ChipProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Scanning ${doc.label}, document ${index + 1} of ${total}. Change document.`}
      className="pointer-events-auto flex min-h-11 max-w-full items-center gap-2 rounded-full bg-ink-950/75 pl-4 pr-3
        text-sm font-semibold text-text backdrop-blur-sm transition-colors active:scale-95 hover:bg-ink-800/80
        focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-scan-500"
    >
      <span className="truncate">{doc.label}</span>
      <span className="shrink-0 text-xs font-medium tabular-nums text-mute">
        {index + 1}/{total}
        {pageCount ? ` · ${plural(pageCount, "page")}` : ""}
      </span>
      <IconChevronDown className="shrink-0 text-lg text-mute" />
    </button>
  );
}
