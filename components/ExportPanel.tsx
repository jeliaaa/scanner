"use client";

import * as React from "react";
import { exportPdf } from "@/lib/api";
import { type Handoff, uploadToPortal } from "@/lib/handoff";
import { DPI_PRESETS, MODE_LABELS, type ExportReport, type Mode, type Page, type PageSize, type Settings } from "@/lib/types";
import { Button, Field, IconAlert, IconCheck, IconDownload, IconUpload, Segmented, formatBytes } from "./ui";

interface Props {
  pages: Page[];
  sessionId: string;
  settings: Settings;
  onSettings: (patch: Partial<Settings>) => void;
  /** Set when the portal launched this scan and wants the PDF back. */
  handoff?: Handoff | null;
}

export function ExportPanel({ pages, sessionId, settings, onSettings, handoff }: Props) {
  const [busy, setBusy] = React.useState(false);
  const [report, setReport] = React.useState<ExportReport | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [sent, setSent] = React.useState(false);

  // Group 4 is lossless, so a JPEG quality control would do nothing in bw mode.
  const lossless = settings.mode === "bw";

  const download = async () => {
    setBusy(true);
    setError(null);
    setReport(null);
    try {
      const { blob, report: result, filename } = await exportPdf(sessionId, pages, settings);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      // Revoked on the next tick: revoking synchronously can beat the download.
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setReport(result);
    } catch (err) {
      setError((err as Error).message || "The export failed.");
    } finally {
      setBusy(false);
    }
  };

  const sendToPortal = async () => {
    if (!handoff) return;
    setBusy(true);
    setError(null);
    setReport(null);
    try {
      const { blob, report: result, filename } = await exportPdf(sessionId, pages, settings);
      setReport(result);
      const outcome = await uploadToPortal(handoff, blob, filename);
      if (outcome.ok) setSent(true);
      else setError(outcome.message);
    } catch (err) {
      setError((err as Error).message || "The export failed.");
    } finally {
      setBusy(false);
    }
  };

  if (sent) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-xl border border-scan-600/40 bg-scan-500/5 px-4 py-8 text-center">
        <span className="grid h-12 w-12 place-items-center rounded-full bg-scan-500 text-xl text-ink-950">
          <IconCheck />
        </span>
        <div>
          <p className="text-sm font-medium text-text">Sent to the portal</p>
          <p className="mt-1 text-xs text-mute">
            {report ? `${report.pages} page${report.pages > 1 ? "s" : ""}, ${formatBytes(report.bytes)}` : null}
            {handoff?.label ? ` attached to ${handoff.label}` : null}
          </p>
        </div>
        {handoff?.returnTo ? (
          <a
            href={handoff.returnTo}
            className="rounded-lg bg-scan-500 px-3 py-2 text-sm font-medium text-ink-950 hover:bg-scan-400"
          >
            Return to your order
          </a>
        ) : (
          <p className="text-xs text-mute">You can close this tab and return to your order.</p>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Field label="Look">
        <div className="grid grid-cols-2 gap-1.5">
          {(Object.keys(MODE_LABELS) as Mode[]).map((mode) => {
            const active = settings.mode === mode;
            return (
              <button
                key={mode}
                type="button"
                onClick={() => onSettings({ mode })}
                className={`rounded-lg border px-2.5 py-2 text-left transition-colors ${
                  active
                    ? "border-scan-600 bg-scan-500/10"
                    : "border-ink-700 bg-ink-850 hover:border-ink-500"
                }`}
              >
                <div className={`text-xs font-semibold ${active ? "text-scan-400" : "text-text"}`}>
                  {MODE_LABELS[mode].name}
                </div>
                <div className="mt-0.5 text-[11px] leading-tight text-mute">{MODE_LABELS[mode].hint}</div>
              </button>
            );
          })}
        </div>
      </Field>

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
        <p className="rounded-lg bg-ink-850 px-3 py-2 text-[11px] leading-relaxed text-mute">
          Black &amp; white pages are stored with CCITT Group 4, the fax codec. It is lossless and
          usually lands a text page under 60 kB, so there is no quality to trade away.
        </p>
      )}

      <Field label="Page size">
        <select
          value={settings.pageSize}
          onChange={(event) => onSettings({ pageSize: event.target.value as PageSize })}
          className="w-full rounded-lg border border-ink-600 bg-ink-850 px-2.5 py-2 text-sm
            focus:border-scan-600 focus:outline-none"
        >
          <option value="auto">Match the scan</option>
          <option value="a4">A4</option>
          <option value="letter">US Letter</option>
          <option value="legal">US Legal</option>
        </select>
      </Field>

      <Field label="File name">
        <input
          value={settings.filename}
          onChange={(event) => onSettings({ filename: event.target.value })}
          spellCheck={false}
          className="w-full rounded-lg border border-ink-600 bg-ink-850 px-2.5 py-2 text-sm
            focus:border-scan-600 focus:outline-none"
        />
      </Field>

      <div className="rounded-lg border border-ink-700 bg-ink-850/60 p-3">
        <label className="flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            checked={settings.maxMb !== null}
            onChange={(event) => onSettings({ maxMb: event.target.checked ? 2 : null })}
            className="h-4 w-4 accent-[var(--color-scan-500)]"
          />
          <span className="text-xs font-medium text-text">Cap the file size</span>
        </label>

        {settings.maxMb !== null && (
          <div className="mt-2.5 flex items-center gap-2">
            <input
              type="number"
              min={0.1}
              max={200}
              step={0.5}
              value={settings.maxMb}
              onChange={(event) => onSettings({ maxMb: Math.max(0.1, Number(event.target.value)) })}
              className="w-20 rounded-lg border border-ink-600 bg-ink-900 px-2 py-1.5 text-sm tabular-nums
                focus:border-scan-600 focus:outline-none"
            />
            <span className="text-xs text-mute">MB — quality drops until it fits</span>
          </div>
        )}
      </div>

      {handoff ? (
        <div className="flex flex-col gap-2">
          <Button
            variant="primary"
            onClick={() => void sendToPortal()}
            disabled={!pages.length || busy}
            className="w-full py-2.5 text-sm"
          >
            <IconUpload />
            {busy
              ? "Sending…"
              : `Send to portal${pages.length ? ` · ${pages.length} page${pages.length > 1 ? "s" : ""}` : ""}`}
          </Button>

          {/* An escape hatch: if the portal is unreachable the scan is still
              worth something as a file, rather than being lost with the tab. */}
          <button
            type="button"
            onClick={() => void download()}
            disabled={!pages.length || busy}
            className="text-center text-[11px] text-mute underline underline-offset-2
              hover:text-text disabled:opacity-50"
          >
            Download the PDF instead
          </button>
        </div>
      ) : (
        <Button
          variant="primary"
          onClick={() => void download()}
          disabled={!pages.length || busy}
          className="w-full py-2.5 text-sm"
        >
          <IconDownload />
          {busy
            ? "Building the PDF…"
            : `Download PDF${pages.length ? ` · ${pages.length} page${pages.length > 1 ? "s" : ""}` : ""}`}
        </Button>
      )}

      {report && (
        <div className="rounded-lg border border-scan-600/40 bg-scan-500/5 px-3 py-2.5 text-[11px] leading-relaxed">
          <p className="font-medium text-scan-400">
            {formatBytes(report.bytes)} · {report.pages} page{report.pages > 1 ? "s" : ""} · {report.seconds}s
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

      {error && (
        <p className="flex items-start gap-1.5 rounded-lg bg-bad-500/10 px-3 py-2 text-[11px] text-bad-500">
          <IconAlert className="mt-0.5 shrink-0" /> {error}
        </p>
      )}
    </div>
  );
}
