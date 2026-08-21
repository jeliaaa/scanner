"use client";

import * as React from "react";

type Variant = "primary" | "ghost" | "outline" | "danger";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-scan-500 text-ink-950 hover:bg-scan-400 disabled:bg-ink-600 disabled:text-mute",
  ghost: "bg-ink-800/70 text-text hover:bg-ink-700 disabled:text-mute",
  outline: "border border-ink-600 text-text hover:bg-ink-800 hover:border-ink-500 disabled:text-mute",
  danger: "bg-ink-800/70 text-bad-500 hover:bg-bad-500/15 hover:text-bad-500",
};

export function Button({
  variant = "ghost",
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      {...props}
      className={`inline-flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium
        transition-colors disabled:cursor-not-allowed disabled:opacity-60
        focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2
        focus-visible:outline-scan-500 ${VARIANTS[variant]} ${className}`}
    />
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium tracking-wide text-mute uppercase">{label}</span>
        {hint && <span className="text-[11px] tabular-nums text-mute/80">{hint}</span>}
      </div>
      {children}
    </label>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  className = "",
}: {
  value: T;
  options: { value: T; label: string; title?: string }[];
  onChange: (v: T) => void;
  className?: string;
}) {
  return (
    <div className={`flex rounded-lg bg-ink-850 p-0.5 ${className}`}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          title={o.title}
          onClick={() => onChange(o.value)}
          className={`flex-1 rounded-[6px] px-2 py-1.5 text-xs font-medium transition-colors ${
            value === o.value ? "bg-ink-600 text-text shadow-sm" : "text-mute hover:text-text"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export const formatBytes = (n: number) =>
  n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} kB`;

/* --- icons: 24x24 stroked, sized by the parent's font-size --- */

const icon = (path: React.ReactNode, extra?: React.SVGProps<SVGSVGElement>) =>
  function Icon(props: React.SVGProps<SVGSVGElement>) {
    return (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.7}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        width="1em"
        height="1em"
        {...extra}
        {...props}
      >
        {path}
      </svg>
    );
  };

export const IconCamera = icon(
  <>
    <path d="M3 8.5A2.5 2.5 0 0 1 5.5 6h1.2a2 2 0 0 0 1.7-.95l.5-.8A2 2 0 0 1 10.6 3h2.8a2 2 0 0 1 1.7 1.25l.5.8A2 2 0 0 0 17.3 6h1.2A2.5 2.5 0 0 1 21 8.5v9A2.5 2.5 0 0 1 18.5 20h-13A2.5 2.5 0 0 1 3 17.5z" />
    <circle cx="12" cy="13" r="3.6" />
  </>
);

export const IconUpload = icon(
  <>
    <path d="M12 16V4m0 0L8 8m4-4 4 4" />
    <path d="M4 15v3a2.5 2.5 0 0 0 2.5 2.5h11A2.5 2.5 0 0 0 20 18v-3" />
  </>
);

export const IconRotate = icon(
  <>
    <path d="M20 11a8 8 0 1 0-2.3 6.3" />
    <path d="M20 5v6h-6" />
  </>
);

export const IconTrash = icon(
  <>
    <path d="M4 7h16M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7" />
    <path d="M6 7l.8 12.1A2 2 0 0 0 8.8 21h6.4a2 2 0 0 0 2-1.9L18 7" />
  </>
);

export const IconDownload = icon(
  <>
    <path d="M12 4v11m0 0 4-4m-4 4-4-4" />
    <path d="M4 16v2a2.5 2.5 0 0 0 2.5 2.5h11A2.5 2.5 0 0 0 20 18v-2" />
  </>
);

export const IconCrop = icon(
  <>
    <path d="M6 2v14a2 2 0 0 0 2 2h14" />
    <path d="M2 6h14a2 2 0 0 1 2 2v14" />
  </>
);

export const IconWand = icon(
  <>
    <path d="m14 6 4 4L8 20l-4-4z" />
    <path d="m16 4 .8 2.2L19 7l-2.2.8L16 10l-.8-2.2L13 7l2.2-.8z" />
  </>
);

export const IconRefresh = icon(
  <>
    <path d="M20 11A8 8 0 0 0 6.3 6.3L4 8.5" />
    <path d="M4 13a8 8 0 0 0 13.7 4.7L20 15.5" />
    <path d="M4 4v4.5h4.5M20 20v-4.5h-4.5" />
  </>
);

export const IconCheck = icon(<path d="m5 12.5 4.5 4.5L19 7" />);

export const IconX = icon(<path d="M6 6l12 12M18 6 6 18" />);

export const IconPlus = icon(<path d="M12 5v14M5 12h14" />);

export const IconChevronLeft = icon(<path d="m14 6-6 6 6 6" />);
export const IconChevronRight = icon(<path d="m10 6 6 6-6 6" />);

export const IconAlert = icon(
  <>
    <path d="M12 8v5" />
    <path d="M12 16.5h.01" />
    <path d="M10.3 3.9 2.6 17.2A2 2 0 0 0 4.3 20.2h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
  </>
);

export const IconLayers = icon(
  <>
    <path d="m12 3 9 5-9 5-9-5z" />
    <path d="m3 13 9 5 9-5" />
  </>
);
