"use client";
import { IconButton, Tooltip, cn } from "@muselaunch/ui";
import { AudioLines, Box, Captions, Copy, Eye, EyeOff, Image as ImageIcon, Minus, Plus, Scissors, Shapes, Smartphone, Trash2, Type, Video } from "lucide-react";
import { useMemo, useRef, useState, type PointerEvent as RPointerEvent, type ReactNode } from "react";
import { TEMPLATE_LABELS, duplicateSceneOps, fmtTime, sceneAt, sceneStarts, splitSceneOps, totalDuration } from "./ops";
import type { CompositionDoc, Layer, LintIssue, PatchOp } from "./types";

const LAYER_ICON: Record<Layer["type"], ReactNode> = {
  text: <Type className="size-3.5" aria-hidden />,
  image: <ImageIcon className="size-3.5" aria-hidden />,
  video: <Video className="size-3.5" aria-hidden />,
  device: <Smartphone className="size-3.5" aria-hidden />,
  shape: <Shapes className="size-3.5" aria-hidden />,
  block: <Box className="size-3.5" aria-hidden />,
};

export function layerLabel(l: Layer): string {
  if (l.name) return l.name;
  switch (l.type) {
    case "text":
      return l.text.slice(0, 40);
    case "device":
      return `${l.device} · real screen`;
    case "block":
      return l.blockId.replace(/-/g, " ");
    default:
      return l.type;
  }
}

interface Drag {
  kind: "scene-dur" | "layer-start" | "layer-end";
  sceneId: string;
  layerId?: string;
  startX: number;
  orig: number;
  value: number;
}

const LABEL_W = 148;
const r1 = (n: number) => Math.round(n * 10) / 10;

/**
 * VN-style multi-track timeline: scene track (reorder by drag, resize duration from the right edge,
 * split at playhead), layer tracks for the active scene (drag ends to trim), audio and captions rows.
 */
