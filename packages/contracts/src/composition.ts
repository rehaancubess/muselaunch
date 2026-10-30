import { z } from "zod";
import { AspectRatio, BaseEntity, HexColor, Id, IsoDateTime, Percent01 } from "./common";
import { MusicMood, SfxKind, SpeechRange, VoiceoverCheck } from "./sound";

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
  // Object-aware templates (SAM tracks + HyperFrames compositing):
  "presenter-depth", // presenter cutout in FRONT, app demo + motion graphics BEHIND them (depth sandwich)
  "object-spotlight", // tracked real object (e.g. the phone) highlighted; callouts anchored to it follow it
  "product-in-hand", // real app recording placed onto the tracked phone in the presenter's hand
  // Editor-style shot variety (on REAL product media or plain type):
  "focus-zoom", // device demo that pushes in on a region of the real screen, with a soft highlight ring
  "tap-demo", // device demo with a finger dot + tap ripple at a point of the real screen
  "phone-tilt", // device in a 3D tilt/turn over a parallax background
  "kinetic-type", // punchy word-by-word typography at a readable pace
  "icon-reveal", // app icon scale-in with glow and the app name
  "store-cta", // end card with plain-text store pills ("Download on the App Store"; no third-party logos)
  "fullscreen-showcase", // a designed marketing screenshot full-bleed with a slow push (never inside a device frame)
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

/** `words`: text appears word by word at a readable pace (about 3 words per second). */
export const EnterPreset = z.enum(["none", "fade", "slide-up", "slide-down", "slide-left", "slide-right", "scale-in", "pop", "blur-in", "typewriter", "mask-reveal", "words"]);
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

/**
 * SAM object id as referenced from a composition (SAM returns small integers as strings).
 * SECURITY: composition docs are user/LLM-editable and compiled into HTML + an inline timeline
 * script, so ids that reach the compiler are restricted to a safe charset (no quotes, angle
 * brackets or backslashes), like every other id in the doc.
 */
export const ObjectKey = z.string().regex(/^[A-Za-z0-9_.:-]{1,40}$/, "invalid object id");

/**
 * Pins a layer to a SAM-tracked object: the compiler drives the layer's position (and optionally
 * scale) from the object's per-frame track, so labels/graphics follow real objects in footage.
 * `box` remains the fallback position when the object is not visible.
 */
export const ObjectAnchor = z.object({
  segmentationId: Id,
  objectId: ObjectKey,
  point: z.enum(["center", "top", "bottom", "left", "right", "top-left", "top-right", "bottom-left", "bottom-right"]).default("center"),
  /** Offset from the anchor point, in frame fractions. */
  offset: z.object({ x: z.number().min(-1).max(1).default(0), y: z.number().min(-1).max(1).default(0) }).default({ x: 0, y: 0 }),
  scaleWithObject: z.boolean().default(false),
  /** Smoothing window (frames) to remove tracking jitter. */
  smoothFrames: z.number().int().min(0).max(30).default(5),
  /** When the object leaves frame: hold last position or hide the layer. */
  whenLost: z.enum(["hold", "hide"]).default("hide"),
});
export type ObjectAnchor = z.infer<typeof ObjectAnchor>;

const LayerBase = z.object({
  id: Id,
  name: z.string().max(80).optional(),
  box: Box,
  /** Optional: follow a tracked object (see ObjectAnchor). */
  anchor: ObjectAnchor.optional(),
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
  objectIds: z.array(ObjectKey).default([]),
  feather: z.number().min(0).max(20).default(1),
  /** Fallback when tracking quality is low or the mask is missing: show unmasked footage. */
  fallback: z.enum(["unmasked", "hide"]).default("unmasked"),
});
export type MaskUse = z.infer<typeof MaskUse>;

/** A normalised region (fractions 0..1 of the media or screen it belongs to). */
export const Region01 = z.object({ x: Percent01, y: Percent01, w: Percent01, h: Percent01 });
export type Region01 = z.infer<typeof Region01>;

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
  /** Regions of the frame (fractions of the layer box) blurred for privacy, e.g. personal info in a recording. */
  blurRegions: z.array(Region01).max(8).optional(),
});

/**
 * Push-in on a region of the device SCREEN (fractions of the visible screen), with a soft highlight
 * ring around it. `zoom` omitted = fitted so the region fills a comfortable part of the frame.
 */
export const DeviceFocus = Region01.extend({
  zoom: z.number().min(1).max(4).optional(),
  /** When the push-in starts (seconds into the layer). */
  atSec: z.number().min(0).max(60).default(0.6),
  ring: z.boolean().default(true),
});
export type DeviceFocus = z.infer<typeof DeviceFocus>;

/** A finger tap (dot + ripple) at a point of the device SCREEN (fractions of the visible screen). */
export const DeviceTap = z.object({ x: Percent01, y: Percent01, atSec: z.number().min(0).max(60).default(1) });
export type DeviceTap = z.infer<typeof DeviceTap>;

