"use client";
import { Badge, Button, Field, Input, Select, SegmentedControl, Switch, Textarea, cn } from "@muselaunch/ui";
import { AlignCenter, AlignLeft, AlignRight, Lock, Trash2, Type } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { TEMPLATE_LABELS, textLayer } from "./ops";
import { layerLabel } from "./timeline";
import type { CompositionDoc, Layer, LintIssue, PatchOp, Scene } from "./types";

const ENTER = ["none", "fade", "slide-up", "slide-down", "slide-left", "slide-right", "scale-in", "pop", "blur-in", "typewriter", "mask-reveal"];
const EXIT = ["none", "fade", "slide-up", "slide-down", "slide-left", "slide-right", "scale-out", "blur-out"];
const LOOP = ["none", "float", "pulse", "ken-burns", "slow-zoom", "tilt"];
const EASING = ["smooth", "snappy", "spring", "linear"];
const TRANSITIONS = ["cut", "fade", "slide-left", "slide-up", "zoom", "blur", "flash", "wipe"];
const COLOR_TOKENS = ["theme.text", "theme.textMuted", "theme.accent", "theme.accent2", "theme.background", "theme.surface"];
const opts = (xs: string[]) => xs.map((x) => ({ value: x, label: x.replace(/^theme\./, "").replace(/-/g, " ") }));
const HEX = /^#(?:[0-9a-fA-F]{3}){1,2}$/;

/** Label + control (ids are wired by the inner control's aria-label). */
function F({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <Field label={label} hint={hint}>
      {() => children}
    </Field>
  );
}

