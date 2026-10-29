import type { AppEvidence, Claim } from "@muselaunch/contracts";
import type { Platform } from "@muselaunch/platform";
import { routedJson, untrusted, type FallbackEvent } from "@muselaunch/providers";
import { z } from "zod";
import { clip, normalizeText } from "./util";

const SUPERLATIVE = /(?:\b(?:best|number\s?one|fastest|leading|the only|the first|guarantee[ds]?|proven|clinically|award[- ]winning|top[- ]rated|most popular|world'?s)\b|#\s?1\b|\bno\.\s?1\b|\b100\s?%)/i;
const SPECIFIC_NUMBER = /(\d+(?:[.,]\d+)?\s?(?:%|x\b|k\b|m\b|million|thousand|billion|users|downloads|customers|reviews|stars?))|\b\d{1,3}(?:,\d{3})+\b|\b(?!(?:19|20)\d{2}\b)\d{4,}\b/gi;

/** Evidence kinds whose facts come from real sources (not model observation) and can back a claim. */
const TRUSTED_SOURCES = new Set(["store_listing", "user_input", "url", "upload", "document", "api"]);

/**
 * Deterministic guard: numbers, multipliers and superlatives in `text` must literally appear in
 * the supporting material. Conservative by design — false positives go to human review.
 */
export function unsupportedSpecifics(text: string, support: string): string[] {
  const sup = normalizeText(support);
  const issues: string[] = [];
  for (const m of text.matchAll(SPECIFIC_NUMBER)) {
    const tok = normalizeText(m[0]);
    if (tok && !sup.includes(tok)) issues.push(`"${m[0].trim()}" is a specific figure that isn't in your verified claims or listing`);
  }
  const s = text.match(SUPERLATIVE);
  if (s && !sup.includes(normalizeText(s[0]))) issues.push(`"${s[0]}" is a superlative that isn't backed by your verified claims or listing`);
  return [...new Set(issues)];
}

/**
 * Initial review state for an extracted claim: `verified` only when the model says it is directly
 * stated by listing/user text, the cited evidence is real (not a model observation) and no
 * unsupported figure/superlative appears. Everything else needs human review.
 */
export function initialClaimState(text: string, support: "direct" | "inferred", evidence: AppEvidence[]): { state: Claim["state"]; speculative: boolean } {
  const usable = evidence.filter((e) => e.reviewState === "verified" && TRUSTED_SOURCES.has(e.source.kind));
  const specifics = unsupportedSpecifics(text, usable.map((e) => `${e.fact} ${e.source.excerpt ?? ""}`).join("\n"));
  if (support === "direct" && usable.length > 0 && specifics.length === 0) return { state: "verified", speculative: false };
  return { state: "needs_review", speculative: support === "inferred" || usable.length === 0 || specifics.length > 0 };
}

const ValidatorOutput = z.object({
  results: z.array(
    z.object({
      id: z.string(),
      issues: z.array(z.string().max(500)).max(10).default([]),
    }),
  ),
});

/**
 * Spark claim validator (INTERFACES.md) for any copy: outreach, captions, scene text.
 * Deterministic checks (prohibited claims, unsupported figures/superlatives) always run; Spark
 * then checks product assertions against the verified claim library and listing evidence.
 * Never reports `ok` without the model check: if Meta isn't configured this throws.
 * Route `claims.validate` (Muse Spark unless listed in SPARK_OPEN_TASKS). With `onFallback` (a run
 * recorder), a Meta capacity failure falls back to Muse Spark Open once, recorded on the run.
 */
export async function validateClaims(
  p: Platform,
  input: { workspaceId: string; appId: string; texts: { id: string; text: string }[]; jobId?: string; agentRunId?: string; onFallback?: (e: FallbackEvent) => Promise<void> | void },
): Promise<{ ok: boolean; issues: { id: string; issue: string }[] }> {
  const texts = input.texts.filter((t) => t.text.trim());
  if (!texts.length) return { ok: true, issues: [] };
  const ws = p.db.ws(input.workspaceId);
  const [profile, claimsPage, evidencePage] = await Promise.all([
    ws.collection("brandProfiles").get(input.appId),
    ws.collection("claims").list({ where: [["appId", "==", input.appId], ["state", "==", "verified"]], orderBy: { field: "createdAt", dir: "desc" }, limit: 100 }),
    ws.collection("appEvidence").list({ where: [["appId", "==", input.appId]], orderBy: { field: "createdAt", dir: "desc" }, limit: 150 }),
  ]);
  const verified = claimsPage.items;
  const evidence = evidencePage.items.filter((e) => e.reviewState === "verified" && TRUSTED_SOURCES.has(e.source.kind));
  const prohibited = profile?.prohibitedClaims ?? [];
  const supportText = [...verified.map((c) => c.text), ...evidence.map((e) => e.fact)].join("\n");

  const issues: { id: string; issue: string }[] = [];
  for (const t of texts) {
    const norm = normalizeText(t.text);
    for (const pc of prohibited) if (pc.trim() && norm.includes(normalizeText(pc))) issues.push({ id: t.id, issue: `Uses a prohibited claim: "${pc}"` });
    for (const s of unsupportedSpecifics(t.text, supportText)) issues.push({ id: t.id, issue: s });
  }

  const out = await routedJson(
    p,
    {
      ctx: { workspaceId: input.workspaceId, task: "claims.validate", appId: input.appId, jobId: input.jobId, agentRunId: input.agentRunId },
      model: "spark",
      cacheKey: "agents.claims.validate",
      reasoningEffort: "low",
      maxOutputTokens: 3000,
      instructions:
        "You are MuseLaunch's claim validator for app marketing. For each text, flag every assertion about the product (features, capabilities, results, performance, numbers, rankings, awards, user counts, reviews/testimonials, pricing, comparisons with competitors) that is NOT directly supported by the verified claims or listing evidence provided, or that matches a prohibited claim. " +
        "Do not flag calls to action, questions, descriptions of the viewer's problem, or creative framing that asserts no product fact. Do not flag style or grammar. " +
        "Each issue must quote the problematic phrase and say what is unsupported. Return an entry for every text id (empty issues when fine).",
      input: [
        "Verified claims (usable as-is):",
        verified.length ? verified.map((c) => `- ${c.text}`).join("\n") : "- (none verified yet)",
        "",
        "Prohibited claims:",
        prohibited.length ? prohibited.map((c) => `- ${c}`).join("\n") : "- (none)",
        "",
        untrusted("listing_evidence", evidence.map((e) => `- [${e.kind}] ${e.fact}`).join("\n") || "(none)", 15_000),
        "",
        "Texts to check (JSON lines):",
        untrusted("copy_to_check", texts.map((t) => JSON.stringify({ id: t.id, text: clip(t.text, 3000) })).join("\n"), 40_000),
      ].join("\n"),
      schema: ValidatorOutput,
      schemaName: "ClaimValidation",
    },
    { route: "claims.validate", onFallback: input.onFallback },
  );
  const ids = new Set(texts.map((t) => t.id));
  for (const r of out.data.results) {
    if (!ids.has(r.id)) continue;
    for (const issue of r.issues) if (issue.trim()) issues.push({ id: r.id, issue: clip(issue.trim(), 500) });
  }
  return { ok: issues.length === 0, issues };
}
