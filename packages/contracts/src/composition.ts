import { z } from "zod";
import { AspectRatio, BaseEntity, HexColor, Id, IsoDateTime } from "./common";

/**
 * Canonical, versioned composition document (spec 4.6).
 *
 * This JSON is the source of truth for every video/static creative. It is
 * compiled by `@muselaunch/compositions` into a HyperFrames HTML project using
 * an allowlisted component library; it is never executable user code.
 * Edits are expressed as `PatchOp`s against stable scene/layer ids.
 */
export const COMPOSITION_SCHEMA_VERSION = 1 as const;

/**
 * Allowlisted scene templates (implemented by @muselaunch/compositions). Storyboards may only
 * reference these ids; the compiler rejects anything else.
 */
export const TEMPLATE_IDS = [
  "hook-title", // big kinetic headline, optional background media
  "device-demo", // real screenshot/recording inside an animated device frame + caption
  "feature-callout", // device or screenshot with 1-3 animated callout labels
  "founder-cutout", // SAM cutout of the founder in front of the app demo / backdrop
  "before-after", // split or wipe comparison (real workflow states only)
  "text-over-media", // full-bleed image/video (stock/generated/upload) with headline
  "split-screen", // two media panes with labels
  "quote-proof", // REAL evidence only: review/press quote with source label
  "stat-card", // REAL measured number with source label
  "cta-endcard", // logo, CTA, store badges
  "carousel-slide", // static slide for carousels/static ads/thumbnails
] as const;
export type TemplateId = (typeof TEMPLATE_IDS)[number];

/** Hex colour or a theme token. */
export const ColorValue = z.union([
  HexColor,
  z.enum(["theme.background", "theme.surface", "theme.text", "theme.textMuted", "theme.accent", "theme.accent2"]),
]);
export type ColorValue = z.infer<typeof ColorValue>;

/** Normalised frame coordinates (0..1 of width/height); slightly out of range allowed for off-frame motion. */
const Coord = z.number().min(-1).max(2);

export const Box = z.object({
  x: Coord,
  y: Coord,
  w: z.number().min(0).max(3),
  h: z.number().min(0).max(3),
  rotation: z.number().min(-360).max(360).default(0),
  opacity: z.number().min(0).max(1).default(1),
  z: z.number().int().min(0).max(100).default(1),
});
export type Box = z.infer<typeof Box>;

/** Seconds relative to the start of the containing scene. `end` omitted = scene end. */
export const LayerTiming = z.object({
  start: z.number().min(0).max(180).default(0),
  end: z.number().min(0).max(180).optional(),
});

export const EnterPreset = z.enum(["none", "fade", "slide-up", "slide-down", "slide-left", "slide-right", "scale-in", "pop", "blur-in", "typewriter", "mask-reveal"]);
export const ExitPreset = z.enum(["none", "fade", "slide-up", "slide-down", "slide-left", "slide-right", "scale-out", "blur-out"]);
export const LoopPreset = z.enum(["none", "float", "pulse", "ken-burns", "slow-zoom", "tilt"]);
export const Easing = z.enum(["smooth", "snappy", "spring", "linear"]);

export const Animation = z.object({
  enter: z
    .object({ preset: EnterPreset, durationSec: z.number().min(0).max(5).default(0.6), delaySec: z.number().min(0).max(30).default(0), easing: Easing.default("smooth") })
    .optional(),
  exit: z.object({ preset: ExitPreset, durationSec: z.number().min(0).max(5).default(0.4), easing: Easing.default("smooth") }).optional(),
  loop: LoopPreset.default("none"),
  /** Optional explicit keyframes (time relative to scene start). */
  keyframes: z
    .array(
      z.object({
        t: z.number().min(0).max(180),
        x: Coord.optional(),
        y: Coord.optional(),
        scale: z.number().min(0).max(10).optional(),
        rotation: z.number().min(-360).max(360).optional(),
        opacity: z.number().min(0).max(1).optional(),
        easing: Easing.optional(),
      }),
    )
    .max(24)
    .optional(),
});
export type Animation = z.infer<typeof Animation>;

const LayerBase = z.object({
  id: Id,
  name: z.string().max(80).optional(),
  box: Box,
  timing: LayerTiming.default({ start: 0 }),
  animation: Animation.default({ loop: "none" }),
  locked: z.boolean().default(false),
  hidden: z.boolean().default(false),
});

