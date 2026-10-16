"use client";

import * as React from "react";
import { CameraStage } from "@/components/CameraStage";
import { ExportPanel } from "@/components/ExportPanel";
import { PageEditor } from "@/components/PageEditor";
import { PageStrip } from "@/components/PageStrip";
import { Button, IconAlert, IconCamera, IconChevronRight, IconPlus, IconUpload, IconX } from "@/components/ui";
import { checkHealth, deletePage as deletePageOnServer, thumbUrl, uploadPage } from "@/lib/api";
import { type HandoffResult, readHandoff } from "@/lib/handoff";
import { useScanner } from "@/lib/store";

type View = "camera" | "edit";

/** Below this the detector gave up, so the edges are worth a manual look. */
const WEAK_EDGES = 0.25;

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
  // Phone only: the desktop rail is always visible instead.
  const [panelOpen, setPanelOpen] = React.useState(false);

  // Read once from the launch URL. A lazy initialiser rather than an effect,
  // so it never causes a second render, and the query string cannot change
  // underneath us without a reload anyway.
  const [handoffResult] = React.useState<HandoffResult>(() =>
    typeof window === "undefined" ? { status: "none" } : readHandoff(window.location.search)
  );
  const handoff = handoffResult.status === "ready" ? handoffResult.handoff : null;

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

  // Escape closes the phone sheet, as it does any other dialog.
  React.useEffect(() => {
    if (!panelOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPanelOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [panelOpen]);

  const selected = pages.find((page) => page.id === selectedId) ?? null;
  const selectedIndex = selected ? pages.findIndex((page) => page.id === selected.id) : -1;
  const lastPage = pages.length ? pages[pages.length - 1] : null;

  const ingest = React.useCallback(
    async (blobs: Blob[], source: "camera" | "import") => {
      setBusy(true);
      setError(null);
      try {
        const session = ensureSession();
        let weak = false;
        for (let i = 0; i < blobs.length; i++) {
          setProgress(blobs.length > 1 ? `Reading page ${i + 1} of ${blobs.length}…` : "Reading page…");
          const result = await uploadPage(session, blobs[i]);
          addPage({ ...result, rotate: 0, mode: null });
          if (result.confidence < WEAK_EDGES) weak = true;
        }
        // Scanning several pages is a rhythm: capture, capture, capture. So a
        // good capture drops you straight back to the viewfinder, and only a
        // page whose edges need a hand interrupts with the editor. Imported
        // photos always open for review, since they were not just framed.
        if (source === "import" || weak) setView("edit");
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
    setPanelOpen(false);
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

  const backToCamera = () => {
    setView("camera");
    setPanelOpen(false);
  };

  // Rendered into the desktop rail and the phone editor alike, so the two
  // layouts can never drift apart.
  const pageStrip = (phone: boolean) => (
    <PageStrip
      pages={pages}
      sessionId={sessionId}
      selectedId={selectedId}
      onSelect={(id) => {
        select(id);
        setView("edit");
        setPanelOpen(false);
      }}
      onDelete={handleDelete}
      onMove={movePage}
      onAdd={phone ? backToCamera : undefined}
    />
  );

  const exportPanel = (compact: boolean) => (
    <ExportPanel
      pages={pages}
      sessionId={sessionId}
      settings={settings}
      onSettings={setSettings}
      handoff={handoff}
      compact={compact}
    />
  );

  const pagesLabel = `${pages.length} page${pages.length === 1 ? "" : "s"}`;
  const hasBanner = backendUp === false || Boolean(handoff) || handoffResult.status === "rejected" || Boolean(error);
  const camera = view === "camera" || !selected;

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      {/* Desktop header. On a phone every pixel of height belongs to the
          viewfinder, so the title, count and Start over live elsewhere there:
          the count rides the thumbnail, Start over sits in the export sheet. */}
      <header className="hidden shrink-0 items-center gap-3 border-b border-ink-800 px-4 py-2.5 lg:flex">
        <div className="flex items-center gap-2">
          <span className="grid h-7 w-7 place-items-center rounded-md bg-scan-500 text-ink-950">
            <IconCamera className="text-base" />
          </span>
          <h1 className="text-sm font-semibold tracking-tight">Scanner</h1>
        </div>

        <span className="text-xs text-mute">{pages.length ? pagesLabel : "Ready"}</span>

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

      {hasBanner && (
        <div className="relative z-10 shrink-0 bg-ink-950 pt-[env(safe-area-inset-top)] lg:pt-0">
          {backendUp === false && (
            <div className="border-b border-bad-500/25 bg-bad-500/10 px-4 py-2.5 text-[13px] text-bad-500 lg:text-xs">
              The Python vision service is not answering on <code>/api/py/health</code>. Start it with{" "}
              <code className="rounded bg-ink-950/50 px-1 py-0.5">npm run api</code>, then this banner will clear
              itself.
            </div>
          )}

          {handoff && (
            <div className="flex items-center gap-2 border-b border-scan-600/30 bg-scan-500/10 px-4 py-2.5 text-[13px] text-scan-400 lg:text-xs">
              <IconUpload className="shrink-0" />
              <span>
                Scanning for {handoff.label ?? (handoff.translationId ? `order ${handoff.translationId}` : "your order")}
                {" — "}the finished PDF goes straight back to the portal.
              </span>
            </div>
          )}

          {handoffResult.status === "rejected" && (
            <div className="flex items-start gap-2 border-b border-bad-500/25 bg-bad-500/10 px-4 py-2.5 text-[13px] text-bad-500 lg:text-xs">
              <IconAlert className="mt-0.5 shrink-0" />
              <span>
                This link asked for the scan to be sent somewhere that is not approved, so it has been
                ignored. {handoffResult.reason} You can still scan and download normally.
              </span>
            </div>
          )}

          {error && (
            <div className="flex items-start gap-2 border-b border-warn-500/25 bg-warn-500/10 pl-4 text-[13px] text-warn-500 lg:text-xs">
              <IconAlert className="mt-3 shrink-0" />
              <span className="flex-1 py-2.5">{error}</span>
              <button
                type="button"
                onClick={() => setError(null)}
                aria-label="Dismiss"
                className="grid h-11 w-11 shrink-0 place-items-center text-lg"
              >
                <IconX />
              </button>
            </div>
          )}
        </div>
      )}

      <main
        className={`flex min-h-0 flex-1 flex-col lg:flex-row lg:gap-4 lg:p-4 ${
          camera
            ? ""
            : "gap-2.5 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-[max(0.75rem,env(safe-area-inset-top))]"
        }`}
      >
        <section className="min-h-0 flex-1">
          {!camera && selected ? (
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
              onMove={(delta) => movePage(selected.id, delta)}
              onDelete={() => {
                if (!confirm("Delete this page?")) return;
                handleDelete(selected.id);
                if (pages.length <= 1) setView("camera");
              }}
              onBack={backToCamera}
            />
          ) : (
            <CameraStage
              busy={busy}
              pageCount={pages.length}
              lastPage={lastPage && sessionId ? { sessionId, id: lastPage.id } : null}
              onCapture={(blob) => ingest([blob], "camera")}
              onImport={(files) => ingest(files, "import")}
              onReview={() => {
                if (lastPage) select(lastPage.id);
                setView("edit");
              }}
              onDone={() => setPanelOpen(true)}
            />
          )}
        </section>

        {/* Phone, while reviewing: the page strip with a "+" to add more, then
            the one action that moves the job forward, full width where a thumb
            lands. The camera needs neither; its own thumbnail and Done button
            do the same job there. */}
        {!camera && pages.length > 0 && (
          <div className="flex shrink-0 flex-col gap-2.5 lg:hidden">
            {pageStrip(true)}
            <Button
              variant="primary"
              onClick={() => setPanelOpen(true)}
              className="min-h-14 w-full rounded-2xl text-base font-bold"
            >
              Export {pagesLabel}
              <IconChevronRight className="text-xl" />
            </Button>
          </div>
        )}

        <aside
          className="hidden shrink-0 flex-col gap-4 overflow-y-auto lg:flex lg:w-80 lg:pr-1
            [scrollbar-color:var(--color-ink-600)_transparent]"
        >
          <div>
            <div className="mb-2 flex items-center gap-2">
              <h2 className="text-xs font-medium uppercase tracking-wide text-mute">Pages</h2>
              <div className="flex-1" />
              {!camera && (
                <Button variant="outline" onClick={backToCamera} className="px-2 py-1 text-xs">
                  <IconPlus /> Add page
                </Button>
              )}
            </div>
            {pageStrip(false)}
          </div>

          <div className="border-t border-ink-800 pt-4">
            <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-mute">Export</h2>
            {exportPanel(false)}
          </div>
        </aside>
      </main>

      {/* Phone: export as a bottom sheet, within thumb reach. */}
      {panelOpen && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Export">
          <button
            type="button"
            aria-label="Close export"
            onClick={() => setPanelOpen(false)}
            className="absolute inset-0 bg-ink-950/70 backdrop-blur-sm"
          />
          <div
            className="absolute inset-x-0 bottom-0 flex max-h-[92dvh] flex-col rounded-t-3xl border-t border-ink-700
              bg-ink-900 shadow-2xl shadow-black/60"
          >
            <div className="flex shrink-0 items-center gap-2 pb-1 pl-5 pr-2 pt-2">
              <div className="absolute left-1/2 top-2 h-1 w-10 -translate-x-1/2 rounded-full bg-ink-600" />
              <h2 className="mt-3 flex-1 text-base font-semibold">Export · {pagesLabel}</h2>
              <button
                type="button"
                onClick={() => setPanelOpen(false)}
                aria-label="Close export"
                className="mt-3 grid h-11 w-11 place-items-center rounded-full text-xl text-mute hover:bg-ink-800"
              >
                <IconX />
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pt-3">
              {exportPanel(true)}
              {pages.length > 0 && (
                <button
                  type="button"
                  onClick={startOver}
                  className="mx-auto mb-[max(0.5rem,env(safe-area-inset-bottom))] block min-h-11 px-4 text-sm text-mute
                    underline underline-offset-2 hover:text-text"
                >
                  Discard all pages and start over
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {progress && (
        <div className="pointer-events-none fixed inset-0 z-30 grid place-items-center">
          <span className="flex items-center gap-2.5 rounded-full bg-ink-800 px-4 py-2.5 text-sm text-text shadow-xl shadow-black/50">
            <span className="relative h-4 w-4 overflow-hidden rounded-sm ring-1 ring-ink-500">
              <span className="scan-sweep absolute inset-x-0 h-1/3 bg-scan-500/70" />
            </span>
            {progress}
          </span>
        </div>
      )}
    </div>
  );
}
