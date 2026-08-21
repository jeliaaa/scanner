export type Point = [number, number];

/** Four corners in TL, TR, BR, BL order, normalised to 0..1 of the image. */
export type Quad = [Point, Point, Point, Point];

export type Mode = "color" | "gray" | "bw" | "photo";
export type PageSize = "auto" | "a4" | "letter" | "legal";

export interface Page {
  id: string;
  width: number;
  height: number;
  quad: Quad;
  /** 0 when the detector gave up and fell back to the full frame. */
  confidence: number;
  rotate: number;
  bytes: number;
  /** Per-page override; falls back to the document-wide mode when null. */
  mode: Mode | null;
}

export interface Settings {
  mode: Mode;
  strength: number;
  dpi: number;
  quality: number;
  pageSize: PageSize;
  maxMb: number | null;
  filename: string;
}

export interface ExportReport {
  bytes: number;
  quality: number;
  scale: number;
  attempts: number;
  met_target: boolean;
  pages: number;
  seconds: number;
}

export const MODE_LABELS: Record<Mode, { name: string; hint: string }> = {
  color: { name: "Colour", hint: "White paper, punchy ink" },
  gray: { name: "Greyscale", hint: "Neutral, smaller files" },
  bw: { name: "Black & white", hint: "Tiny files, sharpest text" },
  photo: { name: "Original", hint: "Straighten only, no clean-up" },
};

export const DPI_PRESETS = [
  { value: 150, label: "150", hint: "Screen" },
  { value: 200, label: "200", hint: "Standard" },
  { value: 300, label: "300", hint: "Print / OCR" },
];