export const TextStyle = z.object({
  font: z.enum(["heading", "body", "mono"]).default("heading"),
  /** Pixels at the composition's native width (1080 for vertical). */
  sizePx: z.number().min(8).max(400).default(72),
  weight: z.number().int().min(100).max(900).default(700),
  color: ColorValue.default("theme.text"),
  align: z.enum(["left", "center", "right"]).default("center"),
  lineHeight: z.number().min(0.6).max(3).default(1.1),
  letterSpacing: z.number().min(-0.2).max(1).default(-0.01),
  italic: z.boolean().default(false),
  uppercase: z.boolean().default(false),
  background: z.object({ color: ColorValue, paddingPx: z.number().min(0).max(200).default(16), radiusPx: z.number().min(0).max(200).default(16) }).optional(),
  shadow: z.boolean().default(false),
  highlight: z.object({ words: z.array(z.string().max(60)).max(10), color: ColorValue }).optional(),
});
export type TextStyle = z.infer<typeof TextStyle>;

export const TextLayer = LayerBase.extend({
  type: z.literal("text"),
  role: z.enum(["headline", "subhead", "body", "label", "cta", "caption"]).default("headline"),
  text: z.string().min(1).max(400),
  style: TextStyle.default({
    font: "heading",
    sizePx: 72,
    weight: 700,
    color: "theme.text",
    align: "center",
    lineHeight: 1.1,
    letterSpacing: -0.01,
    italic: false,
    uppercase: false,
    shadow: false,
  }),
  claimIds: z.array(Id).default([]),
});

export const MediaFit = z.enum(["cover", "contain"]);

export const ImageLayer = LayerBase.extend({
  type: z.literal("image"),
  assetId: Id,
  fit: MediaFit.default("cover"),
  radiusPx: z.number().min(0).max(400).default(0),
  shadow: z.boolean().default(false),
  /** Crop in source pixels fractions. */
  crop: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), w: z.number().min(0).max(1), h: z.number().min(0).max(1) }).optional(),
});

/** Use of a SAM segmentation on a video/image layer. */
export const MaskUse = z.object({
  segmentationId: Id,
  /** cutout: only the subject is visible; background layers show through. */
  mode: z.enum(["cutout", "inverse"]).default("cutout"),
  objectIds: z.array(z.string().max(40)).default([]),
  feather: z.number().min(0).max(20).default(1),
  /** Fallback when tracking quality is low or the mask is missing: show unmasked footage. */
  fallback: z.enum(["unmasked", "hide"]).default("unmasked"),
});
export type MaskUse = z.infer<typeof MaskUse>;

export const VideoLayer = LayerBase.extend({
  type: z.literal("video"),
  assetId: Id,
  fit: MediaFit.default("cover"),
  trimInSec: z.number().min(0).default(0),
  trimOutSec: z.number().min(0).optional(),
  playbackRate: z.number().min(0.25).max(4).default(1),
  muted: z.boolean().default(true),
  volume: z.number().min(0).max(1).default(1),
  radiusPx: z.number().min(0).max(400).default(0),
  mask: MaskUse.optional(),
});

/** Real app media shown inside an allowlisted device frame. */
export const DeviceLayer = LayerBase.extend({
  type: z.literal("device"),
  device: z.enum(["iphone", "android", "ipad", "browser", "macbook"]).default("iphone"),
  screenAssetId: Id,
  screenKind: z.enum(["image", "video"]).default("image"),
  trimInSec: z.number().min(0).default(0),
  frameColor: z.enum(["black", "silver", "natural", "white"]).default("black"),
  shadow: z.boolean().default(true),
});

export const ShapeLayer = LayerBase.extend({
  type: z.literal("shape"),
  shape: z.enum(["rect", "circle", "pill", "blob", "line"]),
  fill: ColorValue.default("theme.accent"),
  gradientTo: ColorValue.optional(),
  radiusPx: z.number().min(0).max(1000).default(0),
  blurPx: z.number().min(0).max(200).default(0),
});

/** An allowlisted HyperFrames catalog block (e.g. a follow overlay) with validated params. */
export const BlockLayer = LayerBase.extend({
  type: z.literal("block"),
  blockId: z.string().max(80),
  params: z.record(z.string(), z.union([z.string().max(500), z.number(), z.boolean()])).default({}),
});

export const Layer = z.discriminatedUnion("type", [TextLayer, ImageLayer, VideoLayer, DeviceLayer, ShapeLayer, BlockLayer]);
export type Layer = z.infer<typeof Layer>;
export type LayerType = Layer["type"];

