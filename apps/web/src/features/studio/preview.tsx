"use client";
import { ErrorState, IconButton, Skeleton, Spinner, cn } from "@muselaunch/ui";
import { Pause, Play, RotateCcw } from "lucide-react";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
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

/**
 * Live preview of the compiled composition in the HyperFrames player (same HTML the renderer uses).
 * Keeps the playhead across recompiles so edits feel in-place.
 */
export const PreviewPlayer = forwardRef<
  PlayerHandle,
  { html: string | null | undefined; width: number; height: number; durationSec: number; loading?: boolean; error?: string | null; onRetry?: () => void; onTime?: (t: number) => void; className?: string }
>(function PreviewPlayer({ html, width, height, durationSec, loading, error, onRetry, onTime, className }, ref) {
  const host = useRef<HTMLDivElement>(null);
  const el = useRef<HfPlayer | null>(null);
  const timeRef = useRef(0);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const onTimeRef = useRef(onTime);
  onTimeRef.current = onTime;

  useImperativeHandle(ref, () => ({
    seek: (t) => {
      timeRef.current = t;
      setTime(t);
      el.current?.seek(t);
      onTimeRef.current?.(t);
    },
    play: () => el.current?.play(),
    pause: () => el.current?.pause(),
    toggle: () => (el.current?.paused === false ? el.current.pause() : el.current?.play()),
  }));

  // Create the custom element once.
  useEffect(() => {
    let alive = true;
    loadPlayer()
      .then(() => {
        if (!alive || !host.current || el.current) return;
        const p = document.createElement("hyperframes-player") as HfPlayer;
        p.style.width = "100%";
        p.style.height = "100%";
        p.style.display = "block";
        // Self-hosted runtime (copied from @hyperframes/core by `pnpm vendor:runtime`); no CDN dependency.
        p.setAttribute("runtime-src", "/vendor/hyperframe.runtime.iife.js");
        p.addEventListener("timeupdate", (e) => {
          const t = (e as CustomEvent<{ currentTime: number }>).detail?.currentTime ?? p.currentTime;
          timeRef.current = t;
          setTime(t);
          onTimeRef.current?.(t);
        });
        p.addEventListener("play", () => setPlaying(true));
        p.addEventListener("pause", () => setPlaying(false));
        p.addEventListener("ended", () => setPlaying(false));
        p.addEventListener("ready", () => {
          setReady(true);
          setLoadError(null);
          if (timeRef.current > 0) p.seek(Math.min(timeRef.current, Math.max(0, (p.duration || durationSec) - 0.05)));
        });
        p.addEventListener("error", (e) => setLoadError((e as unknown as CustomEvent<{ message?: string }>).detail?.message ?? "The preview couldn't load."));
        host.current.appendChild(p);
        el.current = p;
        if (html) p.setAttribute("srcdoc", html);
      })
      .catch(() => alive && setLoadError("The preview player couldn't load."));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const p = el.current;
    if (!p) return;
    p.setAttribute("width", String(width));
    p.setAttribute("height", String(height));
  }, [width, height, ready]);

  useEffect(() => {
    const p = el.current;
    if (!p || !html) return;
    if (p.getAttribute("srcdoc") === html) return;
    setReady(false);
    setPlaying(false);
    p.setAttribute("srcdoc", html);
  }, [html]);

  const ratio = `${width} / ${height}`;
  return (
    <div className={cn("flex h-full min-h-0 flex-col items-center justify-center gap-3", className)}>
      <div className="relative flex min-h-0 w-full flex-1 items-center justify-center">
        <div
          className="relative max-h-full max-w-full overflow-hidden rounded-xl bg-surface shadow-float"
          style={{ aspectRatio: ratio, height: width >= height ? undefined : "100%", width: width >= height ? "100%" : undefined }}
        >
          <div ref={host} className="absolute inset-0" />
          {(loading && !html) || (!ready && html && !loadError) ? (
            <div className="absolute inset-0 grid place-items-center bg-[rgb(29_29_31/0.04)]">{html ? <Spinner /> : <Skeleton className="size-full rounded-none" />}</div>
          ) : null}
          {error || loadError ? (
            <div className="absolute inset-0 grid place-items-center bg-surface p-4">
              <ErrorState title="Preview unavailable" message={error ?? loadError ?? undefined} onRetry={onRetry} />
            </div>
          ) : null}
        </div>
      </div>
      <div className="flex items-center gap-2">
        <IconButton label={playing ? "Pause" : "Play"} variant="secondary" onClick={() => (playing ? el.current?.pause() : el.current?.play())} disabled={!ready}>
          {playing ? <Pause className="size-4" aria-hidden /> : <Play className="size-4" aria-hidden />}
        </IconButton>
        <IconButton label="Back to start" onClick={() => el.current?.seek(0)} disabled={!ready}>
          <RotateCcw className="size-4" aria-hidden />
        </IconButton>
        <span className="tabular text-footnote text-ink-2" aria-live="off">
          {fmtTime(time)} / {fmtTime(durationSec)}
        </span>
      </div>
    </div>
  );
});