/** 3D orientation in degrees: x tips the top away (pitch), y turns the device (yaw). `swing` eases toward a calmer angle over the layer's life. */
export const DeviceTilt = z.object({ x: z.number().min(-45).max(45).default(8), y: z.number().min(-60).max(60).default(-20), swing: z.boolean().default(true) });
export type DeviceTilt = z.infer<typeof DeviceTilt>;

/** Real app media shown inside an allowlisted device frame. */
export const DeviceLayer = LayerBase.extend({
  type: z.literal("device"),
  device: z.enum(["iphone", "android", "ipad", "browser", "macbook"]).default("iphone"),
  screenAssetId: Id,
  screenKind: z.enum(["image", "video"]).default("image"),
  trimInSec: z.number().min(0).default(0),
  /** Video screens: end of the trimmed range (e.g. a walkthrough segment). Informational; scene length × rate decides what plays. */
  trimOutSec: z.number().min(0).optional(),
  /** Video screens: playback speed (the builder speeds long walkthrough segments up to 1.5×). */
  playbackRate: z.number().min(0.25).max(4).optional(),
  frameColor: z.enum(["black", "silver", "natural", "white"]).default("black"),
  shadow: z.boolean().default(true),
  focus: DeviceFocus.optional(),
  tap: DeviceTap.optional(),
  tilt: DeviceTilt.optional(),
  /** Regions of the SCREEN (fractions of the visible screen) blurred for privacy. */
  blurRegions: z.array(Region01).max(8).optional(),
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

/**
 * Object-aware effect driven by a SAM track/matte of the SAME source clip shown in the scene.
 * - spotlight: dim everything except the object
 * - outline-glow: animated glow following the object's matte edge
 * - focus-blur: blur everything except the object (depth-of-field look)
 * - highlight-ring: ring/rounded-rect that follows the object's bbox
 * - follow-arrow: pointer that tracks the object
 * - screen-insert: places `assetId` (REAL app recording/screenshot) onto the tracked object region
 *   (e.g. the phone screen in the presenter's hand), clipped by the object's matte
 */
export const EffectLayer = LayerBase.extend({
  type: z.literal("effect"),
  effect: z.enum(["spotlight", "outline-glow", "focus-blur", "highlight-ring", "follow-arrow", "screen-insert"]),
  target: z.object({ segmentationId: Id, objectId: ObjectKey }),
  color: ColorValue.optional(),
  intensity: z.number().min(0).max(1).default(0.7),
  /** screen-insert only: real product media (isProductTruth) to place on the object. */
  assetId: Id.optional(),
  /** screen-insert only: inset of the screen inside the object's bbox (fractions). */
  inset: z.object({ top: z.number().min(0).max(0.5), right: z.number().min(0).max(0.5), bottom: z.number().min(0).max(0.5), left: z.number().min(0).max(0.5) }).optional(),
});

export const Layer = z.discriminatedUnion("type", [TextLayer, ImageLayer, VideoLayer, DeviceLayer, ShapeLayer, BlockLayer, EffectLayer]);
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
  /**
   * `tts` voiceover must be labelled as external TTS (spec 8). `original_music` / `original_sfx`:
   * synthesized by MuseLaunch's own code (owned, no samples).
   */
  sourceLabel: z.enum(["licensed_music", "user_upload", "founder_recording", "external_tts", "generated", "original_music", "original_sfx"]),
  /** Placed by MuseLaunch's sound pass; re-placed when scenes change. Tracks without it are the user's. Additive. */
  auto: z.boolean().optional(),
  /** Display name, e.g. "Whoosh into scene 3". Additive. */
  label: z.string().max(80).optional(),
  /** sfx: which synthesized effect. Additive. */
  sfx: SfxKind.optional(),
  /** music: the mood preset it was rendered with. Additive. */
  mood: MusicMood.optional(),
  /** voiceover: spoken stretches (track-local seconds, Muse Voice Transcribe turns) used to duck music. Additive. */
  speech: z.array(SpeechRange).max(200).optional(),
  /** voiceover: script check by Muse Voice Transcribe (AI voice). Additive. */
  check: VoiceoverCheck.optional(),
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
  /** Music + voiceover + automatically placed sound effects (one short track per effect). */
  audio: z.array(AudioTrack).max(48).default([]),
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
  /** Empty while a `proposed` AI patch is still being generated by `composition.edit`. */
  ops: z.array(PatchOp).max(100),
  summary: z.string().max(1000),
  source: z.enum(["user", "ai"]),
  instruction: z.string().max(2000).optional(),
  affectedSceneIds: z.array(Id).default([]),
  status: z.enum(["proposed", "applied", "rejected", "invalid"]),
  validationErrors: z.array(z.string().max(500)).default([]),
  agentRunId: Id.optional(),
  memoryRefs: z.array(Id).default([]),
  /** AI patches: the model that wrote the ops (e.g. "muse-spark-1.3", "meta-models/muse-spark-open-1026"). Additive. */
  model: z.string().max(80).optional(),
  /** Why that model was used when it wasn't the planned one (a visible fallback). Additive. */
  modelNote: z.string().max(300).optional(),
});
export type CompositionPatch = z.infer<typeof CompositionPatch>;
