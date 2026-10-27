/**
 * @muselaunch/autopilot — Growth Autopilot: a bounded, auditable marketing loop orchestrated by
 * Muse Wonder that delegates real work to every module (research, concepts, storyboards,
 * compositions, Brand Guardian, renders, posts, analytics) and logs every decision with citations.
 * Lives in its own package so it can depend on agents/growth/analytics/compositions without cycles.
 */
import type { HandlerRegistry } from "@muselaunch/platform";
import { autopilotStepHandler } from "./step";

export { installAutopilotHooks, wakeDueAutopilots } from "./hooks";
export { startAutopilot, pauseAutopilot, resumeAutopilot, cancelAutopilot, decideCheckpoint, autopilotDetail, estimateAutopilot, type AutopilotDetail } from "./service";
export { setAutopilotClock, reasonText, tagOf, STAGE_ORDER } from "./state";
export { MAX_FIX_ROUNDS, MEASURE_DAYS } from "./stages";

/** Job handlers owned by this package. Registered by apps/worker. */
export const handlers: HandlerRegistry = {
  "autopilot.step": autopilotStepHandler,
};