/** Text input that commits on blur / Enter (one version per edit, not per keystroke). */
function CommitInput({ value, onCommit, multiline, ...rest }: { value: string; onCommit: (v: string) => void; multiline?: boolean; disabled?: boolean; "aria-label"?: string; placeholder?: string; maxLength?: number }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const commit = () => {
    if (v !== value && v.trim()) onCommit(v);
    else if (!v.trim()) setV(value);
  };
  if (multiline)
    return <Textarea rows={3} value={v} onChange={(e) => setV(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && commit()} {...rest} />;
  return <Input value={v} onChange={(e) => setV(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === "Enter" && commit()} {...rest} />;
}

function NumberInput({ value, onCommit, step = 1, min, max, suffix, disabled, label }: { value: number; onCommit: (v: number) => void; step?: number; min?: number; max?: number; suffix?: string; disabled?: boolean; label: string }) {
  const [v, setV] = useState(String(value));
  useEffect(() => setV(String(value)), [value]);
  const commit = () => {
    const n = Number(v);
    if (!Number.isFinite(n)) return setV(String(value));
    const c = Math.min(max ?? Infinity, Math.max(min ?? -Infinity, n));
    if (c !== value) onCommit(c);
    setV(String(c));
  };
  return (
    <label className="flex items-center gap-1.5 text-footnote text-ink-2">
      <span className="w-6 shrink-0 text-caption uppercase text-ink-3">{label}</span>
      <Input className="h-8 text-footnote" type="number" step={step} value={v} onChange={(e) => setV(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === "Enter" && commit()} disabled={disabled} trailing={suffix ? <span className="text-caption text-ink-3">{suffix}</span> : undefined} aria-label={label} />
    </label>
  );
}

function ColorPicker({ value, onChange, disabled, theme }: { value: string; onChange: (v: string) => void; disabled?: boolean; theme: CompositionDoc["theme"] }) {
  const resolve = (c: string) => (c.startsWith("#") ? c : String((theme as unknown as Record<string, string>)[c.replace("theme.", "")] ?? "#000000"));
  const [hex, setHex] = useState(value.startsWith("#") ? value : "");
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {COLOR_TOKENS.map((t) => (
        <button
          key={t}
          type="button"
          disabled={disabled}
          title={t.replace("theme.", "")}
          aria-label={`Use ${t.replace("theme.", "")} colour`}
          onClick={() => onChange(t)}
          className={cn("size-6 rounded-full border border-line-strong", value === t && "ring-2 ring-accent ring-offset-1")}
          style={{ background: resolve(t) }}
        />
      ))}
      <Input
        className="h-8 w-24 text-footnote"
        placeholder="#RRGGBB"
        value={hex}
        disabled={disabled}
        onChange={(e) => setHex(e.target.value)}
        onBlur={() => HEX.test(hex) && hex !== value && onChange(hex.toUpperCase())}
        aria-label="Custom colour"
      />
    </div>
  );
}

function Group({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="space-y-2.5 border-b border-line px-4 py-3.5">
      <div className="flex items-center justify-between">
        <h3 className="text-caption font-semibold uppercase tracking-wide text-ink-3">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

export function Inspector({
  doc,
  scene,
  layer,
  lint,
  onPatch,
  onSelectLayer,
  disabled,
}: {
  doc: CompositionDoc;
  scene: Scene | null;
  layer: Layer | null;
  lint: LintIssue[];
  onPatch: (ops: PatchOp[], summary: string) => void;
  onSelectLayer: (sceneId: string, layerId: string | null) => void;
  disabled?: boolean;
}) {
  if (scene && layer) return <LayerInspector doc={doc} scene={scene} layer={layer} lint={lint.filter((i) => i.layerId === layer.id)} onPatch={onPatch} onSelectLayer={onSelectLayer} disabled={disabled} />;
  if (scene) return <SceneInspector doc={doc} scene={scene} lint={lint.filter((i) => i.sceneId === scene.id && !i.layerId)} onPatch={onPatch} onSelectLayer={onSelectLayer} disabled={disabled} />;
  return null;
}

function Issues({ lint }: { lint: LintIssue[] }) {
  if (!lint.length) return null;
  return (
    <ul className="space-y-1.5 px-4 pt-3">
      {lint.map((i, k) => (
        <li key={k} className={cn("rounded-md px-2.5 py-1.5 text-footnote", i.level === "error" ? "bg-danger-soft text-danger" : "bg-warning-soft text-warning")}>
          {i.message}
        </li>
      ))}
    </ul>
  );
}

function SceneInspector({ doc, scene, lint, onPatch, onSelectLayer, disabled }: { doc: CompositionDoc; scene: Scene; lint: LintIssue[]; onPatch: (ops: PatchOp[], summary: string) => void; onSelectLayer: (s: string, l: string | null) => void; disabled?: boolean }) {
  const set = (s: Record<string, unknown>, summary: string) => onPatch([{ op: "update_scene", sceneId: scene.id, set: s }], summary);
  const bg = scene.background;
  return (
    <div>
      <div className="px-4 pt-4">
        <p className="text-caption text-ink-3">Scene · {TEMPLATE_LABELS[scene.template] ?? scene.template}</p>
        <CommitInput aria-label="Scene name" value={scene.name} onCommit={(v) => set({ name: v.slice(0, 80) }, "Rename scene")} disabled={disabled} maxLength={80} />
      </div>
      <Issues lint={lint} />
      <Group title="Timing">
        <div className="grid grid-cols-2 gap-2">
          <NumberInput label="Dur" suffix="s" step={0.1} min={0.5} max={60} value={scene.durationSec} onCommit={(v) => set({ durationSec: v }, `Scene duration ${v}s`)} disabled={disabled} />
        </div>
        <F label="Transition in">
          <div className="grid grid-cols-[1fr_88px] gap-2">
            <Select selectSize="sm" options={opts(TRANSITIONS)} value={scene.transitionIn.kind} disabled={disabled} onChange={(e) => set({ transitionIn: { kind: e.target.value, durationSec: e.target.value === "cut" ? 0 : Math.max(0.3, scene.transitionIn.durationSec) } }, "Change transition")} aria-label="Transition" />
            <NumberInput label="" suffix="s" step={0.05} min={0} max={Math.min(2, scene.durationSec / 2)} value={scene.transitionIn.durationSec} onCommit={(v) => set({ transitionIn: { kind: scene.transitionIn.kind, durationSec: v } }, "Transition length")} disabled={disabled || scene.transitionIn.kind === "cut"} />
          </div>
        </F>
      </Group>
      <Group title="Background">
        <Select
          selectSize="sm"
          aria-label="Background type"
          value={bg.kind}
          disabled={disabled}
          options={[
            { value: "solid", label: "Solid colour" },
            { value: "gradient", label: "Gradient" },
            { value: "image", label: "Image", disabled: !bg.assetId },
            { value: "video", label: "Video", disabled: !bg.assetId },
            { value: "blur", label: "Blurred media", disabled: !bg.assetId },
          ]}
          onChange={(e) => {
            const kind = e.target.value;
            const next = kind === "gradient" ? { ...bg, kind, colors: bg.colors ?? [doc.theme.surface, doc.theme.background] } : { ...bg, kind };
            set({ background: next }, "Change background");
          }}
        />
        {bg.kind === "solid" ? <ColorPicker theme={doc.theme} value={bg.color ?? "theme.background"} onChange={(c) => set({ background: { ...bg, color: c } }, "Background colour")} disabled={disabled} /> : null}
        {bg.kind === "gradient" ? (
          <div className="space-y-2">
            {(bg.colors ?? []).slice(0, 2).map((c, i) => (
              <ColorPicker key={i} theme={doc.theme} value={c} onChange={(v) => set({ background: { ...bg, colors: (bg.colors ?? []).map((x, k) => (k === i ? v : x)) } }, "Gradient colour")} disabled={disabled} />
            ))}
          </div>
        ) : null}
      </Group>
      <Group title="Layers" action={
        <Button size="sm" variant="ghost" icon={<Type className="size-4" aria-hidden />} disabled={disabled} onClick={() => onPatch([{ op: "add_layer", sceneId: scene.id, layer: textLayer("New headline") }], "Add text")}>
          Add text
        </Button>
      }>
        <ul className="space-y-1">
          {scene.layers.map((l) => (
            <li key={l.id}>
              <button type="button" onClick={() => onSelectLayer(scene.id, l.id)} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-body-sm hover:bg-mist">
                <Badge tone="neutral">{l.type}</Badge>
                <span className={cn("truncate", l.hidden && "text-ink-3 line-through")}>{layerLabel(l)}</span>
              </button>
            </li>
          ))}
        </ul>
      </Group>
      {scene.notes ? (
        <Group title="Storyboard note">
          <p className="text-footnote text-ink-2">{scene.notes}</p>
        </Group>
      ) : null}
    </div>
  );
}

function LayerInspector({ doc, scene, layer, lint, onPatch, onSelectLayer, disabled: d0 }: { doc: CompositionDoc; scene: Scene; layer: Layer; lint: LintIssue[]; onPatch: (ops: PatchOp[], summary: string) => void; onSelectLayer: (s: string, l: string | null) => void; disabled?: boolean }) {
  const disabled = d0 || layer.locked;
  const set = (s: Record<string, unknown>, summary: string) => onPatch([{ op: "update_layer", sceneId: scene.id, layerId: layer.id, set: s }], summary);
  const b = layer.box;
  const pct = (v: number) => Math.round(v * 1000) / 10;
  return (
    <div>
      <div className="flex items-start justify-between gap-2 px-4 pt-4">
        <div className="min-w-0">
          <button type="button" className="text-caption text-accent hover:underline" onClick={() => onSelectLayer(scene.id, null)}>
            ← {scene.name}
          </button>
          <p className="truncate text-headline font-semibold">{layerLabel(layer)}</p>
          <p className="text-caption text-ink-3">
            {layer.type}
            {layer.type === "device" ? " · shows a real screenshot or recording" : ""}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button size="sm" variant="ghost" icon={<Lock className="size-4" aria-hidden />} onClick={() => set({ locked: !layer.locked }, layer.locked ? "Unlock layer" : "Lock layer")} disabled={d0}>
            {layer.locked ? "Unlock" : "Lock"}
          </Button>
          <Button size="sm" variant="ghost" icon={<Trash2 className="size-4" aria-hidden />} onClick={() => onPatch([{ op: "remove_layer", sceneId: scene.id, layerId: layer.id }], "Delete layer")} disabled={disabled} aria-label="Delete layer" />
        </div>
      </div>
      <Issues lint={lint} />

      {layer.type === "text" ? (
        <Group title="Text">
          <CommitInput multiline aria-label="Text" value={layer.text} onCommit={(v) => set({ text: v.slice(0, 400) }, "Edit text")} disabled={disabled} maxLength={400} />
          {layer.claimIds.length ? <p className="text-caption text-ink-3">Linked to {layer.claimIds.length} claim{layer.claimIds.length === 1 ? "" : "s"} from your claim library.</p> : null}
          <div className="grid grid-cols-2 gap-2">
            <NumberInput label="Size" suffix="px" min={8} max={400} value={layer.style.sizePx} onCommit={(v) => set({ style: { sizePx: v } }, "Text size")} disabled={disabled} />
            <Select selectSize="sm" aria-label="Weight" value={String(layer.style.weight)} disabled={disabled} options={[400, 500, 600, 700, 800, 900].map((w) => ({ value: String(w), label: `Weight ${w}` }))} onChange={(e) => set({ style: { weight: Number(e.target.value) } }, "Text weight")} />
          </div>
          <SegmentedControl
            label="Alignment"
            size="sm"
            value={layer.style.align}
            onChange={(v) => set({ style: { align: v } }, "Align text")}
            items={[
              { value: "left", label: <AlignLeft className="size-4" aria-label="Left" /> },
              { value: "center", label: <AlignCenter className="size-4" aria-label="Centre" /> },
              { value: "right", label: <AlignRight className="size-4" aria-label="Right" /> },
            ]}
          />
          <ColorPicker theme={doc.theme} value={layer.style.color} onChange={(c) => set({ style: { color: c } }, "Text colour")} disabled={disabled} />
          <div className="flex items-center justify-between">
            <span className="text-footnote text-ink-2">Uppercase</span>
            <Switch checked={layer.style.uppercase} onCheckedChange={(v) => set({ style: { uppercase: v } }, "Uppercase")} disabled={disabled} label="Uppercase" />
          </div>
          <F label="Highlight words" hint="Comma-separated; coloured with the accent">
            <CommitInput
              aria-label="Highlight words"
              value={(layer.style.highlight?.words ?? []).join(", ")}
              onCommit={(v) => {
                const words = v.split(",").map((w) => w.trim()).filter(Boolean).slice(0, 10);
                set({ style: { highlight: words.length ? { words, color: layer.style.highlight?.color ?? "theme.accent" } : null } }, "Highlight words");
              }}
              disabled={disabled}
            />
          </F>
        </Group>
      ) : null}

      {layer.type === "device" ? (
        <Group title="Device">
          <div className="grid grid-cols-2 gap-2">
            <Select selectSize="sm" aria-label="Device" value={layer.device} disabled={disabled} options={opts(["iphone", "android", "ipad", "browser", "macbook"])} onChange={(e) => set({ device: e.target.value }, "Change device")} />
            <Select selectSize="sm" aria-label="Frame colour" value={layer.frameColor} disabled={disabled} options={opts(["black", "silver", "natural", "white"])} onChange={(e) => set({ frameColor: e.target.value }, "Frame colour")} />
          </div>
          <div className="flex items-center justify-between">
            <span className="text-footnote text-ink-2">Soft shadow</span>
            <Switch checked={layer.shadow} onCheckedChange={(v) => set({ shadow: v }, "Device shadow")} disabled={disabled} label="Shadow" />
          </div>
          <p className="text-caption text-ink-3">Swap the screen from the media drawer. Only real screenshots and recordings can appear inside a device.</p>
        </Group>
      ) : null}

      {layer.type === "image" || layer.type === "video" ? (
        <Group title="Media">
          <div className="grid grid-cols-2 gap-2">
            <Select selectSize="sm" aria-label="Fit" value={layer.fit} disabled={disabled} options={opts(["cover", "contain"])} onChange={(e) => set({ fit: e.target.value }, "Media fit")} />
            <NumberInput label="R" suffix="px" min={0} max={400} value={layer.radiusPx} onCommit={(v) => set({ radiusPx: v }, "Corner radius")} disabled={disabled} />
          </div>
          {layer.type === "video" ? (
            <>
              <div className="grid grid-cols-2 gap-2">
                <NumberInput label="In" suffix="s" step={0.1} min={0} value={layer.trimInSec} onCommit={(v) => set({ trimInSec: v }, "Trim in")} disabled={disabled} />
                <NumberInput label="Rate" step={0.25} min={0.25} max={4} value={layer.playbackRate} onCommit={(v) => set({ playbackRate: v }, "Playback rate")} disabled={disabled} />
              </div>
              <div className="flex items-center justify-between">
                <span className="text-footnote text-ink-2">Play sound</span>
                <Switch checked={!layer.muted} onCheckedChange={(v) => set({ muted: !v }, v ? "Unmute clip" : "Mute clip")} disabled={disabled} label="Sound" />
              </div>
              {layer.mask ? <p className="text-caption text-ink-3">Background removed with SAM (falls back to the original footage if the mask is missing or low quality).</p> : null}
            </>
          ) : null}
        </Group>
      ) : null}

      {layer.type === "shape" ? (
        <Group title="Shape">
          <ColorPicker theme={doc.theme} value={layer.fill} onChange={(c) => set({ fill: c }, "Shape colour")} disabled={disabled} />
          <NumberInput label="Blur" suffix="px" min={0} max={200} value={layer.blurPx} onCommit={(v) => set({ blurPx: v }, "Shape blur")} disabled={disabled} />
        </Group>
      ) : null}

      {layer.type === "block" && layer.blockId === "callout-chip" ? (
        <Group title="Callout">
          <CommitInput aria-label="Callout text" value={String(layer.params.text ?? "")} onCommit={(v) => set({ params: { ...layer.params, text: v.slice(0, 80) } }, "Callout text")} disabled={disabled} maxLength={80} />
        </Group>
      ) : null}

      <Group title="Position (% of frame)">
        <div className="grid grid-cols-2 gap-2">
          <NumberInput label="X" step={0.5} min={-100} max={200} value={pct(b.x)} onCommit={(v) => set({ box: { x: v / 100 } }, "Move layer")} disabled={disabled} />
          <NumberInput label="Y" step={0.5} min={-100} max={200} value={pct(b.y)} onCommit={(v) => set({ box: { y: v / 100 } }, "Move layer")} disabled={disabled} />
          <NumberInput label="W" step={0.5} min={0} max={300} value={pct(b.w)} onCommit={(v) => set({ box: { w: v / 100 } }, "Resize layer")} disabled={disabled} />
          <NumberInput label="H" step={0.5} min={0} max={300} value={pct(b.h)} onCommit={(v) => set({ box: { h: v / 100 } }, "Resize layer")} disabled={disabled} />
          <NumberInput label="Rot" suffix="°" min={-360} max={360} value={b.rotation} onCommit={(v) => set({ box: { rotation: v } }, "Rotate layer")} disabled={disabled} />
          <NumberInput label="Op" step={5} min={0} max={100} suffix="%" value={Math.round(b.opacity * 100)} onCommit={(v) => set({ box: { opacity: v / 100 } }, "Layer opacity")} disabled={disabled} />
        </div>
      </Group>

      <Group title="Timing (within scene)">
        <div className="grid grid-cols-2 gap-2">
          <NumberInput label="In" suffix="s" step={0.1} min={0} max={scene.durationSec - 0.1} value={layer.timing.start} onCommit={(v) => set({ timing: { start: v } }, "Layer start")} disabled={disabled} />
          <NumberInput label="Out" suffix="s" step={0.1} min={0.1} max={scene.durationSec} value={layer.timing.end ?? scene.durationSec} onCommit={(v) => set({ timing: { end: v >= scene.durationSec ? null : v } }, "Layer end")} disabled={disabled} />
        </div>
      </Group>

      <Group title="Motion">
        <F label="Entrance">
          <div className="grid grid-cols-[1fr_96px] gap-2">
            <Select selectSize="sm" aria-label="Entrance" value={layer.animation.enter?.preset ?? "none"} disabled={disabled} options={opts(ENTER)} onChange={(e) => set({ animation: { enter: e.target.value === "none" ? null : { preset: e.target.value, durationSec: layer.animation.enter?.durationSec ?? 0.7, delaySec: layer.animation.enter?.delaySec ?? 0, easing: layer.animation.enter?.easing ?? "smooth" } } }, "Entrance animation")} />
            <Select selectSize="sm" aria-label="Easing" value={layer.animation.enter?.easing ?? "smooth"} disabled={disabled || !layer.animation.enter} options={opts(EASING)} onChange={(e) => layer.animation.enter && set({ animation: { enter: { ...layer.animation.enter, easing: e.target.value } } }, "Easing")} />
          </div>
        </F>
        {layer.animation.enter ? (
          <div className="grid grid-cols-2 gap-2">
            <NumberInput label="Dur" suffix="s" step={0.05} min={0.05} max={5} value={layer.animation.enter.durationSec} onCommit={(v) => set({ animation: { enter: { ...layer.animation.enter!, durationSec: v } } }, "Entrance duration")} disabled={disabled} />
            <NumberInput label="Delay" suffix="s" step={0.05} min={0} max={30} value={layer.animation.enter.delaySec} onCommit={(v) => set({ animation: { enter: { ...layer.animation.enter!, delaySec: v } } }, "Entrance delay")} disabled={disabled} />
          </div>
        ) : null}
        <div className="grid grid-cols-2 gap-2">
          <F label="Exit">
            <Select selectSize="sm" aria-label="Exit" value={layer.animation.exit?.preset ?? "none"} disabled={disabled} options={opts(EXIT)} onChange={(e) => set({ animation: { exit: e.target.value === "none" ? null : { preset: e.target.value, durationSec: 0.4, easing: "smooth" } } }, "Exit animation")} />
          </F>
          <F label="Loop">
            <Select selectSize="sm" aria-label="Loop" value={layer.animation.loop} disabled={disabled} options={opts(LOOP)} onChange={(e) => set({ animation: { loop: e.target.value } }, "Loop motion")} />
          </F>
        </div>
      </Group>
    </div>
  );
}
