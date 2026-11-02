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
  return unsupportedFigures(text, support).map((f) => f.issue);
}

/** Same check, keeping the flagged token (the words a fix removes or the founder confirms). */
export function unsupportedFigures(text: string, support: string): { token: string; issue: string }[] {
  const sup = normalizeText(support);
  const out: { token: string; issue: string }[] = [];
  for (const m of text.matchAll(SPECIFIC_NUMBER)) {
    const tok = normalizeText(m[0]);
    if (tok && !sup.includes(tok)) out.push({ token: m[0].trim(), issue: `"${m[0].trim()}" is a specific figure that isn't in your confirmed facts or listing` });
  }
  const s = text.match(SUPERLATIVE);
  if (s && !sup.includes(normalizeText(s[0]))) out.push({ token: s[0], issue: `"${s[0]}" is a superlative that isn't backed by your confirmed facts or listing` });
  const seen = new Set<string>();
  return out.filter((x) => (seen.has(x.issue) ? false : (seen.add(x.issue), true)));
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

/** One problem the model found: the exact words, the unsupported things, and the fact it asserts. */
const ValidatorIssue = z.object({
  quote: z.string().max(300).describe("The exact words in the text that aren't backed, as short as possible (e.g. 'racing, bowling')"),
  terms: z.array(z.string().max(80)).max(6).default([]).describe("Just the unsupported things, in plain words (e.g. ['racing', 'bowling'])"),
  statement: z.string().max(300).describe("The product fact the text asserts, as one short standalone sentence the founder could confirm (e.g. 'Pocket Play has racing and bowling games.')"),
  problem: z.string().max(400).describe("What is unsupported, in a few plain words"),
});

const ValidatorOutput = z.object({
  results: z.array(
    z.object({
      id: z.string(),
      issues: z.array(ValidatorIssue).max(10).default([]),
    }),
  ),
});

/** A validator finding, with the fields the one-tap fixes need (quote, terms, the statement to confirm). */
export interface ClaimIssue {
  id: string;
  issue: string;
  kind: "unsupported" | "figure" | "prohibited";
  quote?: string;
  terms?: string[];
  statement?: string;
}

/** The sentence of `text` that contains `quote` (what a founder would confirm), clipped. */
export function sentenceWith(text: string, quote: string): string | undefined {
  const q = quote.trim().toLowerCase();
  if (!q) return undefined;
  const hit = text
    .split(/\r?\n|(?<=[.!?])\s+/)
    .map((x) => x.trim())
    .find((x) => x.toLowerCase().includes(q));
  return hit ? clip(hit, 300) : undefined;
}

/** Words of `terms` that still appear in `text` (whole-word, case-insensitive). */
export function termsStillIn(text: string, terms: string[]): string[] {
  const norm = ` ${normalizeText(text)} `;
  return terms.filter((t) => {
    const n = normalizeText(t);
    return n.length > 1 && norm.includes(` ${n} `);
  });
}

/**
 * Spark claim validator (INTERFACES.md) for any copy: outreach, captions, scene text.
 * Deterministic checks (prohibited claims, unsupported figures/superlatives) always run; Spark
 * then checks product assertions against the confirmed facts (verified claims) and the app's own
 * listing/website evidence (including facts the founder confirmed). Never reports `ok` without the
 * model check: if Meta isn't configured this throws.
 * Route `claims.validate` (Muse Spark unless listed in SPARK_OPEN_TASKS). With `onFallback` (a run
 * recorder), a Meta capacity failure falls back to Muse Spark Open once, recorded on the run.
 */
export async function validateClaims(
  p: Platform,
  input: { workspaceId: string; appId: string; texts: { id: string; text: string }[]; jobId?: string; agentRunId?: string; onFallback?: (e: FallbackEvent) => Promise<void> | void },
): Promise<{ ok: boolean; issues: ClaimIssue[] }> {
  const texts = input.texts.filter((t) => t.text.trim());
  if (!texts.length) return { ok: true, issues: [] };
  const ws = p.db.ws(input.workspaceId);
  const [profile, claimsPage, evidencePage] = await Promise.all([
    ws.collection("brandProfiles").get(input.appId),
    ws.collection("claims").list({ where: [["appId", "==", input.appId], ["state", "==", "verified"]], orderBy: { field: "createdAt", dir: "desc" }, limit: 150 }),
    ws.collection("appEvidence").list({ where: [["appId", "==", input.appId]], orderBy: { field: "createdAt", dir: "desc" }, limit: 250 }),
  ]);
  const verified = claimsPage.items;
  const evidence = evidencePage.items.filter((e) => e.reviewState === "verified" && TRUSTED_SOURCES.has(e.source.kind));
  const prohibited = profile?.prohibitedClaims ?? [];
  const supportText = [...verified.map((c) => c.text), ...evidence.map((e) => e.fact)].join("\n");

  const issues: ClaimIssue[] = [];
  for (const t of texts) {
    const norm = normalizeText(t.text);
    for (const pc of prohibited) if (pc.trim() && norm.includes(normalizeText(pc))) issues.push({ id: t.id, kind: "prohibited", quote: clip(pc.trim(), 300), terms: [clip(pc.trim(), 80)], issue: `Uses a prohibited claim: "${pc}"` });
    for (const f of unsupportedFigures(t.text, supportText)) issues.push({ id: t.id, kind: "figure", quote: f.token, terms: [f.token], statement: sentenceWith(t.text, f.token), issue: f.issue });
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
        "You are MuseLaunch's claim validator for app marketing. For each text, flag every assertion about the product (features, games or content it includes, categories, platforms, capabilities, results, performance, numbers, rankings, awards, user counts, reviews/testimonials, pricing, comparisons with competitors) that is NOT directly supported by the confirmed facts or the listing evidence provided, or that matches a prohibited claim. " +
        "The listing evidence is what the app's own store listing or website states (including names listed under a heading, like a game line-up) and facts the founder confirmed: anything it plainly states is supported, in its own words or obvious equivalents (a game described as ten-pin bowling supports 'bowling'). " +
        "Do not flag calls to action, questions, descriptions of the viewer's problem, or creative framing that asserts no product fact. Do not flag style or grammar. " +
        "For each issue give the exact words (quote), just the unsupported things (terms), the product fact the text asserts as one standalone sentence (statement), and what is unsupported (problem). Return an entry for every text id (empty issues when fine).",
      input: [
        "Confirmed facts (usable as-is):",
        verified.length ? verified.map((c) => `- ${c.text}`).join("\n") : "- (none confirmed yet)",
        "",
        "Prohibited claims:",
        prohibited.length ? prohibited.map((c) => `- ${c}`).join("\n") : "- (none)",
        "",
        untrusted("listing_evidence", evidence.map((e) => `- [${e.kind}${e.source.kind === "user_input" ? ", founder" : ""}] ${e.fact}`).join("\n") || "(none)", 20_000),
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
    for (const x of r.issues) {
      const quote = x.quote.trim();
      const problem = x.problem.trim();
      if (!quote && !problem) continue;
      issues.push({
        id: r.id,
        kind: "unsupported",
        quote: quote ? clip(quote, 300) : undefined,
        terms: x.terms.map((t) => clip(t.trim(), 80)).filter(Boolean).slice(0, 6),
        statement: x.statement.trim() ? clip(x.statement.trim(), 300) : undefined,
        issue: clip(quote ? `"${quote}": ${problem || "not backed by your confirmed facts or listing"}` : problem, 500),
      });
    }
  }
  return { ok: issues.length === 0, issues };
}
