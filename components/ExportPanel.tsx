"use client";

import * as React from "react";
import { exportPdf } from "@/lib/api";
import { documentFilename, pagesOf, plural } from "@/lib/documents";
import { type Handoff, uploadToPortal } from "@/lib/handoff";
import {
  DPI_PRESETS,
  MODE_LABELS,
  type Doc,
  type ExportReport,
  type Mode,
  type Page,
  type PageSize,
  type Settings,
} from "@/lib/types";
import {
  Button,
  Field,
  IconAlert,
  IconCheck,
  IconChevronDown,
  IconDownload,
  IconUpload,
  Segmented,
  formatBytes,
} from "./ui";

interface Props {
  pages: Page[];
  documents: Doc[];
  sessionId: string;
  settings: Settings;
  onSettings: (patch: Partial<Settings>) => void;
  /** Set when the portal launched this scan and wants the PDFs back. */
  handoff?: Handoff | null;
  /** A document was delivered under this token. */
  onSent: (documentId: string, token: string) => void;
  /**
   * Phone sheet: the detailed options start folded away and the action button
   * pins to the bottom of the scrolling sheet, so the one thing everybody
   * does is never further than a thumb away.
   */
  compact?: boolean;
}

interface RowState {
  state: "idle" | "sending" | "failed";
  error?: string;
}

/** 16px: anything smaller makes iOS Safari zoom the page when a field is focused. */
const INPUT =
  "w-full min-h-11 rounded-lg border border-ink-600 bg-ink-850 px-3 py-2 text-base focus:border-scan-600 focus:outline-none sm:min-h-0 sm:px-2.5 sm:text-sm";