export const Background = z.object({
  kind: z.enum(["solid", "gradient", "image", "video", "blur"]),
  color: ColorValue.optional(),
  colors: z.array(ColorValue).min(2).max(4).optional(),
  angle: z.number().min(0).max(360).default(180),
  assetId: Id.optional(),
  dim: z.number().min(0).max(1).default(0),
});
export type Background = z.infer<typeof Background>;

export const Transition = z.object({
  kind: z.enum(["cut", "fade", "slide-left", "slide-up", "zoom", "blur", "flash", "wipe"]),
  durationSec: z.number().min(0).max(2).default(0.4),
});

export const Scene = z.object({
  id: Id,
  name: z.string().max(80),
  /** Allowlisted template that produced the initial layout (layers remain individually editable). */
  template: z.string().max(60),
  purpose: z.string().max(40).optional(),
  durationSec: z.number().min(0.5).max(60),
  background: Background.default({ kind: "solid", color: "theme.background", angle: 180, dim: 0 }),
  transitionIn: Transition.default({ kind: "cut", durationSec: 0 }),
  layers: z.array(Layer).max(40),
  /** Storyboard scene this came from. */
  storyboardSceneId: Id.optional(),
  notes: z.string().max(1000).optional(),
});
export type Scene = z.infer<typeof Scene>;

export const AudioTrack = z.object({
  id: Id,
  kind: z.enum(["music", "voiceover", "sfx"]),
  assetId: Id,
  startSec: z.number().min(0).default(0),
  endSec: z.number().min(0).optional(),
  trimInSec: z.number().min(0).default(0),
  volume: z.number().min(0).max(1).default(0.8),
  fadeInSec: z.number().min(0).max(10).default(0),
  fadeOutSec: z.number().min(0).max(10).default(0.5),
  /** Lower music under voiceover. */
  duckUnderVoice: z.boolean().default(true),
  /** `tts` voiceover must be labelled as external TTS (spec 8). */
  sourceLabel: z.enum(["licensed_music", "user_upload", "founder_recording", "external_tts", "generated"]),
});
export type AudioTrack = z.infer<typeof AudioTrack>;

export const CaptionCue = z.object({
  id: Id,
  startSec: z.number().min(0),
  endSec: z.number().min(0),
  text: z.string().min(1).max(300),
  speaker: z.string().max(60).optional(),
});
export type CaptionCue = z.infer<typeof CaptionCue>;

export const Captions = z.object({
  enabled: z.boolean().default(false),
  preset: z.enum(["bold-center", "minimal-bottom", "boxed", "word-pop"]).default("boxed"),
  position: z.enum(["top", "center", "bottom"]).default("bottom"),
  /** `transcript` = from Muse Voice Transcribe turns (turn-level timing, not word-level). */
  source: z.enum(["script", "transcript", "manual"]).default("script"),
  transcriptId: Id.optional(),
  cues: z.array(CaptionCue).max(400).default([]),
});
export type Captions = z.infer<typeof Captions>;

export const Theme = z.object({
  mode: z.enum(["light", "dark"]).default("light"),
  background: HexColor,
  surface: HexColor,
  text: HexColor,
  textMuted: HexColor,
  accent: HexColor,
  accent2: HexColor.optional(),
  headingFont: z.string().max(80).default("Inter"),
  bodyFont: z.string().max(80).default("Inter"),
  radiusPx: z.number().min(0).max(80).default(28),
});
export type Theme = z.infer<typeof Theme>;

export const FPS = z.union([z.literal(24), z.literal(25), z.literal(30), z.literal(60)]);

export const CompositionDoc = z.object({
  schemaVersion: z.literal(COMPOSITION_SCHEMA_VERSION),
  title: z.string().max(200),
  kind: z.enum(["video", "static", "carousel"]).default("video"),
  aspectRatio: AspectRatio,
  width: z.number().int().min(320).max(3840),
  height: z.number().int().min(320).max(3840),
  fps: FPS.default(30),
  theme: Theme,
  /** Fractions of each edge to keep clear of platform UI. */
  safeZone: z
    .object({ top: z.number().min(0).max(0.4), bottom: z.number().min(0).max(0.4), left: z.number().min(0).max(0.4), right: z.number().min(0).max(0.4) })
    .default({ top: 0.08, bottom: 0.14, left: 0.05, right: 0.05 }),
  scenes: z.array(Scene).min(1).max(30),
  audio: z.array(AudioTrack).max(8).default([]),
  captions: Captions.default({ enabled: false, preset: "boxed", position: "bottom", source: "script", cues: [] }),
  meta: z
    .object({ storyboardId: Id.optional(), generatedByRunId: Id.optional(), brandProfileVersion: z.number().int().optional() })
    .default({}),
});
export type CompositionDoc = z.infer<typeof CompositionDoc>;

