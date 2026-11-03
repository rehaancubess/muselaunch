"use client";
/**
 * Slides, shown the way they'll be seen: a horizontal, swipeable strip on phones (scroll-snap, one
 * slide at a time, a counter and dots) and a grid on wider screens (`layout="auto"`), or always a
 * strip (`layout="strip"`, Home's post card). Every image is the real final render, fetched through
 * the same signed asset URLs the rest of the app uses. Keyboard: the strip is focusable and the
 * arrow keys move between slides; each slide has its own label ("Slide 3 of 6").
 */
import { Skeleton, cn } from "@muselaunch/ui";
import { ChevronLeft, ChevronRight, ImageOff } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useAssetUrl } from "@/components/app-icon";
import { useWorkspace } from "@/lib/workspace";

/** Tailwind aspect class for a frame (the stills MuseLaunch makes, and videos). */
export function frameClass(width?: number, height?: number, fallback = "aspect-[4/5]"): string {
  if (!width || !height) return fallback;
  const r = width / height;
  const near = (x: number) => Math.abs(r - x) < 0.02;
  if (near(16 / 9)) return "aspect-video";
  if (near(1)) return "aspect-square";
  if (near(4 / 5)) return "aspect-[4/5]";
  if (near(1290 / 2796)) return "aspect-[1290/2796]";
  if (near(9 / 16)) return "aspect-[9/16]";
  return fallback;
}

/** One slide's real image (or a quiet placeholder while it loads / if it's gone). */
export function SlideImage({ assetId, alt, className, eager }: { assetId: string; alt: string; className?: string; eager?: boolean }) {
  const { workspaceId } = useWorkspace();
  const url = useAssetUrl(workspaceId, assetId);
  if (url.isLoading) return <Skeleton className={cn("size-full rounded-none", className)} />;
  if (!url.data?.url)
    return (
      <span className={cn("flex size-full items-center justify-center bg-mist text-ink-3", className)} role="img" aria-label={`${alt} (not available)`}>
        <ImageOff className="size-5" aria-hidden />
      </span>
    );
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={url.data.url} alt={alt} className={cn("size-full object-cover", className)} loading={eager ? "eager" : "lazy"} draggable={false} />;
}

