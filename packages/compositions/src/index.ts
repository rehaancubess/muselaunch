/**
 * @muselaunch/compositions — pure TypeScript (Node + browser).
 * CompositionDoc validation, reversible patches, lint, LLM description, hashing,
 * the allowlisted template catalog, storyboard → doc builder and the HyperFrames compiler.
 * Persistence lives in `@muselaunch/compositions/store` (Node only).
 */
export { validateDoc, totalDuration, sceneStarts, type ValidateResult } from "./validate";
export { applyPatch, PatchError, type ApplyResult } from "./patch";
export { lintDoc, lintPasses, estimateTextHeight, type LintIssue, type LintContext } from "./lint";
export { describeForLLM, describeClipObjects, OBJECT_AWARE_VOCABULARY } from "./describe";
export { sceneHash, docHash, sceneHashes, canonicalJson, sha256Hex } from "./hash";
export { TEMPLATE_CATALOG, TEMPLATE_SHOT, DEVICE_TEMPLATES, PRODUCT_SCENE_TEMPLATES, CTA_TEMPLATES, type TemplateInfo, type TemplateNeed, type ShotSize } from "./catalog";
export { BLOCK_IDS, BLOCK_PARAMS, type BlockId } from "./blocks";
export { compileToHtml, collectAssetRefs, deviceGeometry, ROOT_COMPOSITION_ID, type CompileOptions, type CompileResult, type DeviceGeometry, type SegmentationInfo } from "./compile";
export { buildFromStoryboard, mediaToScreen, themeFromBrand, type BuildInput, type ScreenMedia } from "./build";
export { registerCompileRuntime, getCompileRuntime, type CompileRuntime } from "./runtime";
export { adaptToAspect } from "./variants";
export { posterTimeSec } from "./poster";
export { clipMapping, sampleTrack, trackUsable, trackQuality, MIN_TRACK_QUALITY, type ClipMapping, type TrackSample } from "./objects";
