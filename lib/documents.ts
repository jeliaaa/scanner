import type { Doc, Page, Settings } from "./types";

export const pagesOf = (pages: Page[], documentId: string) =>
  pages.filter((page) => page.documentId === documentId);

export const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

/** Characters a file name cannot carry on Windows, plus control characters. */
const UNSAFE_FILENAME = /[\\/:*?"<>|\u0000-\u001f]/g;

/**
 * The PDF name for one document.
 *
 * With a single document the user's own file name wins. With several, each file
 * is named after its document, so four PDFs do not all arrive called
 * "Scan 2026-10-17.pdf" and overwrite each other in a downloads folder.
 */
export function documentFilename(doc: Doc, index: number, total: number, settings: Settings): string {
  if (total <= 1) return settings.filename;

  const base = settings.filename.replace(/\.pdf$/i, "");
  const name = doc.portalId !== null ? doc.label : `${base} (${index + 1})`;
  const safe = name.replace(UNSAFE_FILENAME, "-").trim().slice(0, 100) || `Document ${index + 1}`;
  return `${safe}.pdf`;
}
