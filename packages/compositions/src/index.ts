/**
 * @muselaunch/compositions — pure TypeScript (Node + browser).
 * CompositionDoc validation, reversible patches, lint, LLM description, hashing,
 * the allowlisted template catalog, storyboard → doc builder and the HyperFrames compiler.
 * Persistence lives in `@muselaunch/compositions/store` (Node only).
 */
export { validateDoc, totalDuration, sceneStarts, type ValidateResult } from "./validate";
export { applyPatch, PatchError, type ApplyResult } from "./patch";
export { lintDoc, lintPasses, estimateTextHeight, type LintIssue, type LintContext } from "./lint";
export { describeForLLM } from "./describe";
export { sceneHash, docHash, sceneHashes, canonicalJson, sha256Hex } from "./hash";
export { TEMPLATE_CATALOG, type TemplateInfo, type TemplateNeed } from "./catalog";
export { BLOCK_IDS, BLOCK_PARAMS, type BlockId } from "./blocks";
export { compileToHtml, collectAssetRefs, ROOT_COMPOSITION_ID, type CompileOptions, type CompileResult, type SegmentationInfo } from "./compile";
export { buildFromStoryboard, themeFromBrand, type BuildInput } from "./build";
export { registerCompileRuntime, getCompileRuntime, type CompileRuntime } from "./runtime";
