/**
 * @muselaunch/autopilot — Growth Autopilot: a bounded, auditable marketing loop orchestrated by
 * Muse Wonder that delegates real work to every module (research, concepts, storyboards,
 * compositions, Brand Guardian, renders, posts, analytics) and logs every decision with citations.
 * Lives in its own package so it can depend on agents/growth/analytics/compositions without cycles.
 */
import type { HandlerRegistry } from "@muselaunch/platform";
import { postReviseCopyHandler } from "./post-change";
import { autopilotStepHandler } from "./step";

export { installAutopilotHooks, wakeDueAutopilots, autoRecommendOnNewData, AUTO_RECOMMEND_COOLDOWN_MS } from "./hooks";
export { planAutoStart, startAutoAutopilot, tryStartAutoAutopilot, AUTO_VARIANTS } from "./auto";
export { autopilotSettings, defaultGoal, dnaJobsInFlight } from "./defaults";
export { needsYou } from "./needs-you";
export { advancePostChange, advancePostChangesForJob, CHANGEABLE_POST, estimatePostChange, postReviseCopyHandler, repairPostChanges, requestPostChange, sceneWords, videoChangeLine } from "./post-change";
export { today } from "./today";
export { alwaysOnState, alwaysOnStatus, decidePace, decideSuggestion, ensureAlwaysOnLoop, runAlwaysOn, summaryEmail, updateAlwaysOn, weeklySummary, type AlwaysOnStart, type AlwaysOnTick } from "./always-on";
export {
  ALWAYS_ON_ACTOR,
  alwaysOnSpent,
  alwaysOnView,
  clampPace,
  FIX_ROOM_ROUNDS,
  paceLimit,
  postQueue,
  roundCredits,
  SUGGESTIONS_PER_WEEK,
  videoCredits,
  weekSlots,
  weeklyAllowance,
} from "./always-on-loop";
export { startAutopilot, pauseAutopilot, resumeAutopilot, cancelAutopilot, decideCheckpoint, autopilotDetail, estimateAutopilot, type AutopilotDetail } from "./service";
export { autopilotProgress, mediaAsk } from "./progress";
export { runCost, summarizeCost } from "./cost";
export { setAutopilotClock, reasonText, tagOf, STAGE_ORDER } from "./state";
export { MAX_FIX_ROUNDS, MEASURE_DAYS } from "./stages";

/** Job handlers owned by this package. Registered by apps/worker. */
export const handlers: HandlerRegistry = {
  "autopilot.step": autopilotStepHandler,
  "post.revise_copy": postReviseCopyHandler,
};
