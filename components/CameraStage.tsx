"use client";

import * as React from "react";
import { detectFrame, thumbUrl } from "@/lib/api";
import { contentRect, quadToPixels, smoothQuad } from "@/lib/geometry";
import { useElementSize } from "@/lib/hooks";
import type { Quad } from "@/lib/types";
import { QuadOverlay } from "./QuadOverlay";
import {
  Button,
  IconAlert,
  IconAuto,
  IconBolt,
  IconCheck,
  IconChevronRight,
  IconImage,
  IconRefresh,
  RoundButton,
} from "./ui";

type Status = "starting" | "live" | "denied" | "unavailable";

/**
 * Detection cadence: fast enough to track the page as it moves, slow enough to
 * leave the main thread free for compositing the video.
 */
const DETECT_INTERVAL_MS = 130;
const DETECT_FRAME_PX = 480;

/** Auto-capture: the outline must sit this still for this long. */
const AUTO_HOLD_MS = 1200;
const STEADY_MOVE = 0.012;
/** A jump this big means a different page, so the next one may be captured. */
const REARM_MOVE = 0.15;
const CONFIDENT = 0.45;

const AUTO_KEY = "scanner-auto-capture";

interface Props {
  onCapture: (blob: Blob) => void | Promise<void>;
  onImport: (files: File[]) => void | Promise<void>;
  busy: boolean;
  /** Pages captured so far; drives the thumbnail and the Done button. */
  pageCount: number;
  /** The newest page, shown as the review thumbnail. */
  lastPage: { sessionId: string; id: string } | null;
  onReview: () => void;
  onDone: () => void;
  /** Shown under the switches: which document the next capture goes into. */
  topSlot?: React.ReactNode;
  /**
   * Name of the document after this one, when there is one. The finish button
   * then moves on to it instead of going to export, so a run of several
   * documents is one capture-capture-next rhythm.
   */
  nextLabel?: string | null;
  onNext?: () => void;
}

function maxMove(a: Quad, b: Quad): number {
  return Math.max(...a.map((p, i) => Math.hypot(p[0] - b[i][0], p[1] - b[i][1])));
}

function readAutoPreference(): boolean {
  try {
    return localStorage.getItem(AUTO_KEY) === "1";
  } catch {
    return false;
  }
}

