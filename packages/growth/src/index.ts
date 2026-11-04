import type { HandlerRegistry } from "@muselaunch/platform";
import { discoverRefreshHandler } from "./discover/refresh";
import { outreachDraftHandler } from "./outreach/draft";
import { outreachSendHandler } from "./outreach/service";
import { postFixFactsHandler } from "./publishing/facts";
import { publishPostHandler } from "./publishing/publish-job";

/** Job handlers owned by this module. Registered by apps/worker. */
export const handlers: HandlerRegistry = {
  "discover.refresh": discoverRefreshHandler,
  "outreach.draft": outreachDraftHandler,
  "outreach.send": outreachSendHandler,
  "publish.post": publishPostHandler,
  "post.fix_facts": postFixFactsHandler,
};

export * from "./deps";
export * from "./approvals";
export * from "./connections";
export * from "./discover/feed";
export * from "./discover/trackers";
export * from "./discover/opportunities";
export { CREDITS_PER_TRACKER, MAX_TRACKERS_PER_REFRESH, groundObservations, TrackerResearch } from "./discover/refresh";
export * from "./outreach/contacts";
export { ruleCheck, validateDraft } from "./outreach/claims";
export * from "./outreach/service";
export { PitchOut } from "./outreach/draft";
export * from "./publishing/manual";
export {
  CAPTION_LIMIT,
  captionLength,
  channelMediaRules,
  compositionHasAiVoice,
  disclosedCaption,
  MANUAL_MAX_IMAGES,
  MAX_POST_MEDIA,
  needsMedia,
  renderMediaFor,
  slideSet,
  withAiVoiceLineFor,
  type RenderMedia,
} from "./publishing/media";
export * from "./publishing/posts";
export * from "./publishing/facts";
export * from "./publishing/schedule";
export { SEALED_STATE_VALUE, publishStateSecretId } from "./publishing/publish-job";