function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoked later: revoking synchronously can beat the download.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function ExportPanel({
  pages,
  documents,
  sessionId,
  settings,
  onSettings,
  handoff,
  onSent,
  compact = false,
}: Props) {
  const [busy, setBusy] = React.useState(false);
  const [progress, setProgress] = React.useState<{ at: number; of: number } | null>(null);
  const [rows, setRows] = React.useState<Record<string, RowState>>({});
  const [report, setReport] = React.useState<ExportReport | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [open, setOpen] = React.useState(!compact);

  // Group 4 is lossless, so a JPEG quality control would do nothing in bw mode.
  const lossless = settings.mode === "bw";

  const multi = documents.length > 1;
  const token = handoff?.token ?? null;

  const isSent = (doc: Doc) => token !== null && doc.sentWith === token;
  // With a document list in the link, only documents the portal named can be
  // sent. Without one (the original link) the single document goes as before.
  // That token is good for one upload, so if leftovers from an earlier order
  // mean there are several documents, none of them is sent: they download.
  const isLinked = (doc: Doc) =>
    Boolean(handoff) && (handoff!.documents ? doc.portalId !== null : documents.length === 1);
  const countOf = (doc: Doc) => pagesOf(pages, doc.id).length;

  const ready = documents.filter((doc) => countOf(doc) > 0);
  const pending = ready.filter((doc) => isLinked(doc) && !isSent(doc));
  const missing = documents.filter((doc) => isLinked(doc) && countOf(doc) === 0);
  const sentCount = documents.filter(isSent).length;

  const setRow = (id: string, row: RowState) => setRows((current) => ({ ...current, [id]: row }));

  const build = async (doc: Doc) => {
    const index = documents.findIndex((d) => d.id === doc.id);
    const filename = documentFilename(doc, index, documents.length, settings);
    // Each document is its own PDF, so the size cap applies to each in turn.
    const built = await exportPdf(sessionId, pagesOf(pages, doc.id), { ...settings, filename });
    setReport(built.report);
    return built;
  };

  /** Build and deliver one document. Resolves true when the portal accepted it. */
  const sendOne = async (doc: Doc): Promise<boolean> => {
    if (!handoff) return false;
    setRow(doc.id, { state: "sending" });
    try {
      const { blob, filename } = await build(doc);
      const outcome = await uploadToPortal(
        handoff,
        blob,
        filename,
        handoff.documents ? (doc.portalId ?? undefined) : undefined
      );
      if (outcome.ok) {
        onSent(doc.id, handoff.token);
        setRow(doc.id, { state: "idle" });
        return true;
      }
      setRow(doc.id, { state: "failed", error: outcome.message });
    } catch (err) {
      setRow(doc.id, { state: "failed", error: (err as Error).message || "The export failed." });
    }
    return false;
  };

  const sendMany = async (docs: Doc[]) => {
    setBusy(true);
    setError(null);
    try {
      for (const [i, doc] of docs.entries()) {
        setProgress({ at: i + 1, of: docs.length });
        // Stop at the first failure: carrying on would most likely repeat it
        // (an expired link, no connection) for every remaining document.
        if (!(await sendOne(doc))) break;
      }
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  const downloadMany = async (docs: Doc[]) => {
    setBusy(true);
    setError(null);
    try {
      for (const [i, doc] of docs.entries()) {
        setProgress({ at: i + 1, of: docs.length });
        setRow(doc.id, { state: "sending" });
        const { blob, filename } = await build(doc);
        saveBlob(blob, filename);
        setRow(doc.id, { state: "idle" });
      }
    } catch (err) {
      setError((err as Error).message || "The export failed.");
      setRows({});
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  /* ------------------------------ all delivered ----------------------------- */

  if (handoff && sentCount > 0 && pending.length === 0) {
    const totalPages = documents.filter(isSent).reduce((sum, doc) => sum + countOf(doc), 0);
    return (
      <div className="flex flex-col items-center gap-3 rounded-xl border border-scan-600/40 bg-scan-500/5 px-4 py-8 text-center">
        <span className="grid h-12 w-12 place-items-center rounded-full bg-scan-500 text-xl text-ink-950">
          <IconCheck />
        </span>
        <div>
          <p className="text-sm font-medium text-text">
            {multi ? `Sent ${plural(sentCount, "document")} to the portal` : "Sent to the portal"}
          </p>
          <p className="mt-1 text-xs text-mute">
            {multi || !report
              ? plural(totalPages, "page")
              : `${plural(report.pages, "page")}, ${formatBytes(report.bytes)}`}
            {handoff.label ? ` attached to ${handoff.label}` : null}
          </p>
        </div>

        {missing.length > 0 && (
          <p className="flex items-start gap-1.5 rounded-lg bg-warn-500/10 px-3 py-2 text-left text-xs text-warn-500">
            <IconAlert className="mt-0.5 shrink-0" />
            <span>No scan was added for {missing.map((doc) => doc.label).join(", ")}.</span>
          </p>
        )}

        {handoff.returnTo ? (
          <a
            href={handoff.returnTo}
            className="inline-flex min-h-12 items-center rounded-xl bg-scan-500 px-5 text-base font-semibold text-ink-950 hover:bg-scan-400"
          >
            Return to your order
          </a>
        ) : (
          <p className="text-xs text-mute">You can close this tab and return to your order.</p>
        )}
      </div>
    );
  }

  /* --------------------------------- actions -------------------------------- */

  const pageLabel = pages.length ? ` · ${plural(pages.length, "page")}` : "";
  const sizeLabel = { auto: "Match the scan", a4: "A4", letter: "US Letter", legal: "US Legal" }[settings.pageSize];

  const sendLabel = busy
    ? progress && progress.of > 1
      ? `Sending ${progress.at} of ${progress.of}…`
      : "Sending…"
    : multi
      ? `Send all · ${plural(pending.length, "document")}`
      : `Send to portal${pageLabel}`;

  const downloadLabel = busy
    ? progress && progress.of > 1
      ? `Building ${progress.at} of ${progress.of}…`
      : "Building the PDF…"
    : multi
      ? `Download all · ${plural(ready.length, "document")}`
      : `Download PDF${pageLabel}`;

  const action = (
    <div
      className={
        compact
          ? "sticky bottom-0 -mx-4 flex flex-col gap-1 bg-gradient-to-t from-ink-900 from-75% to-transparent px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-4"
          : "flex flex-col gap-2"
      }
    >
      {handoff ? (
        <>
          <Button
            variant="primary"
            onClick={() => void sendMany(pending)}
            disabled={pending.length === 0 || busy}
            className="min-h-14 w-full rounded-2xl text-base font-bold sm:min-h-11"
          >
            <IconUpload className="text-xl" />
            {sendLabel}
          </Button>

          {/* An escape hatch: if the portal is unreachable the scans are still
              worth something as files, rather than being lost with the tab. */}
          <button
            type="button"
            onClick={() => void downloadMany(ready)}
            disabled={ready.length === 0 || busy}
            className="min-h-11 text-center text-sm text-mute underline underline-offset-2
              hover:text-text disabled:opacity-50"
          >
            {multi ? "Download the PDFs instead" : "Download the PDF instead"}
          </button>
        </>
      ) : (
        <Button
          variant="primary"
          onClick={() => void downloadMany(ready)}
          disabled={ready.length === 0 || busy}
          className="min-h-14 w-full rounded-2xl text-base font-bold sm:min-h-11"
        >
          <IconDownload className="text-xl" />
          {downloadLabel}
        </Button>
      )}
    </div>
  );

  return (
    <div className="flex flex-col gap-4">
      <Field label="Look">
        <div className="grid grid-cols-2 gap-2">
          {(Object.keys(MODE_LABELS) as Mode[]).map((mode) => {
            const active = settings.mode === mode;
            return (
              <button
                key={mode}
                type="button"
                aria-pressed={active}
                onClick={() => onSettings({ mode })}
                className={`min-h-16 rounded-xl border px-3 py-2 text-left transition-colors active:scale-[0.98] ${
                  active
                    ? "border-scan-600 bg-scan-500/10"
                    : "border-ink-700 bg-ink-850 hover:border-ink-500"
                }`}
              >
                <div className={`text-sm font-semibold ${active ? "text-scan-400" : "text-text"}`}>
                  {MODE_LABELS[mode].name}
                </div>
                <div className="mt-0.5 text-xs leading-tight text-mute">{MODE_LABELS[mode].hint}</div>
              </button>
            );
          })}
        </div>
      </Field>

      {/* One row per document: what it holds, where it stands, and a button for
          just that one, so a single failure can be retried without redoing the
          rest. */}
      {multi && (
        <div>
          <h3 className="mb-1.5 text-xs font-medium uppercase tracking-wide text-mute">Documents</h3>
          <ul className="flex flex-col gap-2">
            {documents.map((doc, index) => {
              const count = countOf(doc);
              const row = rows[doc.id];
              const sent = isSent(doc);
              const linked = isLinked(doc);

              const note = sent
                ? "Sent"
                : row?.state === "sending"
                  ? "Working…"
                  : row?.state === "failed"
                    ? row.error
                    : count === 0
                      ? "Nothing scanned"
                      : `${plural(count, "page")}${handoff && !linked ? " · not part of the order" : ""}`;

              return (
                <li
                  key={doc.id}
                  className="flex min-h-14 items-center gap-3 rounded-xl border border-ink-700 bg-ink-850/60 py-2 pl-3.5 pr-2"
                >
                  <span
                    className={`grid h-7 w-7 shrink-0 place-items-center rounded-full text-xs font-bold tabular-nums ${
                      sent ? "bg-scan-500 text-ink-950" : "bg-ink-700 text-mute"
                    }`}
                  >
                    {sent ? <IconCheck /> : index + 1}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-text">{doc.label}</span>
                    <span
                      className={`block text-xs ${
                        row?.state === "failed" ? "text-bad-500" : count === 0 && !sent ? "text-warn-500" : "text-mute"
                      }`}
                    >
                      {note}
                    </span>
                  </span>

                  {!sent && count > 0 && (
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() => void (handoff && linked ? sendMany([doc]) : downloadMany([doc]))}
                      className="shrink-0 px-3 text-sm"
                    >
                      {handoff && linked ? (row?.state === "failed" ? "Retry" : "Send") : "Download"}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* The fine print. Defaults are right for most scans, so on a phone it
          folds into one line that still says what is currently chosen. */}
      <div className="rounded-xl bg-ink-850/60">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className="flex min-h-14 w-full items-center gap-3 px-4 text-left"
        >
          <span className="text-sm font-semibold text-text">More options</span>
          <span className="min-w-0 flex-1 truncate text-right text-xs text-mute">
            {open ? "" : `${settings.dpi} DPI · ${sizeLabel}${settings.maxMb !== null ? ` · max ${settings.maxMb} MB` : ""}`}
          </span>
          <IconChevronDown className={`shrink-0 text-xl text-mute transition-transform ${open ? "rotate-180" : ""}`} />
        </button>

        {open && (
          <div className="flex flex-col gap-4 border-t border-ink-700 px-4 py-4">
            {settings.mode !== "photo" && (
              <Field label="Clean-up strength" hint={`${Math.round(settings.strength * 100)}%`}>
                <input
                  type="range"
                  min={0}
                  max={1.4}
                  step={0.05}
                  value={settings.strength}
                  onChange={(event) => onSettings({ strength: Number(event.target.value) })}
                  className="w-full"
                />
              </Field>
            )}

            <Field label="Resolution" hint={`${settings.dpi} DPI`}>
              <Segmented
                value={String(settings.dpi)}
                onChange={(value) => onSettings({ dpi: Number(value) })}
                options={DPI_PRESETS.map((preset) => ({
                  value: String(preset.value),
                  label: preset.label,
                  title: preset.hint,
                }))}
              />
            </Field>

            {!lossless && (
              <Field label="Image quality" hint={`${settings.quality}`}>
                <input
                  type="range"
                  min={40}
                  max={95}
                  step={1}
                  value={settings.quality}
                  onChange={(event) => onSettings({ quality: Number(event.target.value) })}
                  className="w-full"
                />
              </Field>
            )}

            {lossless && (
              <p className="rounded-lg bg-ink-850 px-3 py-2 text-xs leading-relaxed text-mute">
                Black &amp; white pages are stored with CCITT Group 4, the fax codec. It is lossless and
                usually lands a text page under 60 kB, so there is no quality to trade away.
              </p>
            )}

            <Field label="Page size">
              <select
                value={settings.pageSize}
                onChange={(event) => onSettings({ pageSize: event.target.value as PageSize })}
                className={INPUT}
              >
                <option value="auto">Match the scan</option>
                <option value="a4">A4</option>
                <option value="letter">US Letter</option>
                <option value="legal">US Legal</option>
              </select>
            </Field>

            {multi ? (
              <p className="rounded-lg bg-ink-850 px-3 py-2 text-xs leading-relaxed text-mute">
                Each document is saved as its own PDF, named after the document.
              </p>
            ) : (
              <Field label="File name">
                <input
                  value={settings.filename}
                  onChange={(event) => onSettings({ filename: event.target.value })}
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  enterKeyHint="done"
                  className={INPUT}
                />
              </Field>
            )}

            <div className="rounded-lg border border-ink-700 bg-ink-850/60 p-3">
              <label className="flex min-h-11 cursor-pointer items-center gap-3">
                <input
                  type="checkbox"
                  checked={settings.maxMb !== null}
                  onChange={(event) => onSettings({ maxMb: event.target.checked ? 2 : null })}
                  className="h-5 w-5 accent-[var(--color-scan-500)]"
                />
                <span className="text-sm font-medium text-text">
                  Cap the file size{multi ? " of each PDF" : ""}
                </span>
              </label>

              {settings.maxMb !== null && (
                <div className="mt-2 flex items-center gap-3">
                  <input
                    type="number"
                    inputMode="decimal"
                    min={0.1}
                    max={200}
                    step={0.5}
                    value={settings.maxMb}
                    onChange={(event) => onSettings({ maxMb: Math.max(0.1, Number(event.target.value)) })}
                    className="min-h-11 w-24 rounded-lg border border-ink-600 bg-ink-900 px-3 py-2 text-base tabular-nums
                      focus:border-scan-600 focus:outline-none sm:min-h-0 sm:text-sm"
                  />
                  <span className="text-xs text-mute">MB — quality drops until it fits</span>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {handoff && missing.length > 0 && (
        <p className="flex items-start gap-1.5 rounded-xl bg-warn-500/10 px-3.5 py-3 text-sm text-warn-500">
          <IconAlert className="mt-0.5 shrink-0" />
          <span>Nothing scanned yet for {missing.map((doc) => doc.label).join(", ")}.</span>
        </p>
      )}

      {report && (
        <div className="rounded-xl border border-scan-600/40 bg-scan-500/5 px-3.5 py-3 text-xs leading-relaxed">
          <p className="font-medium text-scan-400">
            {formatBytes(report.bytes)} · {plural(report.pages, "page")} · {report.seconds}s
          </p>
          <p className="mt-0.5 text-mute">
            {formatBytes(Math.round(report.bytes / Math.max(report.pages, 1)))} per page
            {report.attempts > 1 && ` · squeezed to quality ${report.quality}`}
            {report.scale < 1 && ` at ${Math.round(report.scale * 100)}% scale`}
          </p>
          {!report.met_target && (
            <p className="mt-1 flex items-center gap-1.5 text-warn-500">
              <IconAlert /> Could not reach the cap without ruining the pages.
            </p>
          )}
        </div>
      )}

      {/* With several documents each row reports its own failure; with one
          there is no row to carry it, so it is shown here. */}
      {(error || (!multi && rows[documents[0]?.id]?.error)) && (
        <p className="flex items-start gap-1.5 rounded-xl bg-bad-500/10 px-3.5 py-3 text-sm text-bad-500">
          <IconAlert className="mt-0.5 shrink-0" /> {error ?? rows[documents[0].id]?.error}
        </p>
      )}

      {action}
    </div>
  );
}
