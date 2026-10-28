"use client";
import { Pause, Play } from "lucide-react";
import { useEffect, useRef, useState } from "react";

/**
 * Muted, looping product video. It plays only while on screen, never when the visitor prefers
 * reduced motion, and always has a visible pause control.
 */
export function HeroVideo({ src, poster, label }: { src: string; poster: string; label: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  const userPaused = useRef(false);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    // React doesn't apply `muted` to server-rendered video during hydration; autoplay needs it.
    v.muted = true;
    v.defaultMuted = true;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (reduce.matches) userPaused.current = true;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (!entry) return;
        if (entry.isIntersecting && !userPaused.current) v.play().catch(() => setPlaying(false));
        else if (!entry.isIntersecting) v.pause();
      },
      { threshold: 0.25 },
    );
    io.observe(v);
    return () => io.disconnect();
  }, []);

  const toggle = () => {
    const v = ref.current;
    if (!v) return;
    if (v.paused) {
      userPaused.current = false;
      v.play().catch(() => setPlaying(false));
    } else {
      userPaused.current = true;
      v.pause();
    }
  };

  return (
    <>
      <video
        ref={ref}
        className="absolute inset-0 size-full object-cover"
        src={src}
        poster={poster}
        muted
        loop
        playsInline
        preload="metadata"
        aria-label={label}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
      />
      <button
        type="button"
        onClick={toggle}
        aria-label={playing ? "Pause video" : "Play video"}
        className="absolute bottom-[5cqw] right-[5cqw] z-20 flex size-[11cqw] min-h-8 min-w-8 items-center justify-center rounded-full bg-black/45 text-white backdrop-blur-md transition-colors hover:bg-black/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
      >
        {playing ? <Pause className="size-[45%]" aria-hidden fill="currentColor" strokeWidth={0} /> : <Play className="ml-[6%] size-[45%]" aria-hidden fill="currentColor" strokeWidth={0} />}
      </button>
    </>
  );
}
