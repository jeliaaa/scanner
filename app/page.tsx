"use client";

import * as React from "react";
import { CameraStage } from "@/components/CameraStage";
import { ExportPanel } from "@/components/ExportPanel";
import { PageEditor } from "@/components/PageEditor";
import { PageStrip } from "@/components/PageStrip";
import { Button, IconAlert, IconCamera, IconPlus, IconX } from "@/components/ui";
import { checkHealth, deletePage as deletePageOnServer, thumbUrl, uploadPage } from "@/lib/api";
import { useScanner } from "@/lib/store";

type View = "camera" | "edit";

export default function ScannerPage() {
  const {
    sessionId,
    pages,
    selectedId,
    settings,
    hydrated,
    ensureSession,
    addPage,
    updatePage,
    removePage,
    movePage,
    select,
    setSettings,
    markHydrated,
    reset,
  } = useScanner();

  const [view, setView] = React.useState<View>("camera");
  const [busy, setBusy] = React.useState(false);
  const [progress, setProgress] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [backendUp, setBackendUp] = React.useState<boolean | null>(null);

  // Belt and braces: if persist has nothing stored, its rehydrate callback may
  // not fire, and the app must not sit on a blank screen waiting for it.
  React.useEffect(() => {
    if (!hydrated) markHydrated();
  }, [hydrated, markHydrated]);

  React.useEffect(() => {
    let alive = true;
    const ping = async () => {
      const ok = await checkHealth();
      if (alive) setBackendUp(ok);
    };
    void ping();
    const timer = setInterval(ping, 15_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  // Sessions are swept after a day, so restored pages can point at files that
  // are gone. Drop those rather than render broken thumbnails.
  const pruned = React.useRef(false);
  React.useEffect(() => {
    if (!hydrated || pruned.current || !sessionId || !pages.length) return;
    pruned.current = true;
    void (async () => {
      for (const page of pages) {
        try {
          const res = await fetch(thumbUrl(sessionId, page.id), { method: "GET", cache: "no-store" });
          if (!res.ok) removePage(page.id);
        } catch {
          return; // service unreachable; keep the pages and try again later
        }
      }
    })();
  }, [hydrated, sessionId, pages, removePage]);

  const selected = pages.find((page) => page.id === selectedId) ?? null;
  const selectedIndex = selected ? pages.findIndex((page) => page.id === selected.id) : -1;

  const ingest = React.useCallback(
    async (blobs: Blob[]) => {
      setBusy(true);
      setError(null);
      try {
        const session = ensureSession();
        for (let i = 0; i < blobs.length; i++) {
          if (blobs.length > 1) setProgress(`Reading page ${i + 1} of ${blobs.length}…`);
          const result = await uploadPage(session, blobs[i]);
          addPage({ ...result, rotate: 0, mode: null });
        }
        setView("edit");
      } catch (err) {
        setError(
          (err as Error).message.includes("Failed to fetch")
            ? "The vision service is not responding. Start it with: npm run api"
            : (err as Error).message
        );
      } finally {
        setBusy(false);
        setProgress(null);
      }
    },
    [addPage, ensureSession]
  );

  const handleDelete = React.useCallback(
    (id: string) => {
      removePage(id);
      if (sessionId) void deletePageOnServer(sessionId, id).catch(() => undefined);
    },
    [removePage, sessionId]
  );

  const startOver = () => {
    if (pages.length && !confirm(`Discard ${pages.length} scanned page${pages.length > 1 ? "s" : ""}?`)) return;
    pages.forEach((page) => sessionId && void deletePageOnServer(sessionId, page.id).catch(() => undefined));
    reset();
    setView("camera");
  };

  if (!hydrated) {
    return (
      <div className="grid h-dvh place-items-center">
        <div className="relative h-12 w-12 overflow-hidden rounded-md ring-1 ring-ink-600">
          <div className="scan-sweep absolute inset-x-0 h-1/3 bg-scan-500/60" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <header className="flex shrink-0 items-center gap-3 border-b border-ink-800 px-4 py-2.5">
        <div className="flex items-center gap-2">
          <span className="grid h-7 w-7 place-items-center rounded-md bg-scan-500 text-ink-950">
            <IconCamera className="text-base" />
          </span>
          <h1 className="text-sm font-semibold tracking-tight">Scanner</h1>
        </div>

        <span className="text-xs text-mute">
          {pages.length ? `${pages.length} page${pages.length > 1 ? "s" : ""}` : "Ready"}
        </span>

        <div className="flex-1" />

        {backendUp === false && (
          <span className="flex items-center gap-1.5 rounded-full bg-bad-500/10 px-2.5 py-1 text-[11px] text-bad-500">
            <IconAlert /> Vision service offline
          </span>
        )}

        {pages.length > 0 && (
          <Button variant="ghost" onClick={startOver} className="text-xs">
            Start over
          </Button>
        )}
      </header>

      {backendUp === false && (
        <div className="shrink-0 border-b border-bad-500/25 bg-bad-500/10 px-4 py-2 text-xs text-bad-500">
          The Python vision service is not answering on <code>/api/py/health</code>. Start it with{" "}
          <code className="rounded bg-ink-950/50 px-1 py-0.5">npm run api</code>, then this banner will clear itself.
        </div>
      )}

      {error && (
        <div className="flex shrink-0 items-start gap-2 border-b border-warn-500/25 bg-warn-500/10 px-4 py-2 text-xs text-warn-500">
          <IconAlert className="mt-0.5 shrink-0" />
          <span className="flex-1">{error}</span>
          <button type="button" onClick={() => setError(null)} aria-label="Dismiss">
            <IconX />
          </button>
        </div>
      )}

      <main className="flex min-h-0 flex-1 flex-col gap-4 p-4 lg:flex-row">
        <section className="min-h-0 flex-1">
          {view === "edit" && selected ? (
            <PageEditor
              // Keyed by page: switching pages remounts with that page's
              // quad as initial state, instead of syncing it in an effect.
              key={selected.id}
              page={selected}
              sessionId={sessionId}
              settings={settings}
              index={selectedIndex}
              total={pages.length}
              onChange={(patch) => updatePage(selected.id, patch)}
              onDelete={() => {
                handleDelete(selected.id);
                if (pages.length <= 1) setView("camera");
              }}
              onDone={() => setView("camera")}
            />
          ) : (
            <CameraStage
              busy={busy}
              onCapture={(blob) => ingest([blob])}
              onImport={(files) => ingest(files)}
            />
          )}
        </section>

        <aside
          className="flex w-full shrink-0 flex-col gap-4 overflow-y-auto lg:w-80 lg:pr-1
            [scrollbar-color:var(--color-ink-600)_transparent]"
        >
          <div>
            <div className="mb-2 flex items-center gap-2">
              <h2 className="text-xs font-medium uppercase tracking-wide text-mute">Pages</h2>
              <div className="flex-1" />
              {view === "edit" && (
                <Button variant="outline" onClick={() => setView("camera")} className="px-2 py-1 text-xs">
                  <IconPlus /> Add page
                </Button>
              )}
            </div>

            <PageStrip
              pages={pages}
              sessionId={sessionId}
              selectedId={selectedId}
              onSelect={(id) => {
                select(id);
                setView("edit");
              }}
              onDelete={handleDelete}
              onMove={movePage}
            />
          </div>

          <div className="border-t border-ink-800 pt-4">
            <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-mute">Export</h2>
            <ExportPanel
              pages={pages}
              sessionId={sessionId}
              settings={settings}
              onSettings={setSettings}
            />
          </div>
        </aside>
      </main>

      {progress && (
        <div className="pointer-events-none fixed inset-x-0 bottom-6 flex justify-center">
          <span className="rounded-full bg-ink-800 px-4 py-2 text-xs text-text shadow-xl shadow-black/50">
            {progress}
          </span>
        </div>
      )}
    </div>
  );
}
