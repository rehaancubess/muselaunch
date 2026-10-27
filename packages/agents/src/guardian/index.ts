/**
 * Brand Guardian (module G): Muse Glimmer as the local brand/claims reviewer + deterministic rules.
 * Job `brand.review` ({appId, reviewId}); producers create the BrandReview first
 * (`requestBrandReview`). Gates: `brandGate` (final render, approval requests).
 */
export { brandReviewHandler, executeReview, loadBrandContext, mergeFindings, statusOf, isTerminalReview, fingerprintTag, GUARDIAN_ALLOW_TAG, type ExecuteOptions } from "./review";
export { requestBrandReview, brandGate, dismissFinding, applyFinding, listReviews, reviewsFor, reviewBrief, GATE_GLIMMER_TIMEOUT_MS, type GateInput, type RequestReviewInput } from "./service";
export { runRules, validOps, fingerprintOf, PLATFORM_VIDEO, type BrandContext, type DraftFinding } from "./rules";
export { glimmerReview, buildPacket, normaliseGlimmerFindings, GUARDIAN_SYSTEM, type GlimmerReviewResult } from "./glimmer";
export { loadSubject, describeSubject, isSubjectEntity, SUBJECT_ENTITIES, type LoadedSubject, type SubjectText } from "./subject";
export { newAssetProblems, isRealProductMedia, appAssetsById, assetIdsIn } from "./assets";
export { contrastRatio, colorDistance, deltaE2000, parseHex, resolveColor } from "./color";