export function Timeline({
  doc,
  time,
  selectedSceneId,
  selectedLayerId,
  lint,
  onSelectScene,
  onSelectLayer,
  onSeek,
  onPatch,
  disabled,
}: {
  doc: CompositionDoc;
  time: number;
  selectedSceneId: string | null;
  selectedLayerId: string | null;
  lint: LintIssue[];
  onSelectScene: (id: string) => void;
  onSelectLayer: (sceneId: string, layerId: string | null) => void;
  onSeek: (t: number) => void;
  onPatch: (ops: PatchOp[], summary: string) => void;
  disabled?: boolean;
}) {
  const [pps, setPps] = useState(64);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [dragScene, setDragScene] = useState<string | null>(null);
  const [dropBefore, setDropBefore] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const starts = useMemo(() => sceneStarts(doc), [doc]);
  const total = totalDuration(doc);
  const at = sceneAt(doc, time);
  const activeScene = doc.scenes.find((s) => s.id === selectedSceneId) ?? at?.scene ?? doc.scenes[0]!;
  const activeIdx = doc.scenes.findIndex((s) => s.id === activeScene.id);
  const activeStart = starts[activeIdx] ?? 0;
  const issuesByScene = useMemo(() => {
    const m = new Map<string, { errors: number; warnings: number }>();
    for (const i of lint) if (i.sceneId) {
      const v = m.get(i.sceneId) ?? { errors: 0, warnings: 0 };
      if (i.level === "error") v.errors++;
      else v.warnings++;
      m.set(i.sceneId, v);
    }
    return m;
  }, [lint]);

  const width = Math.max(total * pps + 80, 320);

  const beginDrag = (e: RPointerEvent, d: Omit<Drag, "startX" | "value">) => {
    if (disabled) return;
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setDrag({ ...d, startX: e.clientX, value: d.orig });
  };
  const moveDrag = (e: RPointerEvent) => {
    if (!drag) return;
    const dt = (e.clientX - drag.startX) / pps;
    setDrag({ ...drag, value: r1(drag.orig + dt) });
  };
  const endDrag = () => {
    if (!drag) return;
    const d = drag;
    setDrag(null);
    if (Math.abs(d.value - d.orig) < 0.05) return;
    const scene = doc.scenes.find((s) => s.id === d.sceneId);
    if (!scene) return;
    if (d.kind === "scene-dur") {
      const v = Math.max(0.5, Math.min(60, d.value));
      onPatch([{ op: "update_scene", sceneId: scene.id, set: { durationSec: v } }], `Set ${scene.name} to ${v}s`);
      return;
    }
    const layer = scene.layers.find((l) => l.id === d.layerId);
    if (!layer) return;
    const end = layer.timing.end ?? scene.durationSec;
    if (d.kind === "layer-start") {
      const v = Math.max(0, Math.min(end - 0.1, d.value));
      onPatch([{ op: "update_layer", sceneId: scene.id, layerId: layer.id, set: { timing: { start: v } } }], "Trim layer start");
    } else {
      const v = Math.max(layer.timing.start + 0.1, Math.min(scene.durationSec, d.value));
      onPatch([{ op: "update_layer", sceneId: scene.id, layerId: layer.id, set: { timing: { end: v >= scene.durationSec - 0.05 ? null : v } } }], "Trim layer end");
    }
  };

  const seekFromEvent = (e: React.MouseEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    onSeek(Math.max(0, Math.min(total - 0.01, (e.clientX - rect.left) / pps)));
  };

  const split = () => {
    if (!at) return;
    const ops = splitSceneOps(at.scene, time - at.start);
    if (ops) onPatch(ops, `Split ${at.scene.name}`);
  };
  const canSplit = !!at && time - at.start >= 0.5 && at.scene.durationSec - (time - at.start) >= 0.5;

  const dropOn = (targetId: string) => {
    if (!dragScene || dragScene === targetId) return;
    const idx = doc.scenes.findIndex((s) => s.id === targetId);
    const after = idx > 0 ? doc.scenes[idx - 1]!.id : null;
    if (after === dragScene) return;
    onPatch([{ op: "move_scene", sceneId: dragScene, afterSceneId: after }], "Reorder scenes");
  };

  const ticks: number[] = [];
  const step = pps >= 90 ? 0.5 : pps >= 40 ? 1 : 2;
  for (let t = 0; t <= total + 0.001; t += step) ticks.push(Math.round(t * 10) / 10);

  return (
    <div className="flex h-full min-h-0 flex-col border-t border-line bg-surface" onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={() => setDrag(null)}>
      <div className="flex items-center gap-1 border-b border-line px-3 py-1.5">
        <Tooltip content="Split the scene at the playhead (S)">
          <IconButton label="Split at playhead" size="sm" onClick={split} disabled={disabled || !canSplit}>
            <Scissors className="size-4" aria-hidden />
          </IconButton>
        </Tooltip>
        <Tooltip content="Duplicate scene">
          <IconButton label="Duplicate scene" size="sm" onClick={() => onPatch(duplicateSceneOps(activeScene), `Duplicate ${activeScene.name}`)} disabled={disabled}>
            <Copy className="size-4" aria-hidden />
          </IconButton>
        </Tooltip>
        <Tooltip content="Delete scene">
          <IconButton label="Delete scene" size="sm" onClick={() => onPatch([{ op: "remove_scene", sceneId: activeScene.id }], `Delete ${activeScene.name}`)} disabled={disabled || doc.scenes.length < 2}>
            <Trash2 className="size-4" aria-hidden />
          </IconButton>
        </Tooltip>
        <span className="mx-2 h-4 w-px bg-line" aria-hidden />
        <span className="tabular text-footnote text-ink-2">
          {fmtTime(time)} · {doc.scenes.length} scenes · {fmtTime(total)}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <IconButton label="Zoom out" size="sm" onClick={() => setPps((p) => Math.max(20, Math.round(p / 1.4)))}>
            <Minus className="size-4" aria-hidden />
          </IconButton>
          <IconButton label="Zoom in" size="sm" onClick={() => setPps((p) => Math.min(220, Math.round(p * 1.4)))}>
            <Plus className="size-4" aria-hidden />
          </IconButton>
        </div>
      </div>
      <div ref={scroller} className="relative min-h-0 flex-1 overflow-auto">
        <div className="relative" style={{ width: width + LABEL_W }}>
          {/* Ruler */}
          <div className="sticky top-0 z-20 flex h-6 border-b border-line bg-surface">
            <div className="sticky left-0 z-10 shrink-0 bg-surface" style={{ width: LABEL_W }} />
            <div className="relative cursor-pointer" style={{ width }} onClick={seekFromEvent} role="slider" aria-label="Timeline position" aria-valuemin={0} aria-valuemax={total} aria-valuenow={time} tabIndex={0}>
              {ticks.map((t) => (
                <span key={t} className="absolute top-0 h-full border-l border-line pl-1 text-[10px] tabular leading-6 text-ink-3" style={{ left: t * pps }}>
                  {Number.isInteger(t) ? `${t}s` : ""}
                </span>
              ))}
            </div>
          </div>

          {/* Scene track */}
          <Row label="Scenes" icon={<Video className="size-3.5" aria-hidden />}>
            {doc.scenes.map((s, i) => {
              const dur = drag?.kind === "scene-dur" && drag.sceneId === s.id ? Math.max(0.5, drag.value) : s.durationSec;
              const left = starts[i]! * pps;
              const iss = issuesByScene.get(s.id);
              const selected = s.id === activeScene.id;
              return (
                <div
                  key={s.id}
                  draggable={!disabled}
                  onDragStart={(e) => {
                    setDragScene(s.id);
                    e.dataTransfer.effectAllowed = "move";
                  }}
                  onDragEnd={() => {
                    setDragScene(null);
                    setDropBefore(null);
                  }}
                  onDragOver={(e) => {
                    if (!dragScene) return;
                    e.preventDefault();
                    setDropBefore(s.id);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    dropOn(s.id);
                    setDropBefore(null);
                  }}
                  onClick={() => {
                    onSelectScene(s.id);
                    onSeek(starts[i]! + 0.01);
                  }}
                  className={cn(
                    "group absolute top-1 bottom-1 flex cursor-pointer select-none flex-col justify-center overflow-hidden rounded-md border px-2 text-left transition-colors",
                    selected ? "border-accent bg-accent-soft" : "border-line-strong bg-mist hover:bg-mist-2",
                    dragScene === s.id && "opacity-50",
                    dropBefore === s.id && dragScene !== s.id && "ring-2 ring-accent",
                  )}
                  style={{ left: left + 1, width: Math.max(8, dur * pps - 2) }}
                  title={`${s.name} — ${TEMPLATE_LABELS[s.template] ?? s.template} · ${dur}s`}
                >
                  <span className="truncate text-footnote font-medium text-ink">{s.name}</span>
                  <span className="flex items-center gap-1 truncate text-caption text-ink-2">
                    {TEMPLATE_LABELS[s.template] ?? s.template} · {r1(dur)}s
                    {iss?.errors ? <span className="size-1.5 rounded-full bg-danger" aria-label={`${iss.errors} issues`} /> : iss?.warnings ? <span className="size-1.5 rounded-full bg-warning" aria-label={`${iss.warnings} warnings`} /> : null}
                  </span>
                  <span
                    role="separator"
                    aria-label={`Resize ${s.name}`}
                    onPointerDown={(e) => beginDrag(e, { kind: "scene-dur", sceneId: s.id, orig: s.durationSec })}
                    className="absolute right-0 top-0 h-full w-2 cursor-ew-resize rounded-r-md opacity-0 transition-opacity group-hover:opacity-100 hover:bg-accent/30"
                  />
                </div>
              );
            })}
          </Row>

          {/* Layer tracks for the active scene */}
          {activeScene.layers.map((l) => {
            const sel = l.id === selectedLayerId;
            const end = l.timing.end ?? activeScene.durationSec;
            const s = drag?.layerId === l.id && drag.kind === "layer-start" ? Math.max(0, drag.value) : l.timing.start;
            const e = drag?.layerId === l.id && drag.kind === "layer-end" ? Math.min(activeScene.durationSec, drag.value) : end;
            return (
              <Row
                key={l.id}
                selected={sel}
                label={layerLabel(l)}
                icon={LAYER_ICON[l.type]}
                onLabelClick={() => onSelectLayer(activeScene.id, l.id)}
                trailing={
                  <button
                    type="button"
                    className="rounded p-0.5 text-ink-3 hover:text-ink"
                    aria-label={l.hidden ? "Show layer" : "Hide layer"}
                    disabled={disabled}
                    onClick={(ev) => {
                      ev.stopPropagation();
                      onPatch([{ op: "update_layer", sceneId: activeScene.id, layerId: l.id, set: { hidden: !l.hidden } }], l.hidden ? "Show layer" : "Hide layer");
                    }}
                  >
                    {l.hidden ? <EyeOff className="size-3.5" aria-hidden /> : <Eye className="size-3.5" aria-hidden />}
                  </button>
                }
              >
                <div
                  onClick={() => onSelectLayer(activeScene.id, l.id)}
                  className={cn(
                    "group absolute top-1.5 bottom-1.5 cursor-pointer rounded border",
                    sel ? "border-accent bg-accent/25" : "border-line-strong bg-mist-2 hover:bg-mist",
                    l.hidden && "opacity-40",
                  )}
                  style={{ left: (activeStart + s) * pps, width: Math.max(6, (e - s) * pps) }}
                >
                  <span onPointerDown={(ev) => beginDrag(ev, { kind: "layer-start", sceneId: activeScene.id, layerId: l.id, orig: l.timing.start })} className="absolute left-0 top-0 h-full w-1.5 cursor-ew-resize rounded-l hover:bg-accent/40" aria-label="Trim start" />
                  <span onPointerDown={(ev) => beginDrag(ev, { kind: "layer-end", sceneId: activeScene.id, layerId: l.id, orig: end })} className="absolute right-0 top-0 h-full w-1.5 cursor-ew-resize rounded-r hover:bg-accent/40" aria-label="Trim end" />
                </div>
              </Row>
            );
          })}

          {doc.audio.length ? (
            <Row label="Audio" icon={<AudioLines className="size-3.5" aria-hidden />}>
              {doc.audio.map((a) => (
                <div key={a.id} className="absolute top-1.5 bottom-1.5 rounded border border-line-strong bg-[#e8f6ee] px-1.5 text-caption leading-6 text-success" style={{ left: a.startSec * pps, width: Math.max(8, ((a.endSec ?? total) - a.startSec) * pps) }}>
                  {a.kind} · {a.sourceLabel.replace(/_/g, " ")}
                </div>
              ))}
            </Row>
          ) : null}
          {doc.captions.cues.length ? (
            <Row label={doc.captions.enabled ? "Captions" : "Captions (off)"} icon={<Captions className="size-3.5" aria-hidden />}>
              {doc.captions.cues.map((c) => (
                <div key={c.id} className={cn("absolute top-1.5 bottom-1.5 truncate rounded border border-line bg-surface px-1 text-[10px] leading-6 text-ink-2", !doc.captions.enabled && "opacity-50")} style={{ left: c.startSec * pps, width: Math.max(6, (c.endSec - c.startSec) * pps) }} title={c.text}>
                  {c.text}
                </div>
              ))}
            </Row>
          ) : null}

          {/* Playhead */}
          <div className="pointer-events-none absolute top-0 bottom-0 z-30 w-px bg-danger" style={{ left: LABEL_W + time * pps }}>
            <span className="absolute -left-1 top-0 size-2 rotate-45 bg-danger" />
          </div>
        </div>
      </div>
    </div>
  );
}

function Row({ label, icon, children, selected, onLabelClick, trailing }: { label: string; icon: ReactNode; children: ReactNode; selected?: boolean; onLabelClick?: () => void; trailing?: ReactNode }) {
  return (
    <div className={cn("flex h-9 border-b border-line/70", selected && "bg-accent-soft/40")}>
      <div className="sticky left-0 z-10 flex shrink-0 items-center gap-1.5 border-r border-line bg-surface px-2 text-footnote text-ink-2" style={{ width: LABEL_W }}>
        <span className="text-ink-3">{icon}</span>
        <button type="button" onClick={onLabelClick} className={cn("min-w-0 flex-1 truncate text-left", selected && "font-medium text-ink")} disabled={!onLabelClick}>
          {label}
        </button>
        {trailing}
      </div>
      <div className="relative flex-1">{children}</div>
    </div>
  );
}
