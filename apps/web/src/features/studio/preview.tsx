"use client";
import { ErrorState, IconButton, Skeleton, Spinner, cn } from "@muselaunch/ui";
import { Pause, Play, RotateCcw } from "lucide-react";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, type ReactNode } from "react";
import { fmtTime } from "./ops";

export interface PlayerHandle {
  seek: (t: number) => void;
  play: () => void;
  pause: () => void;
  toggle: () => void;
}

type HfPlayer = HTMLElement & { play(): void; pause(): void; seek(t: number): void; currentTime: number; duration: number; paused: boolean };

let playerModule: Promise<unknown> | null = null;
const loadPlayer = () => (playerModule ??= import("@hyperframes/player"));

/** Only show a loading indicator when loading takes longer than this. */
const BUSY_DELAY_MS = 300;

/**
 * Live preview of the compiled composition in the HyperFrames player (same HTML the renderer uses).
 *
 * - Edits feel in-place: a new version loads in a second, hidden player and is swapped in once its
 *   first frame is painted at the current playhead, so the previous frame stays on screen meanwhile.
 * - Until the user seeks or plays, the paused preview parks on `posterSec` (the opening hook fully
 *   on screen, the same frame as the render poster); Play from there starts at 0.
 */
export const PreviewPlayer = forwardRef<
  PlayerHandle,
  {
    html: string | null | undefined;
    width: number;
    height: number;
    durationSec: number;
    /** Where the paused preview parks before the user seeks or plays. */
    posterSec?: number;
    loading?: boolean;
    error?: string | null;
    onRetry?: () => void;
    onTime?: (t: number) => void;
    /** Drawn over the frame inside the aspect box (e.g. the SAM track overlay); not interactive. */
    overlay?: ReactNode;
    /** Compact controls for small side-by-side players. */
    compact?: boolean;
    /** Extra controls after the time readout. */
    controls?: ReactNode;
    className?: string;
  }
