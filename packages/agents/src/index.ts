import type { HandlerRegistry } from "@muselaunch/platform";
import { appAnalyzeHandler } from "./dna/analyze";
import { appImportHandler } from "./import/handler";
import { memoryIngestHandler } from "./memory";

export { retrieveMemory, rememberPreference, ingestMemory, rankPreferences, type MemoryResult } from "./memory";
export { validateClaims, unsupportedSpecifics, initialClaimState } from "./claims";
export { installFetcher, fetcherFor, fetchResult, type Fetcher } from "./fetcher";
export { RunRecorder } from "./runs";
export { parseAppStoreUrl, parsePlayUrl, listingFromItunes, listingFromPlayHtml, extractWebsite } from "./import/parsers";
export { paletteFromImages, dominantColors } from "./dna/palette";

/** Job handlers owned by this module. Registered by apps/worker. */
export const handlers: HandlerRegistry = {
  "app.import": appImportHandler,
  "app.analyze": appAnalyzeHandler,
  "memory.ingest": memoryIngestHandler,
};
