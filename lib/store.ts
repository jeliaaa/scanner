"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Doc, Mode, Page, Quad, Settings } from "./types";

const today = () => new Date().toISOString().slice(0, 10);

const DEFAULT_SETTINGS: Settings = {
  mode: "color",
  strength: 1,
  dpi: 200,
  quality: 80,
  pageSize: "auto",
  maxMb: null,
  filename: `Scan ${today()}.pdf`,
};

/** Every session starts with one document, so a plain scan needs no setup. */
const mainDocument = (): Doc => ({ id: "main", label: "Document 1", portalId: null, sentWith: null });

interface PortalDocument {
  portalId: number;
  label: string;
}

interface ScannerState {
  sessionId: string;
  pages: Page[];
  documents: Doc[];
  activeDocumentId: string;
  selectedId: string | null;
  settings: Settings;
  hydrated: boolean;

  ensureSession: () => string;
  /** The page joins `documentId`, or the active document when omitted. */
  addPage: (page: Omit<Page, "documentId">, documentId?: string) => void;
  updatePage: (id: string, patch: Partial<Page>) => void;
  removePage: (id: string) => void;
  /** Moves a page within its own document; never across documents. */
  movePage: (id: string, delta: number) => void;
  select: (id: string | null) => void;
  addDocument: () => string;
  setActiveDocument: (id: string) => void;
  markDocumentSent: (id: string, token: string) => void;
  /** Line the documents up with the ones the portal asked for. */
  syncPortalDocuments: (docs: PortalDocument[]) => void;
  setSettings: (patch: Partial<Settings>) => void;
  reset: () => void;
  markHydrated: () => void;
}

export const useScanner = create<ScannerState>()(
  persist(
    (set, get) => ({
      sessionId: "",
      pages: [],
      documents: [mainDocument()],
      activeDocumentId: "main",
      selectedId: null,
      settings: DEFAULT_SETTINGS,
      hydrated: false,

      ensureSession: () => {
        const existing = get().sessionId;
        if (existing) return existing;
        // Hex rather than a raw UUID: the server only accepts [A-Za-z0-9_-]
        // in path segments, and this keeps ids well inside that.
        const id = crypto.randomUUID().replace(/-/g, "");
        set({ sessionId: id });
        return id;
      },

      addPage: (page, documentId) =>
        set((s) => {
          const target = s.documents.some((d) => d.id === documentId) ? documentId! : s.activeDocumentId;
          return {
            pages: [...s.pages, { ...page, documentId: target }],
            selectedId: page.id,
            activeDocumentId: target,
          };
        }),

      updatePage: (id, patch) =>
        set((s) => ({ pages: s.pages.map((p) => (p.id === id ? { ...p, ...patch } : p)) })),

      removePage: (id) =>
        set((s) => {
          const page = s.pages.find((p) => p.id === id);
          if (!page) return s;
          const mates = s.pages.filter((p) => p.documentId === page.documentId);
          const at = mates.findIndex((p) => p.id === id);
          const rest = mates.filter((p) => p.id !== id);
          // Keep a neighbour from the same document selected so the stage does
          // not blank out, or jump to a page from a different document.
          const next = rest[Math.min(at, rest.length - 1)] ?? null;
          return {
            pages: s.pages.filter((p) => p.id !== id),
            selectedId: s.selectedId === id ? next?.id ?? null : s.selectedId,
          };
        }),

      movePage: (id, delta) =>
        set((s) => {
          const from = s.pages.findIndex((p) => p.id === id);
          if (from < 0) return s;
          // Positions of this document's pages within the flat list: swapping
          // with the next one of the same document leaves the others alone.
          const slots = s.pages.flatMap((p, i) => (p.documentId === s.pages[from].documentId ? [i] : []));
          const to = slots[slots.indexOf(from) + delta];
          if (to === undefined) return s;
          const pages = [...s.pages];
          [pages[from], pages[to]] = [pages[to], pages[from]];
          return { pages };
        }),

      select: (id) =>
        set((s) => {
          const page = s.pages.find((p) => p.id === id);
          return { selectedId: id, activeDocumentId: page ? page.documentId : s.activeDocumentId };
        }),

      addDocument: () => {
        const id = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
        set((s) => ({
          documents: [...s.documents, { id, label: `Document ${s.documents.length + 1}`, portalId: null, sentWith: null }],
          activeDocumentId: id,
          selectedId: null,
        }));
        return id;
      },

      setActiveDocument: (id) =>
        set((s) => {
          if (!s.documents.some((d) => d.id === id)) return s;
          const last = [...s.pages].reverse().find((p) => p.documentId === id);
          return { activeDocumentId: id, selectedId: last?.id ?? null };
        }),

      markDocumentSent: (id, token) =>
        set((s) => ({ documents: s.documents.map((d) => (d.id === id ? { ...d, sentWith: token } : d)) })),

      syncPortalDocuments: (wanted) =>
        set((s) => {
          const known = new Map(s.documents.filter((d) => d.portalId !== null).map((d) => [d.portalId, d]));
          const linked: Doc[] = wanted.map(
            (w) =>
              // A reload keeps what was already scanned for this document.
              known.get(w.portalId)
                ? { ...known.get(w.portalId)!, label: w.label }
                : {
                    id: `portal-${w.portalId}`,
                    label: w.label,
                    portalId: w.portalId,
                    sentWith: null,
                  }
          );

          // Anything scanned earlier that is not one of the order's documents
          // is kept, unlinked, rather than silently dropped or filed against
          // the wrong order. Empty leftovers are just discarded.
          const linkedIds = new Set(linked.map((d) => d.id));
          const leftovers = s.documents
            .filter((d) => !linkedIds.has(d.id) && s.pages.some((p) => p.documentId === d.id))
            .map((d) => ({ ...d, portalId: null }));

          const documents = [...linked, ...leftovers];
          // Stay on the current document only if it is one of the order's; an
          // unlinked leftover should never be where the next capture lands.
          const active = linkedIds.has(s.activeDocumentId) ? s.activeDocumentId : documents[0].id;
          return { documents, activeDocumentId: active };
        }),

      setSettings: (patch) => set((s) => ({ settings: { ...s.settings, ...patch } })),

      reset: () =>
        set({
          pages: [],
          documents: [mainDocument()],
          activeDocumentId: "main",
          selectedId: null,
          settings: { ...DEFAULT_SETTINGS, filename: `Scan ${today()}.pdf` },
        }),

      markHydrated: () => set({ hydrated: true }),
    }),
    {
      name: "scanner-session",
      // v1 introduced documents. Earlier sessions stored a flat list of pages,
      // which all become the one default document.
      version: 1,
      migrate: (persisted, version) => {
        const old = (persisted ?? {}) as { pages?: Omit<Page, "documentId">[] };
        if (version >= 1) return persisted as ScannerState;
        return {
          ...old,
          pages: (old.pages ?? []).map((p) => ({ ...p, documentId: "main" })),
          documents: [mainDocument()],
          activeDocumentId: "main",
        } as unknown as ScannerState;
      },
      partialize: (s) => ({
        sessionId: s.sessionId,
        pages: s.pages,
        documents: s.documents,
        activeDocumentId: s.activeDocumentId,
        settings: s.settings,
      }),
      // Nothing renders until this fires. Restored pages would otherwise
      // appear only on the client and trip a hydration mismatch.
      onRehydrateStorage: () => (state) => state?.markHydrated(),
    }
  )
);

export const selectPage = (id: string | null) => (s: ScannerState) =>
  s.pages.find((p) => p.id === id) ?? null;

export type { Doc, Mode, Page, Quad, Settings };
