"use client";
/**
 * Simple Studio: the video's scenes as a strip of small pictures (for stills: the slides). Tapping one
 * scopes the next change to that scene or slide (scene-scoped AI edit) and parks the preview on it;
 * tapping it again goes back to the whole video (all slides). Each picture is a sketch drawn from the
 * scene's own layers (background, text, device, media boxes); when Spark has watched the render of
 * this exact version, or a still render of it exists, its real image is shown.
 */
import { cn } from "@muselaunch/ui";
import { useMemo } from "react";
import { SlideImage } from "@/components/creator/slide-gallery";
import { sceneAt, sceneStarts } from "./ops";
import { isStillDoc, wholeLabel } from "./stills";
import type { CompositionDoc, Layer, Scene } from "./types";

type Theme = CompositionDoc["theme"];
type Color = string | undefined;

const THEME_KEYS = { "theme.background": "background", "theme.surface": "surface", "theme.text": "text", "theme.textMuted": "textMuted", "theme.accent": "accent", "theme.accent2": "accent2" } as const;

function color(c: Color, theme: Theme, fallback: string): string {
  if (!c) return fallback;
  const key = THEME_KEYS[c as keyof typeof THEME_KEYS];
  return key ? ((theme[key] as string | undefined) ?? fallback) : c;
}

function background(scene: Scene, theme: Theme): string {
  const b = scene.background;
  if (b.kind === "gradient" && b.colors?.length) return `linear-gradient(${b.angle}deg, ${b.colors.map((c) => color(c, theme, theme.background)).join(", ")})`;
  return color(b.color, theme, b.kind === "solid" ? theme.background : theme.surface);
}

/** Where a scene looks "settled": its main layers have finished entering. */
export function settledAt(scene: Scene): number {
  let t = 0.4;
  for (const l of scene.layers) {
    if (l.hidden || (l.type !== "text" && l.type !== "device")) continue;
    const e = l.animation.enter;
    t = Math.max(t, l.timing.start + (e ? e.delaySec + e.durationSec : 0) + 0.15);
  }
  return Math.min(Math.max(0, scene.durationSec - 0.05), t);
}

function LayerSketch({ layer, theme, scale }: { layer: Layer; theme: Theme; scale: number }) {
  const b = layer.box;
  const style = { left: `${b.x * 100}%`, top: `${b.y * 100}%`, width: `${b.w * 100}%`, height: `${b.h * 100}%`, opacity: b.opacity, zIndex: b.z } as const;
  switch (layer.type) {
    case "text": {
      const s = layer.style;
      return (
        <span
          className="absolute flex items-center overflow-hidden"
          style={{ ...style, justifyContent: s.align === "left" ? "flex-start" : s.align === "right" ? "flex-end" : "center" }}
        >
          <span
            className="line-clamp-4 break-words"
            style={{
              fontSize: `${Math.max(3.5, s.sizePx * scale)}px`,
              lineHeight: s.lineHeight,
              fontWeight: s.weight,
              letterSpacing: `${s.letterSpacing}em`,
              textAlign: s.align,
              color: color(s.color, theme, theme.text),
              textTransform: s.uppercase ? "uppercase" : undefined,
              fontStyle: s.italic ? "italic" : undefined,
              background: s.background ? color(s.background.color, theme, "transparent") : undefined,
              borderRadius: s.background ? 2 : undefined,
              padding: s.background ? "0 2px" : undefined,
            }}
          >
            {layer.text}
          </span>
        </span>
      );
    }
    case "device":
      return (
        <span className="absolute" style={style}>
          <span className={cn("block size-full border-[1.5px] border-[#1d1d1f] bg-[#e8e8ed]", layer.device === "browser" ? "rounded-[2px] border-t-[3px]" : "rounded-[4px]")} />
        </span>
      );
    case "image":
    case "video":
    case "block":
    case "shape":
      return <span className="absolute rounded-[2px] bg-[rgb(29_29_31/0.14)]" style={style} />;
    default:
      return null;
  }
}

function SceneSketch({ scene, doc, width }: { scene: Scene; doc: CompositionDoc; width: number }) {
  const scale = width / doc.width;
  const layers = useMemo(() => scene.layers.filter((l) => !l.hidden).sort((a, b) => a.box.z - b.box.z), [scene.layers]);
  return (
    <span className="absolute inset-0 block" style={{ background: background(scene, doc.theme), fontFamily: doc.theme.headingFont }} aria-hidden>
      {layers.map((l) => (
        <LayerSketch key={l.id} layer={l} theme={doc.theme} scale={scale} />
      ))}
    </span>
  );
}

