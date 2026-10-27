"use client";
/**
 * Debug-style overlay on the live preview: the SAM track box of every analysed object whose clip is
 * on screen at the playhead, mapped through the clip layer's fit/trim exactly like the compiler does.
 * Purely visual (pointer-events: none); never part of the render.
 */
import type { TracksFile } from "@muselaunch/contracts";
import { useMemo } from "react";
import { overlayRect, type ClipObject } from "./clips";
import { objectColor } from "./clip-panel";
import { sceneAt } from "./ops";
import type { CompositionDoc } from "./types";

export function TrackOverlay({ doc, time, objects, tracks }: { doc: CompositionDoc; time: number; objects: ClipObject[]; tracks: Record<string, TracksFile> }) {
  const at = useMemo(() => sceneAt(doc, time), [doc, time]);
  if (!at) return null;
  const boxes = objects
    .map((o) => ({ o, r: overlayRect(doc, at.scene, at.start, time, o, tracks[o.segmentationId]) }))
    .filter((x): x is { o: ClipObject; r: NonNullable<typeof x.r> } => !!x.r);
  if (!boxes.length) return null;
  return (
    <div className="pointer-events-none absolute inset-0 z-[5]" aria-hidden>
      {boxes.map(({ o, r }) => {
        const color = objectColor(objects, o);
        return (
          <div
            key={`${o.segmentationId}:${o.objectId}`}
            className="absolute rounded-[6px] border-2 transition-[left,top,width,height] duration-100 ease-linear"
            style={{ left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%`, borderColor: color, boxShadow: `0 0 0 1px rgb(0 0 0 / 0.25)` }}
          >
            <span className="absolute -top-[22px] left-[-2px] whitespace-nowrap rounded-md px-1.5 py-0.5 text-[11px] font-semibold leading-none text-white" style={{ background: color }}>
              {o.label}
              {o.quality !== null ? ` · ${Math.round(o.quality * 100)}%` : ""}
            </span>
          </div>
        );
      })}
    </div>
  );
}
