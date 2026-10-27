import type { Claim, OutreachDraft } from "@muselaunch/contracts";
import { nowIso, type WorkspaceDb } from "@muselaunch/db";
import { toAppError, type Platform } from "@muselaunch/platform";
import { growthDeps, type ClaimValidator } from "../deps";
import { verifiedClaims } from "../discover/trackers";

let agentsValidator: ClaimValidator | null | undefined;

/** Module B's `validateClaims` (docs/INTERFACES.md), resolved lazily so this module works before B merges. */
async function resolveAgentsValidator(): Promise<ClaimValidator | null> {
  if (agentsValidator !== undefined) return agentsValidator;
  try {
    const mod = (await import("@muselaunch/agents")) as Record<string, unknown>;
    agentsValidator = typeof mod.validateClaims === "function" ? (mod.validateClaims as ClaimValidator) : null;
  } catch {
    agentsValidator = null;
  }
  return agentsValidator;
}

const SUPERLATIVES = /(?:#\s?1\b|\b(?:number one|best|fastest|only (?:app|tool)|guarantee[ds]?|proven|clinically|award[- ]winning|most popular|top[- ]rated|millions? of users|10x)\b)/gi;
const NUMBERS = /(?:\d[\d,.]*(?:\s?(?:k|m|million|thousand))?\+?\s?(?:%|x\b|users|downloads|reviews|stars?|customers|people|ratings))|(?:\d[\d,.]*\s?(?:k|m)\+?\b)|(?:\$\s?\d[\d,.]*)/gi;

/**
 * Deterministic claim rules (always run; the only validator when module B's isn't available):
 * - every referenced claim id must be a verified claim permitted for outreach
 * - no prohibited claims from the brand profile
 * - superlatives and numeric/statistical statements must appear in a verified claim
 */
export function ruleCheck(texts: { id: string; text: string }[], claims: Claim[], prohibited: string[], claimIdsUsed: string[], userOffer?: string): { id: string; issue: string }[] {
  const issues: { id: string; issue: string }[] = [];
  const ok = new Map(claims.map((c) => [c.id, c]));
  for (const id of claimIdsUsed) if (!ok.has(id)) issues.push({ id: "claims", issue: `Claim ${id} is not a verified claim allowed in outreach.` });
  // The user's own confirmed offer may contain figures ("3 months free"); those aren't product claims.
  const verifiedText = [...claims.map((c) => c.text), userOffer ?? ""].join("\n").toLowerCase();
  for (const t of texts) {
    const lower = t.text.toLowerCase();
    for (const p of prohibited) if (p.trim() && lower.includes(p.trim().toLowerCase())) issues.push({ id: t.id, issue: `Uses a prohibited claim: "${p}".` });
    for (const m of t.text.match(SUPERLATIVES) ?? []) if (!verifiedText.includes(m.toLowerCase())) issues.push({ id: t.id, issue: `"${m}" isn't backed by a verified claim.` });
    for (const m of t.text.match(NUMBERS) ?? []) {
      const core = m.replace(/\s+/g, "").toLowerCase();
      if (!verifiedText.replace(/\s+/g, "").includes(core)) issues.push({ id: t.id, issue: `The figure "${m.trim()}" isn't backed by a verified claim.` });
    }
  }
  const seen = new Set<string>();
  return issues.filter((i) => (seen.has(`${i.id}:${i.issue}`) ? false : (seen.add(`${i.id}:${i.issue}`), true)));
}

/** Validate an outreach draft. Returns the `validation` block stored on the draft. */
export async function validateDraft(p: Platform, ws: WorkspaceDb, draft: Pick<OutreachDraft, "appId" | "subject" | "body" | "claimIds" | "offerSource" | "offer">, opts: { jobId?: string } = {}): Promise<NonNullable<OutreachDraft["validation"]>> {
  const claims = await verifiedClaims(ws, draft.appId, "outreach");
  const brand = await ws.collection("brandProfiles").get(draft.appId);
  const texts = [...(draft.subject ? [{ id: "subject", text: draft.subject }] : []), { id: "body", text: draft.body }];
  const issues = ruleCheck(texts, claims, brand?.prohibitedClaims ?? [], draft.claimIds, draft.offerSource === "user" ? draft.offer : undefined);
  if (draft.offerSource === "ai_suggested") issues.push({ id: "offer", issue: "The offer was suggested by AI. Confirm or edit it before requesting approval." });
  let validator: "spark" | "rules" = "rules";
  const injected = growthDeps(p).claimValidator;
  const external = injected !== undefined ? injected : await resolveAgentsValidator();
  if (external) {
    try {
      const r = await external(p, { workspaceId: ws.workspaceId, appId: draft.appId, texts, jobId: opts.jobId });
      validator = "spark";
      for (const i of r.issues) issues.push({ id: i.id.slice(0, 60), issue: i.issue.slice(0, 500) });
      if (!r.ok && !r.issues.length) issues.push({ id: "body", issue: "The claim validator flagged this text." });
    } catch (err) {
      issues.push({ id: "validator", issue: `Claim validator unavailable (${toAppError(err).code}); re-run validation before approval.` });
    }
  }
  return { ok: issues.length === 0, issues: issues.slice(0, 30), checkedAt: nowIso(), validator };
}