export function SlideGallery({
  assetIds,
  width,
  height,
  title,
  layout = "auto",
  className,
  slideClassName,
  compact,
}: {
  assetIds: string[];
  width?: number;
  height?: number;
  /** What the slides are of ("Calm focus"): used in each slide's label. */
  title: string;
  /** auto: strip on phones, grid from `sm`; strip: always a strip (one slide in view). */
  layout?: "auto" | "strip";
  className?: string;
  /** Extra classes for each slide (e.g. a fixed width in a strip). */
  slideClassName?: string;
  /** Small spaces (Home's post card): the counter sits on the image ("2 / 6") and the dots show from `sm`. */
  compact?: boolean;
}) {
  const strip = useRef<HTMLOListElement>(null);
  const [index, setIndex] = useState(0);
  const n = assetIds.length;
  const aspect = frameClass(width, height);
  const wide = (width ?? 0) > (height ?? 0);

  // The slide in view: the one whose centre is closest to the strip's centre.
  const onScroll = useCallback(() => {
    const el = strip.current;
    if (!el) return;
    const mid = el.scrollLeft + el.clientWidth / 2;
    let best = 0;
    let bestD = Infinity;
    [...el.children].forEach((c, i) => {
      const li = c as HTMLElement;
      const d = Math.abs(li.offsetLeft + li.offsetWidth / 2 - mid);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    setIndex(best);
  }, []);
  useEffect(() => {
    setIndex(0);
    strip.current?.scrollTo({ left: 0 });
  }, [assetIds.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps -- a new set of slides starts at the first

  const go = (i: number) => {
    const el = strip.current;
    const li = el?.children[Math.max(0, Math.min(n - 1, i))] as HTMLElement | undefined;
    if (!el || !li) return;
    el.scrollTo({ left: li.offsetLeft - (el.clientWidth - li.offsetWidth) / 2, behavior: "smooth" });
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowRight") {
      e.preventDefault();
      go(index + 1);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      go(index - 1);
    }
  };

  const gridFrom = layout === "auto";
  return (
    <div className={cn("min-w-0", className)}>
      <div className="relative">
        <ol
          ref={strip}
          onScroll={onScroll}
          onKeyDown={onKey}
          tabIndex={0}
          aria-label={`${title}: ${n} slide${n === 1 ? "" : "s"}`}
          className={cn(
            "flex snap-x snap-mandatory gap-3 overflow-x-auto overscroll-x-contain rounded-xl [scrollbar-width:none] focus-visible:outline-none focus-visible:shadow-focus [&::-webkit-scrollbar]:hidden",
            gridFrom && (wide ? "sm:grid sm:snap-none sm:grid-cols-2 sm:overflow-visible lg:grid-cols-3" : "sm:grid sm:snap-none sm:grid-cols-[repeat(auto-fill,minmax(150px,1fr))] sm:overflow-visible"),
          )}
        >
          {assetIds.map((id, i) => (
            <li
              key={id}
              aria-label={`Slide ${i + 1} of ${n}`}
              className={cn("relative shrink-0 snap-center overflow-hidden rounded-xl bg-mist shadow-raised", aspect, n > 1 ? (wide ? "w-[86%]" : "w-[72%]") : "w-full", gridFrom && "sm:w-auto", slideClassName)}
            >
              <SlideImage assetId={id} alt={`${title}, slide ${i + 1} of ${n}`} eager={i < 2} />
              {n > 1 && !compact ? <span className="absolute left-2 top-2 rounded-full bg-black/55 px-2 py-0.5 text-[11px] font-semibold tabular text-white backdrop-blur-sm">{i + 1}</span> : null}
            </li>
          ))}
        </ol>
        {n > 1 && compact ? (
          <span className="pointer-events-none absolute right-1.5 top-1.5 rounded-full bg-black/55 px-1.5 py-0.5 text-[11px] font-semibold tabular text-white backdrop-blur-sm" aria-live="polite">
            {index + 1}/{n}
          </span>
        ) : null}
        {n > 1 && !compact ? (
          <>
            <button
              type="button"
              aria-label="Previous slide"
              onClick={() => go(index - 1)}
              disabled={index === 0}
              className={cn("absolute left-2 top-1/2 hidden size-9 -translate-y-1/2 items-center justify-center rounded-full bg-white/90 text-ink shadow-raised backdrop-blur transition-opacity hover:bg-white disabled:opacity-0 md:flex", gridFrom && "sm:!hidden")}
            >
              <ChevronLeft className="size-4" aria-hidden />
            </button>
            <button
              type="button"
              aria-label="Next slide"
              onClick={() => go(index + 1)}
              disabled={index === n - 1}
              className={cn("absolute right-2 top-1/2 hidden size-9 -translate-y-1/2 items-center justify-center rounded-full bg-white/90 text-ink shadow-raised backdrop-blur transition-opacity hover:bg-white disabled:opacity-0 md:flex", gridFrom && "sm:!hidden")}
            >
              <ChevronRight className="size-4" aria-hidden />
            </button>
          </>
        ) : null}
      </div>
      {n > 1 ? (
        <div className={cn("mt-2.5 flex items-center justify-center gap-3", gridFrom && "sm:hidden", compact && "hidden sm:flex")}>
          <div className="flex items-center gap-1.5" aria-hidden>
            {assetIds.map((id, i) => (
              <span key={id} className={cn("h-1.5 rounded-full transition-[width,background-color] duration-200", i === index ? "w-4 bg-ink" : "w-1.5 bg-ink/20")} />
            ))}
          </div>
          {compact ? null : (
            <span className="text-caption font-medium tabular text-ink-2" aria-live="polite">
              {index + 1} / {n}
            </span>
          )}
        </div>
      ) : null}
    </div>
  );
}