// ---------------------------------------------------------------------------
// Patches (scene/layer-level edit operations; reversible)
// ---------------------------------------------------------------------------

const SceneUpdatable = Scene.pick({ name: true, template: true, purpose: true, durationSec: true, background: true, transitionIn: true, notes: true }).partial();

export const PatchOp = z.discriminatedUnion("op", [
  z.object({ op: z.literal("update_scene"), sceneId: Id, set: SceneUpdatable }),
  z.object({ op: z.literal("add_scene"), scene: Scene, afterSceneId: Id.nullable() }),
  z.object({ op: z.literal("remove_scene"), sceneId: Id }),
  z.object({ op: z.literal("move_scene"), sceneId: Id, afterSceneId: Id.nullable() }),
  z.object({ op: z.literal("add_layer"), sceneId: Id, layer: Layer, index: z.number().int().min(0).optional() }),
  /** Shallow-merges `set` into the layer (nested objects such as `box`/`style` are merged one level deep); result is re-validated. */
  z.object({ op: z.literal("update_layer"), sceneId: Id, layerId: Id, set: z.record(z.string(), z.unknown()) }),
  z.object({ op: z.literal("remove_layer"), sceneId: Id, layerId: Id }),
  z.object({ op: z.literal("reorder_layer"), sceneId: Id, layerId: Id, toIndex: z.number().int().min(0) }),
  z.object({ op: z.literal("update_theme"), set: Theme.partial() }),
  z.object({ op: z.literal("upsert_audio"), track: AudioTrack }),
  z.object({ op: z.literal("remove_audio"), trackId: Id }),
  z.object({ op: z.literal("set_captions"), captions: Captions }),
]);
export type PatchOp = z.infer<typeof PatchOp>;

export const CompositionKind = z.enum(["video", "static", "carousel"]);

export const Composition = BaseEntity.extend({
  appId: Id,
  campaignId: Id.optional(),
  variantId: Id.optional(),
  storyboardId: Id.optional(),
  /** Aspect-ratio variant of another composition. */
  derivedFromCompositionId: Id.optional(),
  title: z.string().max(200),
  kind: CompositionKind,
  aspectRatio: AspectRatio,
  /** Version shown in the editor (moves back on undo). */
  currentVersion: z.number().int().min(1),
  latestVersion: z.number().int().min(1),
  /** Versions available to redo, most recent last. Cleared when a new edit branches. */
  redoStack: z.array(z.number().int().min(1)).default([]),
  status: z.enum(["draft", "rendering", "rendered", "approved", "failed"]).default("draft"),
  lastRender: z
    .object({ jobId: Id, version: z.number().int(), quality: z.enum(["preview", "final"]), assetId: Id.optional(), at: IsoDateTime })
    .optional(),
  thumbnailAssetId: Id.optional(),
  approvedVersion: z.number().int().optional(),
});
export type Composition = z.infer<typeof Composition>;

/** Immutable snapshot. Document id convention: `${compositionId}_v${version}`. */
export const CompositionVersion = BaseEntity.extend({
  compositionId: Id,
  version: z.number().int().min(1),
  parentVersion: z.number().int().min(1).nullable(),
  doc: CompositionDoc,
  patchId: Id.optional(),
  source: z.enum(["generated", "user_edit", "ai_edit", "revert", "duplicate"]),
  summary: z.string().max(500),
  contentHash: z.string().max(128),
  /** Scene content hashes, used to cache unchanged scene renders/previews. */
  sceneHashes: z.record(z.string(), z.string()).default({}),
});
export type CompositionVersion = z.infer<typeof CompositionVersion>;

export const CompositionPatch = BaseEntity.extend({
  compositionId: Id,
  baseVersion: z.number().int().min(1),
  resultVersion: z.number().int().min(1).optional(),
  ops: z.array(PatchOp).min(1).max(100),
  summary: z.string().max(1000),
  source: z.enum(["user", "ai"]),
  instruction: z.string().max(2000).optional(),
  affectedSceneIds: z.array(Id).default([]),
  status: z.enum(["proposed", "applied", "rejected", "invalid"]),
  validationErrors: z.array(z.string().max(500)).default([]),
  agentRunId: Id.optional(),
  memoryRefs: z.array(Id).default([]),
});
export type CompositionPatch = z.infer<typeof CompositionPatch>;
