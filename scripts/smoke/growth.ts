import type { Platform } from "@muselaunch/platform";
import { groundObservations, providerCatalog, TrackerResearch } from "@muselaunch/growth";
import { generateJson } from "@muselaunch/providers";
import { saveLive } from "./_save";

/**
 * Module E live smoke: one Spark + web_search call observing a well-known public account, then the
 * same citation grounding discover.refresh applies; plus an honest report of which publishing
 * providers this deployment can connect. Makes no posts and sends nothing.
 */
export async function run(p: Platform): Promise<string> {
  const res = await generateJson(p, {
    ctx: { workspaceId: "smoke", task: "smoke.discover_refresh" },
    model: "spark",
    instructions:
      "Use web search. Describe the recent PUBLIC marketing of the tracked account: positioning, recurring hooks, content formats. Every observation must cite the exact URL of a search result in sourceUrl. No metrics, no guesses. Return JSON only.",
    input: "Channel: youtube\nHandle: @NotionHQ\nTracked as: inspiration\nVerified claims: (none) → comparison = []",
    schema: TrackerResearch,
    schemaName: "TrackerResearch",
    webSearch: { contextSize: "low" },
    maxOutputTokens: 2000,
  });
  saveLive("growth-tracker-research", { data: res.data, citations: res.citations, searchCalls: res.searchCalls });
  const grounded = groundObservations(res.data, [...res.citations, ...res.searchResults], new Map(), new Date().toISOString());
  const providers = providerCatalog(p)
    .map((x) => `${x.provider}:${x.state}`)
    .join(" ");
  return `observations=${res.data.observations.length} grounded=${grounded.observations.length} dropped=${grounded.dropped.length} citations=${res.citations.length} searchCalls=${res.searchCalls} | providers ${providers}`;
}
