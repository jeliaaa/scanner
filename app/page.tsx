"use client";

import * as React from "react";
import { CameraStage } from "@/components/CameraStage";
import { DocumentChip, DocumentList } from "@/components/DocumentList";
import { ExportPanel } from "@/components/ExportPanel";
import { PageEditor } from "@/components/PageEditor";
import { PageStrip } from "@/components/PageStrip";
import { Sheet } from "@/components/Sheet";
import { Button, IconAlert, IconCamera, IconChevronRight, IconPlus, IconUpload, IconX } from "@/components/ui";
import { checkHealth, deletePage as deletePageOnServer, thumbUrl, uploadPage } from "@/lib/api";
import { pagesOf, plural } from "@/lib/documents";
import { type HandoffResult, readHandoff } from "@/lib/handoff";
import { useScanner } from "@/lib/store";

type View = "camera" | "edit";

/** Below this the detector gave up, so the edges are worth a manual look. */
const WEAK_EDGES = 0.25;

export default function ScannerPage() {
  const {
    sessionId,
    pages,
    documents,
    activeDocumentId,
    selectedId,
    settings,
    hydrated,
    ensureSession,
    addPage,
    updatePage,
    removePage,
    movePage,
    select,
    addDocument,
    setActiveDocument,
    markDocumentSent,
    syncPortalDocuments,
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
  const [docsOpen, setDocsOpen] = React.useState(false);

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

  // When the portal names the documents to scan, line the session up with them.
  // Safe to repeat: documents already scanned for the same portal id are kept.
  React.useEffect(() => {
    if (!hydrated || !handoff?.documents) return;
    syncPortalDocuments(handoff.documents.map((doc) => ({ portalId: doc.id, label: doc.label })));
  }, [hydrated, handoff, syncPortalDocuments]);

  // True once every document the link names exists. Rendering waits for it, so
  // there is never a frame showing the default document before the real ones.
  const aligned =
    !handoff?.documents || handoff.documents.every((doc) => documents.some((d) => d.portalId === doc.id));

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

  const activeIndex = Math.max(
    0,
    documents.findIndex((doc) => doc.id === activeDocumentId)
  );
  const activeDoc = documents[activeIndex];
  const docPages = pagesOf(pages, activeDoc.id);
  const selected = docPages.find((page) => page.id === selectedId) ?? null;
  const selectedIndex = selected ? docPages.findIndex((page) => page.id === selected.id) : -1;
  const lastPage = docPages.length ? docPages[docPages.length - 1] : null;

  const multi = documents.length > 1;
  // Documents of your own can be added only on a plain scan. A portal link has
  // fixed documents, and a one-document link's token can be used once, so a
  // second document there would have nowhere to go.
  const allowAdd = !handoff;
  const nextDoc = documents[activeIndex + 1];
  const docsWithPages = documents.filter((doc) => pagesOf(pages, doc.id).length > 0).length;

  const ingest = React.useCallback(
    async (blobs: Blob[], source: "camera" | "import") => {
      setBusy(true);
      setError(null);
      // Read now, not from the closure: the user may switch document while a
      // slow upload is in flight, and these pages belong where they started.
      const target = useScanner.getState().activeDocumentId;
      try {
        const session = ensureSession();
        let weak = false;
        for (let i = 0; i < blobs.length; i++) {
          setProgress(blobs.length > 1 ? `Reading page ${i + 1} of ${blobs.length}…` : "Reading page…");
          const result = await uploadPage(session, blobs[i]);
          addPage({ ...result, rotate: 0, mode: null }, target);
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
    if (pages.length && !confirm(`Discard ${plural(pages.length, "scanned page")}?`)) return;
    pages.forEach((page) => sessionId && void deletePageOnServer(sessionId, page.id).catch(() => undefined));
    reset();
    // A portal order's documents come back from the link, not from the session.
    if (handoff?.documents) {
      syncPortalDocuments(handoff.documents.map((doc) => ({ portalId: doc.id, label: doc.label })));
    }
    setView("camera");
    setPanelOpen(false);
    setDocsOpen(false);
  };

  if (!hydrated || !aligned) {
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

  const chooseDocument = (id: string) => {
    setActiveDocument(id);
    setView("camera");
    setDocsOpen(false);
    setPanelOpen(false);
  };

  const newDocument = () => {
    addDocument();
    setView("camera");
    setDocsOpen(false);
    setPanelOpen(false);
  };

  // Rendered into the desktop rail and the phone editor alike, so the two
  // layouts can never drift apart.
  const pageStrip = (phone: boolean) => (
    <PageStrip
      pages={docPages}
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
      documents={documents}
      sessionId={sessionId}
      settings={settings}
      onSettings={setSettings}
      handoff={handoff}
      onSent={markDocumentSent}
      compact={compact}
    />
  );

  const pagesLabel = plural(pages.length, "page");
  const exportLabel = multi ? plural(docsWithPages, "document") : pagesLabel;
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
                {" — "}
                {multi ? "each finished PDF goes" : "the finished PDF goes"} straight back to the portal.
              </span>
            </div>
          )}

          {handoffResult.status === "rejected" && (
            <div className="flex items-start gap-2 border-b border-bad-500/25 bg-bad-500/10 px-4 py-2.5 text-[13px] text-bad-500 lg:text-xs">
              <IconAlert className="mt-0.5 shrink-0" />
              <span>
                This scan link could not be used, so it has been ignored. {handoffResult.reason} You can still
                scan and download normally.
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
              total={docPages.length}
              onChange={(patch) => updatePage(selected.id, patch)}
              onMove={(delta) => movePage(selected.id, delta)}
              onDelete={() => {
                if (!confirm("Delete this page?")) return;
                handleDelete(selected.id);
                if (docPages.length <= 1) setView("camera");
              }}
              onBack={backToCamera}
              documentLabel={multi ? activeDoc.label : undefined}
              onDocuments={() => setDocsOpen(true)}
            />
          ) : (
            <CameraStage
              busy={busy}
              pageCount={docPages.length}
              lastPage={lastPage && sessionId ? { sessionId, id: lastPage.id } : null}
              onCapture={(blob) => ingest([blob], "camera")}
              onImport={(files) => ingest(files, "import")}
              onReview={() => {
                if (lastPage) select(lastPage.id);
                setView("edit");
              }}
              onDone={() => setPanelOpen(true)}
              topSlot={
                multi ? (
                  <DocumentChip
                    doc={activeDoc}
                    index={activeIndex}
                    total={documents.length}
                    pageCount={docPages.length}
                    onClick={() => setDocsOpen(true)}
                  />
                ) : null
              }
              nextLabel={multi && docPages.length > 0 && nextDoc ? nextDoc.label : null}
              onNext={nextDoc ? () => chooseDocument(nextDoc.id) : undefined}
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
              Export {exportLabel}
              <IconChevronRight className="text-xl" />
            </Button>
          </div>
        )}

        <aside
          className="hidden shrink-0 flex-col gap-4 overflow-y-auto lg:flex lg:w-80 lg:pr-1
            [scrollbar-color:var(--color-ink-600)_transparent]"
        >
          {multi && (
            <div>
              <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-mute">Documents</h2>
              <DocumentList
                documents={documents}
                pages={pages}
                activeId={activeDoc.id}
                token={handoff?.token ?? null}
                onSelect={chooseDocument}
                onAdd={allowAdd ? newDocument : undefined}
              />
            </div>
          )}

          <div>
            <div className="mb-2 flex items-center gap-2">
              <h2 className="truncate text-xs font-medium uppercase tracking-wide text-mute">
                {multi ? `Pages · ${activeDoc.label}` : "Pages"}
              </h2>
              <div className="flex-1" />
              {!camera && (
                <Button variant="outline" onClick={backToCamera} className="px-2 py-1 text-xs">
                  <IconPlus /> Add page
                </Button>
              )}
            </div>
            {pageStrip(false)}
            {allowAdd && !multi && pages.length > 0 && (
              <Button variant="ghost" onClick={newDocument} className="mt-2 w-full text-xs">
                <IconPlus /> Scan a separate document
              </Button>
            )}
          </div>

          <div className="border-t border-ink-800 pt-4">
            <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-mute">Export</h2>
            {exportPanel(false)}
          </div>
        </aside>
      </main>

      {/* Phone: which document the next capture goes into. */}
      {docsOpen && (
        <Sheet title="Documents" onClose={() => setDocsOpen(false)}>
          <DocumentList
            documents={documents}
            pages={pages}
            activeId={activeDoc.id}
            token={handoff?.token ?? null}
            onSelect={chooseDocument}
            onAdd={allowAdd ? newDocument : undefined}
          />
          {pages.length > 0 && (
            <div className="sticky bottom-0 -mx-4 bg-gradient-to-t from-ink-900 from-75% to-transparent px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-4">
              <Button
                variant="primary"
                onClick={() => {
                  setDocsOpen(false);
                  setPanelOpen(true);
                }}
                className="min-h-14 w-full rounded-2xl text-base font-bold"
              >
                Export {exportLabel}
                <IconChevronRight className="text-xl" />
              </Button>
            </div>
          )}
        </Sheet>
      )}

      {/* Phone: export as a bottom sheet, within thumb reach. */}
      {panelOpen && (
        <Sheet title={`Export · ${exportLabel}`} onClose={() => setPanelOpen(false)}>
          {exportPanel(true)}
          {allowAdd && pages.length > 0 && (
            <button
              type="button"
              onClick={newDocument}
              className="mx-auto mt-1 flex min-h-11 items-center gap-1.5 px-4 text-sm font-medium text-scan-400"
            >
              <IconPlus /> Scan another document
            </button>
          )}
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
        </Sheet>
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
