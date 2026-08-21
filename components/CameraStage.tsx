"use client";

import * as React from "react";
import { detectFrame } from "@/lib/api";
import { contentRect, quadToPixels, smoothQuad } from "@/lib/geometry";
import { useElementSize } from "@/lib/hooks";
import type { Quad } from "@/lib/types";
import { QuadOverlay } from "./QuadOverlay";
import { Button, IconAlert, IconCamera, IconRefresh, IconUpload } from "./ui";

type Status = "starting" | "live" | "denied" | "unavailable";

/**
 * Detection cadence: fast enough to track the page as it moves, slow enough to
 * leave the main thread free for compositing the video.
 */
const DETECT_INTERVAL_MS = 130;
const DETECT_FRAME_PX = 480;

interface Props {
  onCapture: (blob: Blob) => void | Promise<void>;
  onImport: (files: File[]) => void | Promise<void>;
  busy: boolean;
}

export function CameraStage({ onCapture, onImport, busy }: Props) {
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
              setQuad((prev) => (result.confidence > 0 ? smoothQuad(prev, result.quad) : null));
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
    await onCapture(blob);
  }, [busy, grabFrame, onCapture]);

  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const typing = (event.target as HTMLElement)?.closest("input, textarea, select");
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
    confidence > 0.45
      ? "var(--color-scan-500)"
      : confidence > 0
        ? "var(--color-warn-500)"
        : "var(--color-mute)";

  const live = status === "live";
  const offline = status === "denied" || status === "unavailable";

  return (
    <div className="flex h-full flex-col gap-3">
      <div ref={boxRef} className="relative flex-1 overflow-hidden rounded-xl bg-ink-900 ring-1 ring-ink-700">
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

        {live && (
          <div className="pointer-events-none absolute inset-x-0 top-0 flex justify-center p-3">
            <span
              className="rounded-full bg-ink-950/75 px-3 py-1.5 text-xs font-medium backdrop-blur-sm"
              style={{ color: colour }}
            >
              {confidence > 0.45
                ? "Page detected — hold steady"
                : confidence > 0
                  ? "Edges unclear — add contrast or move back"
                  : "Looking for a page…"}
            </span>
          </div>
        )}

        {flash > 0 && (
          <div key={flash} className="shutter-flash pointer-events-none absolute inset-0 bg-white" />
        )}

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
            <Button variant="outline" onClick={() => restart(deviceId || undefined)}>
              <IconRefresh /> Try the camera again
            </Button>
          </Centered>
        )}
      </div>

      <div className="flex items-center gap-2">
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

        <Button variant="outline" onClick={() => fileRef.current?.click()} disabled={busy}>
          <IconUpload /> Import
        </Button>

        {live && devices.length > 1 && (
          <select
            value={deviceId}
            onChange={(event) => {
              setDeviceId(event.target.value);
              restart(event.target.value);
            }}
            className="max-w-40 truncate rounded-lg border border-ink-600 bg-ink-850 px-2 py-2 text-xs
              text-mute focus:border-scan-600 focus:outline-none"
          >
            {devices.map((device, i) => (
              <option key={device.deviceId} value={device.deviceId}>
                {device.label || `Camera ${i + 1}`}
              </option>
            ))}
          </select>
        )}

        {live && torch.available && (
          <Button variant={torch.on ? "primary" : "outline"} onClick={() => void toggleTorch()}>
            Torch
          </Button>
        )}

        <div className="flex-1" />

        <button
          type="button"
          onClick={() => void capture()}
          disabled={!live || busy}
          title="Capture this page (Space)"
          className="group relative grid h-16 w-16 place-items-center rounded-full ring-2 ring-ink-500
            transition-transform disabled:opacity-40 enabled:hover:ring-scan-500 enabled:active:scale-95"
        >
          <span className="absolute inset-1.5 rounded-full bg-text transition-colors group-enabled:group-hover:bg-scan-400" />
          <IconCamera className="relative text-xl text-ink-950" />
        </button>
      </div>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6">{children}</div>;
}
