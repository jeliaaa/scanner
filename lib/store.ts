"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Mode, Page, Quad, Settings } from "./types";

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

interface ScannerState {
  sessionId: string;
  pages: Page[];
  selectedId: string | null;
  settings: Settings;
  hydrated: boolean;

  ensureSession: () => string;
  addPage: (page: Page) => void;
  updatePage: (id: string, patch: Partial<Page>) => void;
  removePage: (id: string) => void;
  movePage: (id: string, delta: number) => void;
  select: (id: string | null) => void;
  setSettings: (patch: Partial<Settings>) => void;
  reset: () => void;
  markHydrated: () => void;
}

export const useScanner = create<ScannerState>()(
  persist(
    (set, get) => ({
      sessionId: "",
      pages: [],
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

      addPage: (page) => set((s) => ({ pages: [...s.pages, page], selectedId: page.id })),

      updatePage: (id, patch) =>
        set((s) => ({ pages: s.pages.map((p) => (p.id === id ? { ...p, ...patch } : p)) })),

      removePage: (id) =>
        set((s) => {
          const index = s.pages.findIndex((p) => p.id === id);
          const pages = s.pages.filter((p) => p.id !== id);
          // Keep a neighbour selected so the stage does not blank out.
          const next = pages[Math.min(index, pages.length - 1)] ?? null;
          return { pages, selectedId: s.selectedId === id ? next?.id ?? null : s.selectedId };
        }),

      movePage: (id, delta) =>
        set((s) => {
          const from = s.pages.findIndex((p) => p.id === id);
          const to = from + delta;
          if (from < 0 || to < 0 || to >= s.pages.length) return s;
          const pages = [...s.pages];
          [pages[from], pages[to]] = [pages[to], pages[from]];
          return { pages };
        }),

      select: (id) => set({ selectedId: id }),

      setSettings: (patch) => set((s) => ({ settings: { ...s.settings, ...patch } })),

      reset: () =>
        set({ pages: [], selectedId: null, settings: { ...DEFAULT_SETTINGS, filename: `Scan ${today()}.pdf` } }),

      markHydrated: () => set({ hydrated: true }),
    }),
    {
      name: "scanner-session",
      partialize: (s) => ({ sessionId: s.sessionId, pages: s.pages, settings: s.settings }),
      // Nothing renders until this fires. Restored pages would otherwise
      // appear only on the client and trip a hydration mismatch.
      onRehydrateStorage: () => (state) => state?.markHydrated(),
    }
  )
);

export const selectPage = (id: string | null) => (s: ScannerState) =>
  s.pages.find((p) => p.id === id) ?? null;

export type { Mode, Page, Quad, Settings };
