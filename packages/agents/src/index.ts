import type { HandlerRegistry } from "@muselaunch/platform";
import { generateConceptsHandler } from "./concepts";
import { copyGenerateHandler } from "./copy";
import { appAnalyzeHandler } from "./dna/analyze";
import { compositionEditHandler } from "./edit";
import { brandReviewHandler } from "./guardian";
import { appImportHandler } from "./import/handler";
import { memoryIngestHandler } from "./memory";
import { researchRunHandler } from "./research/handler";
import { storyboardHandler } from "./storyboard";
import { strategyRunHandler } from "./strategy";

export { retrieveMemory, rememberPreference, ingestMemory, rankPreferences, type MemoryResult } from "./memory";
export { validateClaims, unsupportedSpecifics, initialClaimState } from "./claims";
export { decideStrategy, planSnapshot } from "./strategy";
export { conceptDurations, distinctnessProblems, founderDuration, planMaxVideoSec, seededDuration } from "./concepts";
export { installCampaignHooks, syncCampaignProduction } from "./campaign-status";
export { autoCampaignName, truncateWords } from "./util";
export { checkStoryboard, fitDurations, minSceneSec, polishStoryboard, sceneRange } from "./storyboard";
export { checkEdit } from "./edit";
export { CHANNEL_RULES, copyLimitProblems } from "./copy";
export { installFetcher, fetcherFor, fetchResult, type Fetcher } from "./fetcher";
export { RunRecorder } from "./runs";
export { runToolLoop, defineTool, type LoopTool, type LoopOutcome } from "./loop";
export { searchTool, SourceRegistry, type ResearchOutputs } from "./research/tools";
export { loadAppContext, dnaSummary, productAssets, requireDna, type AppContextData } from "./context";
export { productMediaOptions } from "./media-options";
export { parseAppStoreUrl, parsePlayUrl, listingFromItunes, listingFromPlayHtml, extractWebsite } from "./import/parsers";
export { paletteFromImages, dominantColors } from "./dna/palette";
export * from "./guardian";

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
  "brand.review": brandReviewHandler,
};
