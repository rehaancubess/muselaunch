/**
 * Spark video review (Track 4): Muse Spark watches frames of a rendered MP4 and reviews what viewers
 * see; findings drive a scene-scoped fix through `composition.edit`. Job `video.review`.
 */
export {
  videoReviewHandler,
  requestVideoReview,
  ensureVideoReview,
  renderForVersion,
  videoReviewsFor,
  videoReviewId,
  isTerminalVideoReview,
  videoFixPlan,
  markFixRequested,
  requestVideoFix,
  mergeVideoFindings,
  videoVerdictOf,
  videoReviewLine,
  videoCheckLabel,
  reviewPromptText,
  VideoReviewDraft,
  VIDEO_REVIEW_INSTRUCTIONS,
  type RequestVideoReviewInput,
  type VideoFixPlan,
} from "./video-review";
export {
  videoAutofixHandler,
  installVideoAutofixHooks,
  autofixStepFor,
  autofixRoundOf,
  autofixRoundOfPatch,
  autofixPatchId,
  autofixRunId,
  autofixRoundCredits,
  autopilotOwning,
  videoReviewSettings,
  AUTOFIX_MAX_ROUNDS,
  AUTOFIX_TRIGGER_JOBS,
} from "./autofix";
export { sceneFacts, readingFindings, frameInFrameFindings, repetitionFindings, blankFrameFindings, frameStats, wordCount, READING_WPS, HOOK_BLOCKER_WPS, type SceneFacts, type MeasuredFinding, type FrameStats } from "./measure";
