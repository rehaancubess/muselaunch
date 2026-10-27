import type { HandlerRegistry } from "@muselaunch/platform";
import { generateConceptsHandler } from "./concepts";
import { copyGenerateHandler } from "./copy";
import { appAnalyzeHandler } from "./dna/analyze";
import { compositionEditHandler } from "./edit";
import { appImportHandler } from "./import/handler";
import { memoryIngestHandler } from "./memory";
import { researchRunHandler } from "./research/handler";
import { storyboardHandler } from "./storyboard";
import { strategyRunHandler } from "./strategy";

export { retrieveMemory, rememberPreference, ingestMemory, rankPreferences, type MemoryResult } from "./memory";
export { validateClaims, unsupportedSpecifics, initialClaimState } from "./claims";
export { decideStrategy, planSnapshot } from "./strategy";
export { distinctnessProblems } from "./concepts";
export { checkStoryboard, fitDurations } from "./storyboard";
export { checkEdit } from "./edit";
export { CHANNEL_RULES, copyLimitProblems } from "./copy";
export { installFetcher, fetcherFor, fetchResult, type Fetcher } from "./fetcher";
export { RunRecorder } from "./runs";
export { runToolLoop, defineTool, type LoopTool } from "./loop";
export { parseAppStoreUrl, parsePlayUrl, listingFromItunes, listingFromPlayHtml, extractWebsite } from "./import/parsers";
export { paletteFromImages, dominantColors } from "./dna/palette";

/** Job handlers owned by this module (INTERFACES.md). Registered by apps/worker. */
export const handlers: HandlerRegistry = {
  "app.import": appImportHandler,
  "app.analyze": appAnalyzeHandler,
  "research.run": researchRunHandler,
  "strategy.run": strategyRunHandler,
  "campaign.generate_concepts": generateConceptsHandler,
  "storyboard.generate": storyboardHandler,
  "composition.edit": compositionEditHandler,
  "copy.generate": copyGenerateHandler,
  "memory.ingest": memoryIngestHandler,
};