export function CameraStage({
  onCapture,
  onImport,
  busy,
  pageCount,
  lastPage,
  onReview,
  onDone,
  topSlot,
  nextLabel = null,
  onNext,
}: Props) {
  const videoRef = React.useRef<HTMLVideoElement>(null);
  const streamRef = React.useRef<MediaStream | null>(null);
  const scratchRef = React.useRef<HTMLCanvasElement | null>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);

  const [boxRef, box] = useElementSize<HTMLDivElement>();
  const [status, setStatus] = React.useState<Status>("starting");
  const [error, setError] = React.useState<string | null>(null);
  const [media, setMedia] = React.useState({ w: 0, h: 0 });
  const [devices, setDevices] = React.useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = React.useState<string>("");
  const [quad, setQuad] = React.useState<Quad | null>(null);
  const [confidence, setConfidence] = React.useState(0);
  const [flash, setFlash] = React.useState(0);
  const [torch, setTorch] = React.useState({ available: false, on: false });
  const [auto, setAuto] = React.useState(readAutoPreference);

  // The detection loop is a long-lived closure, so it reads these through refs
  // rather than being torn down and restarted on every change.
  const quadRef = React.useRef<Quad | null>(null);
  const autoRef = React.useRef(auto);
  const busyRef = React.useRef(busy);
  const steadySince = React.useRef<number | null>(null);
  const armed = React.useRef(true);
  const captureRef = React.useRef<() => Promise<void>>(async () => undefined);

  React.useEffect(() => {
    autoRef.current = auto;
    busyRef.current = busy;
  }, [auto, busy]);

  const toggleAuto = () => {
    const next = !auto;
    setAuto(next);
    steadySince.current = null;
    try {
      localStorage.setItem(AUTO_KEY, next ? "1" : "0");
    } catch {
      /* private mode: the choice just will not survive a reload */
    }
  };

  /* ---------------------------- camera lifecycle ---------------------------- */

  const stop = React.useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  const start = React.useCallback(
    async (preferredId?: string) => {
      stop();

      try {
        if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
          throw Object.assign(new Error("This browser exposes no camera API. Camera access needs https, or localhost."), {
            name: "NotSupportedError",
          });
        }

        const stream = await navigator.mediaDevices.getUserMedia({
          video: preferredId
            ? { deviceId: { exact: preferredId }, width: { ideal: 3840 }, height: { ideal: 2160 } }
            : {
                // Rear camera on a phone; harmlessly ignored by a webcam.
                facingMode: { ideal: "environment" },
                width: { ideal: 3840 },
                height: { ideal: 2160 },
              },
          audio: false,
        });

        streamRef.current = stream;
        const video = videoRef.current;
        if (video) {
          video.srcObject = stream;
          await video.play().catch(() => undefined);
        }

        const track = stream.getVideoTracks()[0];
        const settings = track?.getSettings?.();
        if (settings?.deviceId) setDeviceId(settings.deviceId);

        const caps = track?.getCapabilities?.() as { torch?: boolean } | undefined;
        setTorch({ available: Boolean(caps?.torch), on: false });

        // Device labels only populate once permission is granted, so the list
        // is worth reading again now rather than before the prompt.
        const all = await navigator.mediaDevices.enumerateDevices();
        setDevices(all.filter((device) => device.kind === "videoinput"));

        setStatus("live");
      } catch (err) {
        const name = (err as DOMException)?.name;
        if (name === "NotAllowedError" || name === "SecurityError") {
          setStatus("denied");
          setError("Camera permission was declined. You can still import photos.");
        } else if (name === "NotFoundError" || name === "OverconstrainedError") {
          setStatus("unavailable");
          setError("No camera was found on this machine. Import photos instead.");
        } else {
          setStatus("unavailable");
          setError((err as Error)?.message ?? "The camera could not be started.");
        }
      }
    },
    [stop]
  );

  /** Restart from a user action, showing the transition straight away. */
  const restart = React.useCallback(
    (preferredId?: string) => {
      setStatus("starting");
      setError(null);
      void start(preferredId);
    },
    [start]
  );

  React.useEffect(() => {
    // Deferred by a tick rather than called inline: it lets the shell paint
    // before the permission prompt appears, and keeps the camera handshake out
    // of the effect body, where a synchronous state change would cascade.
    const timer = setTimeout(() => void start(), 0);
    return () => {
      clearTimeout(timer);
      stop();
    };
    // Runs once; restarts go through restart().
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleTorch = React.useCallback(async () => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    const next = !torch.on;
    try {
      // `torch` is real but absent from the DOM typings, hence the double cast.
      await track.applyConstraints({ advanced: [{ torch: next }] } as unknown as MediaTrackConstraints);
      setTorch((state) => ({ ...state, on: next }));
    } catch {
      setTorch((state) => ({ ...state, available: false }));
    }
  }, [torch.on]);

  /** Step to the next lens: front/back, or the wide and zoom lenses on a phone. */
  const nextCamera = () => {
    if (devices.length < 2) return;
    const at = devices.findIndex((device) => device.deviceId === deviceId);
    const next = devices[(at + 1) % devices.length];
    setDeviceId(next.deviceId);
    restart(next.deviceId);
  };

  /* ----------------------------- detection loop ----------------------------- */

  const grabFrame = React.useCallback(
    async (maxDim: number, quality: number): Promise<Blob | null> => {
      const video = videoRef.current;
      if (!video?.videoWidth) return null;

      const scale = Math.min(1, maxDim / Math.max(video.videoWidth, video.videoHeight));
      const w = Math.round(video.videoWidth * scale);
      const h = Math.round(video.videoHeight * scale);

      const canvas = (scratchRef.current ??= document.createElement("canvas"));
      canvas.width = w;
      canvas.height = h;
      canvas.getContext("2d")?.drawImage(video, 0, 0, w, h);

      return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
    },
    []
  );

  React.useEffect(() => {
    if (status !== "live") return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();

    const tick = async () => {
      if (cancelled) return;
      const video = videoRef.current;

      if (video?.videoWidth) {
        setMedia((current) =>
          current.w === video.videoWidth && current.h === video.videoHeight
            ? current
            : { w: video.videoWidth, h: video.videoHeight }
        );

        try {
          const frame = await grabFrame(DETECT_FRAME_PX, 0.6);
          if (frame && !cancelled) {
            const result = await detectFrame(frame, controller.signal);
            if (!cancelled) {
              setConfidence(result.confidence);

              // Smoothing stops the outline twitching frame to frame; a large
              // move means a different page, and that snaps instead.
              const prev = quadRef.current;
              const next = result.confidence > 0 ? smoothQuad(prev, result.quad) : null;
              quadRef.current = next;
              setQuad(next);

              // Auto-capture: fire once the outline has held still, then stay
              // quiet until the page leaves or a different one arrives, so one
              // sheet is never captured twice in a row.
              if (!next) {
                armed.current = true;
                steadySince.current = null;
              } else if (prev && maxMove(prev, next) > REARM_MOVE) {
                armed.current = true;
                steadySince.current = null;
              } else if (autoRef.current && armed.current && !busyRef.current && result.confidence > CONFIDENT) {
                const now = performance.now();
                if (!prev || maxMove(prev, next) > STEADY_MOVE) steadySince.current = now;
                else steadySince.current ??= now;

                if (now - steadySince.current >= AUTO_HOLD_MS) {
                  armed.current = false;
                  steadySince.current = null;
                  void captureRef.current();
                }
              } else {
                steadySince.current = null;
              }
            }
          }
        } catch {
          /* a dropped frame is not worth reporting; the next one will land */
        }
      }

      if (!cancelled) timer = setTimeout(tick, DETECT_INTERVAL_MS);
    };

    void tick();
    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [status, grabFrame]);

  /* -------------------------------- capture -------------------------------- */

  const capture = React.useCallback(async () => {
    if (busy) return;
    // Full sensor resolution: this frame is the archival one, and everything
    // the export does later is a crop or a downscale of it.
    const blob = await grabFrame(4096, 0.95);
    if (!blob) return;
    setFlash((n) => n + 1);
    // A short buzz confirms the capture when the screen is hard to see.
    navigator.vibrate?.(18);
    await onCapture(blob);
  }, [busy, grabFrame, onCapture]);

  React.useEffect(() => {
    captureRef.current = capture;
  }, [capture]);

  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const typing = (event.target as HTMLElement)?.closest("input, textarea, select, button");
      if (event.code === "Space" && status === "live" && !busy && !typing) {
        event.preventDefault();
        void capture();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [capture, status, busy]);

  /* --------------------------------- render -------------------------------- */

  const rect = contentRect(box.w, box.h, media.w, media.h);
  const colour =
    confidence > CONFIDENT
      ? "var(--color-scan-500)"
      : confidence > 0
        ? "var(--color-warn-500)"
        : "var(--color-mute)";

  const live = status === "live";
  const offline = status === "denied" || status === "unavailable";

  const statusText =
    confidence > CONFIDENT
      ? auto
        ? "Hold steady — capturing…"
        : "Page found — tap to capture"
      : confidence > 0
        ? "Edges unclear — add contrast or move back"
        : "Looking for a page…";

  return (
    <div ref={boxRef} className="relative h-full overflow-hidden bg-black lg:rounded-xl lg:ring-1 lg:ring-ink-700">
      <video
        ref={videoRef}
        playsInline
        muted
        autoPlay
        className={`h-full w-full object-contain ${live ? "opacity-100" : "opacity-0"}`}
      />

      {live && quad && rect.w > 0 && (
        <QuadOverlay quad={quadToPixels(quad, rect)} width={box.w} height={box.h} color={colour} />
      )}

      {flash > 0 && <div key={flash} className="shutter-flash pointer-events-none absolute inset-0 bg-white" />}

      {/* Top: the few switches that matter, then one line of plain status. */}
      <div
        // Tailwind only emits classes it can read in full, so the landscape
        // variants below are spelled out rather than assembled from a constant.
        className="pointer-events-none absolute inset-x-0 top-0 flex flex-col items-center gap-3 px-4
          pt-[max(0.75rem,env(safe-area-inset-top))] [@media(max-height:500px)]:pr-36"
      >
        <div className="pointer-events-auto flex w-full items-center gap-2.5">
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(event) => {
              const files = Array.from(event.target.files ?? []);
              event.target.value = "";
              if (files.length) void onImport(files);
            }}
          />
          <RoundButton aria-label="Import photos" onClick={() => fileRef.current?.click()} disabled={busy}>
            <IconImage />
          </RoundButton>

          <div className="flex-1" />

          <button
            type="button"
            aria-pressed={auto}
            onClick={toggleAuto}
            title="Capture automatically when the page is steady"
            className={`flex h-11 items-center gap-2 rounded-full px-4 text-sm font-semibold backdrop-blur-sm
              transition-colors active:scale-95 focus-visible:outline focus-visible:outline-2
              focus-visible:outline-offset-2 focus-visible:outline-scan-500 ${
                auto
                  ? "bg-scan-500/20 text-scan-400 ring-1 ring-scan-500"
                  : "bg-ink-950/65 text-text hover:bg-ink-800/80"
              }`}
          >
            <IconAuto className="text-lg" />
            Auto
          </button>

          {live && torch.available && (
            <RoundButton aria-label="Torch" active={torch.on} onClick={() => void toggleTorch()}>
              <IconBolt />
            </RoundButton>
          )}

          {live && devices.length > 1 && (
            <RoundButton aria-label="Switch camera" onClick={nextCamera}>
              <IconRefresh />
            </RoundButton>
          )}
        </div>

        {topSlot}

        {live && (
          <span
            className="rounded-full bg-ink-950/75 px-4 py-2 text-sm font-medium backdrop-blur-sm"
            style={{ color: colour }}
          >
            {statusText}
          </span>
        )}
      </div>

      {status === "starting" && (
        <Centered>
          <div className="relative h-12 w-12 overflow-hidden rounded-md ring-1 ring-ink-600">
            <div className="scan-sweep absolute inset-x-0 h-1/3 bg-scan-500/60" />
          </div>
          <p className="text-sm text-mute">Starting camera…</p>
        </Centered>
      )}

      {offline && (
        <Centered>
          <IconAlert className="text-2xl text-warn-500" />
          <p className="max-w-xs text-center text-sm text-mute">{error}</p>
          <div className="flex flex-wrap justify-center gap-2">
            <Button variant="outline" onClick={() => restart(deviceId || undefined)}>
              <IconRefresh /> Try the camera again
            </Button>
            <Button variant="primary" onClick={() => fileRef.current?.click()} disabled={busy}>
              <IconImage /> Import photos
            </Button>
          </div>
        </Centered>
      )}

      {/* Bottom: shutter dead centre, review on the left, finish on the right.
          All of it sits in the thumb zone. In landscape it becomes a column on
          the right edge, where the right thumb already rests. */}
      <div
        className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-ink-950 via-ink-950/70 to-transparent
          px-6 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-14
          [@media(max-height:500px)]:inset-x-auto [@media(max-height:500px)]:inset-y-0
          [@media(max-height:500px)]:right-0 [@media(max-height:500px)]:w-36
          [@media(max-height:500px)]:bg-gradient-to-l [@media(max-height:500px)]:px-4
          [@media(max-height:500px)]:py-4 [@media(max-height:500px)]:pr-[max(1rem,env(safe-area-inset-right))]"
      >
        <div className="flex items-center justify-between [@media(max-height:500px)]:h-full [@media(max-height:500px)]:flex-col">
          {pageCount > 0 && lastPage ? (
            <button
              type="button"
              onClick={onReview}
              aria-label={`Review ${pageCount} captured page${pageCount > 1 ? "s" : ""}`}
              className="relative h-[76px] w-[60px] shrink-0 rounded-[10px] border-2 border-ink-500 bg-ink-800
                transition-transform active:scale-95 focus-visible:outline focus-visible:outline-2
                focus-visible:outline-offset-2 focus-visible:outline-scan-500"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={thumbUrl(lastPage.sessionId, lastPage.id)}
                alt=""
                className="h-full w-full rounded-lg object-cover"
              />
              <span
                className="absolute -right-2 -top-2 grid h-6 min-w-6 place-items-center rounded-full bg-scan-500
                  px-1.5 text-[13px] font-bold tabular-nums text-ink-950"
              >
                {pageCount}
              </span>
            </button>
          ) : (
            <span className="h-[60px] w-[60px] shrink-0" aria-hidden="true" />
          )}

          <button
            type="button"
            onClick={() => void capture()}
            disabled={!live || busy}
            aria-label="Capture this page"
            title="Capture this page (Space)"
            className="group relative grid h-[84px] w-[84px] shrink-0 place-items-center rounded-full border-[3px]
              border-ink-500 transition-transform disabled:opacity-40 enabled:active:scale-95
              focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2
              focus-visible:outline-scan-500 enabled:hover:border-scan-500"
          >
            <span className="absolute inset-[5px] rounded-full bg-text transition-colors group-enabled:group-hover:bg-scan-400" />
          </button>

          {pageCount > 0 ? (
            <button
              type="button"
              onClick={nextLabel && onNext ? onNext : onDone}
              aria-label={nextLabel ? `Next document: ${nextLabel}` : "Done scanning, continue to export"}
              className="grid h-[60px] w-[60px] shrink-0 place-items-center rounded-full bg-scan-500 text-3xl
                text-ink-950 transition-transform hover:bg-scan-400 active:scale-95 focus-visible:outline
                focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-scan-500"
            >
              {nextLabel ? <IconChevronRight /> : <IconCheck />}
            </button>
          ) : (
            <span className="h-[60px] w-[60px] shrink-0" aria-hidden="true" />
          )}
        </div>

        <p className="mt-3.5 text-center text-[13px] text-mute [@media(max-height:500px)]:hidden">
          {pageCount > 0
            ? nextLabel
              ? `Tap › when this document is done. Next: ${nextLabel}`
              : "Keep capturing — pages stack up. Tap the thumbnail to review."
            : "Point at a page and tap the shutter"}
        </p>
      </div>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  // Click-through except for its own contents: it fills the whole viewfinder,
  // and without this it would sit on top of the controls along the top edge.
  return (
    <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 [&>*]:pointer-events-auto">
      {children}
    </div>
  );
}