export function SceneStrip({
  doc,
  time,
  selectedId,
  onSelect,
  frames = {},
  images = {},
  issues,
  disabled,
}: {
  doc: CompositionDoc;
  time: number;
  selectedId: string | null;
  /** `null` = the whole video again. `seekTo` is where the preview should park. */
  onSelect: (sceneId: string | null, seekTo: number) => void;
  /** Real frames of this exact version (Spark's review), by scene id. */
  frames?: Record<string, string>;
  /** Stills: the rendered slide image of this exact version (asset id), by scene id. */
  images?: Record<string, string>;
  /** Scenes with something to fix (lint, Brand check). */
  issues?: Set<string>;
  disabled?: boolean;
}) {
  const starts = useMemo(() => sceneStarts(doc), [doc]);
  const still = isStillDoc(doc);
  const unit = still ? "slide" : "scene";
  const playing = still ? undefined : sceneAt(doc, time)?.scene.id;
  const portrait = doc.height >= doc.width;
  const h = portrait ? (still ? 128 : 112) : 72;
  const w = Math.round((h * doc.width) / doc.height);
  const selected = doc.scenes.find((s) => s.id === selectedId);
  // A single image has nothing to pick between.
  if (still && doc.scenes.length < 2) return null;
  return (
    <section aria-label={still ? "Slides" : "Scenes"} className="min-w-0 space-y-2">
      <div className="flex min-h-7 items-center justify-between gap-2">
        <p className="min-w-0 truncate text-footnote text-ink-2">
          {selected ? (
            <>
              {still ? "Change " : "Changes go to "}
              <span className="font-medium text-ink">
                {unit} {doc.scenes.indexOf(selected) + 1}
              </span>{" "}
              only
              {still ? null : <span className="text-ink-3"> · {selected.name}</span>}
            </>
          ) : (
            `Tap a ${unit} to change only that ${unit}`
          )}
        </p>
        {selected ? (
          <button type="button" className="shrink-0 rounded-full px-2.5 py-1 text-footnote font-medium text-accent hover:bg-accent-soft focus-visible:outline-none focus-visible:shadow-focus" onClick={() => onSelect(null, time)}>
            {wholeLabel(doc)}
          </button>
        ) : null}
      </div>
      <ol className="-mx-1 flex gap-2.5 overflow-x-auto px-1 pb-2 pt-1 [scrollbar-width:thin]">
        {doc.scenes.map((s, i) => {
          const isSel = s.id === selectedId;
          const isNow = s.id === playing;
          const start = starts[i] ?? 0;
          const progress = isNow ? Math.min(1, Math.max(0, (time - start) / s.durationSec)) : 0;
          const frame = frames[s.id];
          return (
            <li key={s.id} className="shrink-0" style={{ width: w }}>
              <button
                type="button"
                aria-pressed={isSel}
                aria-label={still ? `Slide ${i + 1} of ${doc.scenes.length}${issues?.has(s.id) ? ", has something to fix" : ""}` : `Scene ${i + 1}: ${s.name}, ${Math.round(s.durationSec * 10) / 10} seconds${issues?.has(s.id) ? ", has something to fix" : ""}`}
                disabled={disabled}
                onClick={() => onSelect(isSel ? null : s.id, start + settledAt(s))}
                className="group block w-full rounded-lg text-left focus-visible:outline-none disabled:opacity-60 [&:focus-visible>span:first-child]:shadow-focus"
              >
                <span
                  className={cn(
                    "relative block overflow-hidden rounded-lg transition-[box-shadow,transform] duration-150",
                    isSel ? "ring-2 ring-accent ring-offset-2 ring-offset-mist" : "ring-1 ring-line group-hover:ring-line-strong",
                  )}
                  style={{ width: w, height: h }}
                >
                  {images[s.id] ? (
                    <span className="absolute inset-0">
                      <SlideImage assetId={images[s.id]!} alt="" fallback={<SceneSketch scene={s} doc={doc} width={w} />} />
                    </span>
                  ) : frame ? (
                    <img src={frame} alt="" className="absolute inset-0 size-full object-cover" loading="lazy" />
                  ) : (
                    <SceneSketch scene={s} doc={doc} width={w} />
                  )}
                  {issues?.has(s.id) ? <span className="absolute right-1 top-1 size-2 rounded-full bg-warning ring-2 ring-white" aria-hidden /> : null}
                  {isNow ? (
                    <span className="absolute inset-x-0 bottom-0 h-[3px] bg-black/10" aria-hidden>
                      <span className="block h-full bg-accent" style={{ width: `${progress * 100}%` }} />
                    </span>
                  ) : null}
                </span>
                {still ? (
                  <span className={cn("mt-1.5 block truncate text-caption", isSel ? "font-semibold text-accent-ink" : "font-medium text-ink")}>Slide {i + 1}</span>
                ) : (
                  <>
                    <span className={cn("mt-1.5 block truncate text-caption", isSel ? "font-semibold text-accent-ink" : "font-medium text-ink")} title={s.name}>
                      {/^\d/.test(s.name) ? s.name : `${i + 1}. ${s.name}`}
                    </span>
                    <span className="block text-caption tabular text-ink-3">{Math.round(s.durationSec * 10) / 10}s</span>
                  </>
                )}
              </button>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