>(function PreviewPlayer({ html, width, height, durationSec, posterSec = 0, loading, error, onRetry, onTime, overlay, compact, controls, className }, ref) {
  const host = useRef<HTMLDivElement>(null);
  /** The visible player. */
  const el = useRef<HfPlayer | null>(null);
  /** The next version, loading hidden behind the visible one. */
  const pending = useRef<HfPlayer | null>(null);
  const timeRef = useRef(0);
  const parked = useRef(true);
  const posterRef = useRef(posterSec);
  posterRef.current = posterSec;
  const sizeRef = useRef({ width, height, durationSec });
  sizeRef.current = { width, height, durationSec };
  const busyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [moduleReady, setModuleReady] = useState(false);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const onTimeRef = useRef(onTime);
  onTimeRef.current = onTime;

  const report = useCallback((t: number) => {
    timeRef.current = t;
    setTime(t);
    onTimeRef.current?.(t);
  }, []);

  const play = useCallback(() => {
    const p = el.current;
    if (!p) return;
    if (parked.current) {
      parked.current = false;
      p.seek(0);
      report(0);
    }
    p.play();
  }, [report]);

  useImperativeHandle(ref, () => ({
    seek: (t) => {
      parked.current = false;
      report(t);
      el.current?.seek(t);
    },
    play,
    pause: () => el.current?.pause(),
    toggle: () => (el.current && !el.current.paused ? el.current.pause() : play()),
  }));

  useEffect(() => {
    let alive = true;
    loadPlayer()
      .then(() => alive && setModuleReady(true))
      .catch(() => alive && setLoadError("The preview player couldn't load."));
    return () => {
      alive = false;
      if (busyTimer.current) clearTimeout(busyTimer.current);
    };
  }, []);

  const settle = useCallback(() => {
    if (busyTimer.current) clearTimeout(busyTimer.current);
    busyTimer.current = null;
    setBusy(false);
    setReady(true);
  }, []);

  /** Make `p` the visible player (its first frame is painted at the right time). */
  const promote = useCallback(
    (p: HfPlayer) => {
      if (el.current !== p) {
        if (pending.current !== p) return; // superseded by a newer version
        const old = el.current;
        const wasPlaying = !!old && !old.paused;
        p.style.visibility = "visible";
        el.current = p;
        pending.current = null;
        old?.remove();
        if (wasPlaying) p.play();
        else setPlaying(false);
      }
      settle();
    },
    [settle],
  );

  const create = useCallback((): HfPlayer => {
    const p = document.createElement("hyperframes-player") as HfPlayer;
    Object.assign(p.style, { position: "absolute", inset: "0", width: "100%", height: "100%", display: "block" });
    // Self-hosted runtime (copied from @hyperframes/core by `pnpm vendor:runtime`); no CDN dependency.
    p.setAttribute("runtime-src", "/vendor/hyperframe.runtime.iife.js");
    // SECURITY (N3): run the composition in an opaque origin (no allow-same-origin), so even a
    // compiler escaping bug can't script the web app. The player talks to it via postMessage.
    p.setAttribute("sandbox-origin", "");
    // Our delayed indicator replaces the player's own "Loading assets" overlay.
    p.setAttribute("assets-loading-ui", "none");
    p.setAttribute("width", String(sizeRef.current.width));
    p.setAttribute("height", String(sizeRef.current.height));
    const visible = () => el.current === p;
    p.addEventListener("timeupdate", (e) => {
      if (visible()) report((e as CustomEvent<{ currentTime: number }>).detail?.currentTime ?? p.currentTime);
    });
    p.addEventListener("play", () => visible() && setPlaying(true));
    p.addEventListener("pause", () => visible() && setPlaying(false));
    p.addEventListener("ended", () => visible() && setPlaying(false));
    p.addEventListener("ready", () => {
      // Same playhead as the version it replaces (or the poster frame until the user moves it).
      const t = parked.current ? posterRef.current : timeRef.current;
      if (t > 0) p.seek(Math.min(t, Math.max(0, (p.duration || sizeRef.current.durationSec) - 0.05)));
      if (visible()) setLoadError(null);
    });
    // Two frames after the first paint so the seeked frame is on screen before the swap.
    p.addEventListener("painted", () =>
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          if (el.current === p || pending.current === p) setLoadError(null);
          promote(p);
        }),
      ),
    );
    p.addEventListener("error", (e) => {
      setLoadError((e as unknown as CustomEvent<{ message?: string }>).detail?.message ?? "The preview couldn't load.");
      if (pending.current === p) promote(p);
    });
    return p;
  }, [promote, report]);

  useEffect(() => {
    const box = host.current;
    if (!moduleReady || !box || !html) return;
    if (pending.current?.getAttribute("srcdoc") === html) return;
    if (!pending.current && el.current?.getAttribute("srcdoc") === html) return;
    pending.current?.remove();
    pending.current = null;
    const p = create();
    if (el.current) {
      p.style.visibility = "hidden";
      pending.current = p;
    } else {
      el.current = p;
    }
    box.appendChild(p);
    p.setAttribute("srcdoc", html);
    if (busyTimer.current) clearTimeout(busyTimer.current);
    busyTimer.current = setTimeout(() => setBusy(true), BUSY_DELAY_MS);
  }, [html, moduleReady, create]);

  useEffect(() => {
    for (const p of [el.current, pending.current]) {
      p?.setAttribute("width", String(width));
      p?.setAttribute("height", String(height));
    }
  }, [width, height]);

  const ratio = `${width} / ${height}`;
  const failed = error || loadError;
  return (
    <div className={cn("flex h-full min-h-0 flex-col items-center justify-center gap-3", className)}>
      <div className="relative flex min-h-0 w-full flex-1 items-center justify-center">
        <div
          className="relative max-h-full max-w-full overflow-hidden rounded-xl bg-surface shadow-float"
          style={{ aspectRatio: ratio, height: width >= height ? undefined : "100%", width: width >= height ? "100%" : undefined }}
        >
          <div ref={host} className="absolute inset-0" />
          {ready && overlay ? overlay : null}
          {!ready && !failed ? (
            loading && !html ? (
              <Skeleton className="absolute inset-0 size-full rounded-none" />
            ) : busy ? (
              <div className="absolute inset-0 grid place-items-center bg-[rgb(29_29_31/0.04)]">
                <Spinner label="Loading preview" />
              </div>
            ) : null
          ) : null}
          {ready && busy && !failed ? (
            <div className="pointer-events-none absolute right-2 top-2 z-10 flex items-center gap-1.5 rounded-full bg-[rgb(29_29_31/0.55)] px-2 py-1 text-caption text-white backdrop-blur-sm" role="status">
              <Spinner size={12} className="text-white" /> Updating
            </div>
          ) : null}
          {failed ? (
            <div className="absolute inset-0 grid place-items-center bg-surface p-4">
              <ErrorState title="Preview unavailable" message={error ?? loadError ?? undefined} onRetry={onRetry} />
            </div>
          ) : null}
        </div>
      </div>
      <div className={cn("flex items-center gap-2", compact && "gap-1")}>
        <IconButton label={playing ? "Pause" : "Play"} variant="secondary" onClick={() => (playing ? el.current?.pause() : play())} disabled={!ready}>
          {playing ? <Pause className="size-4" aria-hidden /> : <Play className="size-4" aria-hidden />}
        </IconButton>
        {compact ? null : (
          <IconButton
            label="Back to start"
            onClick={() => {
              parked.current = false;
              el.current?.seek(0);
              report(0);
            }}
            disabled={!ready}
          >
            <RotateCcw className="size-4" aria-hidden />
          </IconButton>
        )}
        <span className="tabular text-footnote text-ink-2" aria-live="off">
          {fmtTime(time)} / {fmtTime(durationSec)}
        </span>
        {controls}
      </div>
    </div>
  );
});
