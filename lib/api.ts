import type { ExportReport, Mode, Page, PageSize, Quad, Settings } from "./types";

/** Same-origin thanks to the rewrite in next.config.ts. */
const BASE = "/api/py";

async function ensureOk(res: Response): Promise<Response> {
  if (res.ok) return res;
  let detail = res.statusText;
  try {
    const body = await res.json();
    if (body?.detail) detail = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
  } catch {
    /* non-JSON error body; the status text will do */
  }
  throw new Error(`${res.status} ${detail}`);
}

export async function checkHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/health`, { cache: "no-store" });
    return res.ok;
  } catch {
    return false;
  }
}

export interface DetectResult {
  quad: Quad;
  confidence: number;
  width: number;
  height: number;
  ms: number;
}

/** Used by the live camera loop; posts the frame as a raw body, not multipart. */
export async function detectFrame(blob: Blob, signal?: AbortSignal): Promise<DetectResult> {
  const res = await fetch(`${BASE}/detect`, {
    method: "POST",
    body: blob,
    headers: { "Content-Type": "application/octet-stream" },
    signal,
  });
  return (await ensureOk(res)).json();
}

export async function uploadPage(sessionId: string, blob: Blob): Promise<Omit<Page, "rotate" | "mode">> {
  const form = new FormData();
  form.append("file", blob, "page.jpg");
  const res = await fetch(`${BASE}/sessions/${sessionId}/pages`, { method: "POST", body: form });
  return (await ensureOk(res)).json();
}

export const originalUrl = (sessionId: string, pageId: string) =>
  `${BASE}/sessions/${sessionId}/pages/${pageId}/original`;

export const thumbUrl = (sessionId: string, pageId: string) =>
  `${BASE}/sessions/${sessionId}/pages/${pageId}/thumb`;

export interface PreviewBody {
  quad: Quad;
  rotate: number;
  settings: { mode: Mode; strength: number; dpi: number; quality: number; page_size: PageSize };
  max_dim?: number;
}

/** Returns an object URL the caller is responsible for revoking. */
export async function previewPage(
  sessionId: string,
  pageId: string,
  body: PreviewBody,
  signal?: AbortSignal
): Promise<string> {
  const res = await fetch(`${BASE}/sessions/${sessionId}/pages/${pageId}/preview`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  return URL.createObjectURL(await (await ensureOk(res)).blob());
}

export async function redetectPage(sessionId: string, pageId: string): Promise<{ quad: Quad; confidence: number }> {
  const res = await fetch(`${BASE}/sessions/${sessionId}/pages/${pageId}/redetect`, { method: "POST" });
  return (await ensureOk(res)).json();
}

export async function deletePage(sessionId: string, pageId: string): Promise<void> {
  await ensureOk(await fetch(`${BASE}/sessions/${sessionId}/pages/${pageId}`, { method: "DELETE" }));
}

export function settingsPayload(settings: Settings) {
  return {
    mode: settings.mode,
    strength: settings.strength,
    dpi: settings.dpi,
    quality: settings.quality,
    page_size: settings.pageSize,
  };
}

export async function exportPdf(
  sessionId: string,
  pages: Page[],
  settings: Settings
): Promise<{ blob: Blob; report: ExportReport; filename: string }> {
  const res = await ensureOk(
    await fetch(`${BASE}/sessions/${sessionId}/export`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pages: pages.map((p) => ({ id: p.id, quad: p.quad, rotate: p.rotate, mode: p.mode })),
        settings: settingsPayload(settings),
        filename: settings.filename,
        max_mb: settings.maxMb,
      }),
    })
  );

  const raw = res.headers.get("X-Scan-Report");
  const report: ExportReport = raw
    ? JSON.parse(decodeURIComponent(raw))
    : { bytes: 0, quality: settings.quality, scale: 1, attempts: 1, met_target: true, pages: pages.length, seconds: 0 };

  const filename = settings.filename.toLowerCase().endsWith(".pdf")
    ? settings.filename
    : `${settings.filename}.pdf`;

  return { blob: await res.blob(), report, filename };
}
