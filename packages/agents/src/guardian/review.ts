import type { BrandFinding, BrandPreference, BrandReview, Claim } from "@muselaunch/contracts";
import type { WorkspaceDb } from "@muselaunch/db";
import { AppError, toAppError, type JobContext, type JobResult, type Platform } from "@muselaunch/platform";
import { glimmerClient } from "@muselaunch/providers";
import { retrieveMemory } from "../memory";
import { clip, sha256 } from "../util";
import { glimmerReview } from "./glimmer";
import { runRules, type BrandContext, type DraftFinding } from "./rules";
import { loadSubject, subjectQuery, type LoadedSubject } from "./subject";

/** Tag on brandPreferences recorded when a finding is dismissed (future reviews skip that issue). */
export const GUARDIAN_ALLOW_TAG = "guardian-allow";
export const fingerprintTag = (fingerprint: string) => `gf-${sha256(fingerprint).slice(0, 16)}`;

const TERMINAL: readonly BrandReview["status"][] = ["passed", "warnings", "blocked"];
export const isTerminalReview = (r: Pick<BrandReview, "status">) => TERMINAL.includes(r.status);

/** Evidence kinds whose facts come from real sources and can back a figure/superlative. */
const TRUSTED_SOURCES = new Set(["store_listing", "user_input", "url", "upload", "document", "api"]);
const SEVERITY_RANK: Record<BrandFinding["severity"], number> = { block: 0, warn: 1, info: 2 };

export interface LoadedBrand {
  brand: BrandContext;
  /** fingerprint tag → preference id (dismissed findings the team allowed). */
  allowed: Map<string, string>;
}

/** Brand kit, verified claims, listing evidence and remembered decisions for one app (this workspace only). */
export async function loadBrandContext(ws: WorkspaceDb, s: LoadedSubject): Promise<LoadedBrand> {
  const appId = s.appId;
  const [app, dna, claims, evidence, prefs] = await Promise.all([
    ws.collection("apps").getOrThrow(appId),
    ws.collection("brandProfiles").get(appId),
    ws.collection("claims").list({ where: [["appId", "==", appId], ["state", "==", "verified"]], orderBy: { field: "createdAt", dir: "desc" }, limit: 100 }),
    ws.collection("appEvidence").list({ where: [["appId", "==", appId]], orderBy: { field: "createdAt", dir: "desc" }, limit: 150 }),
    ws.collection("brandPreferences").list({ where: [["active", "==", true]], orderBy: { field: "createdAt", dir: "desc" }, limit: 200 }),
  ]);
  const referenced = [...new Set(s.texts.flatMap((t) => t.claimIds))];
  const extra = referenced.length ? ((await ws.collection("claims").getMany(referenced)) as Claim[]).filter((c) => c.appId === appId) : [];
  const claimsById = new Map<string, Claim>([...claims.items, ...extra].map((c) => [c.id, c]));
  const facts = evidence.items.filter((e) => e.reviewState === "verified" && TRUSTED_SOURCES.has(e.source.kind)).map((e) => `${e.fact} ${e.source.excerpt ?? ""}`);
  const scoped = prefs.items.filter((x) => !x.appId || x.appId === appId);
  const constraints: BrandContext["constraints"] = [];
  const allowed = new Map<string, string>();
  for (const pref of scoped) {
    const m = pref.kind === "constraint" ? /^Do not claim:\s*"(.+)"\s*$/i.exec(pref.text.trim()) : null;
    if (m?.[1]) constraints.push({ preferenceId: pref.id, phrase: m[1] });
    if (pref.tags.includes(GUARDIAN_ALLOW_TAG)) for (const t of pref.tags) if (t.startsWith("gf-")) allowed.set(t, pref.id);
  }
  return {
    brand: { appName: app.name, brand: dna, verifiedClaims: claims.items, claimsById, supportText: [...claims.items.map((c) => c.text), ...facts].join("\n"), constraints },
    allowed,
  };
}

const locKey = (f: Pick<BrandFinding, "location">) => f.location?.layerId ?? f.location?.copyItemId ?? f.location?.field ?? f.location?.sceneId ?? "";

/** Merge rule + Glimmer findings: drop Glimmer repeats of rule issues, drop allowed issues, stable ids, sort. */
export function mergeFindings(rules: DraftFinding[], glimmer: DraftFinding[], allowed: Map<string, string>): { findings: BrandFinding[]; suppressedBy: string[] } {
  const ruleQuotes = rules.filter((r) => r.quote).map((r) => ({ key: locKey(r), quote: r.quote!.toLowerCase() }));
  const g = glimmer.filter((f) => {
    if (!f.quote) return true;
    const q = f.quote.toLowerCase();
    return !ruleQuotes.some((r) => r.key === locKey(f) && (r.quote.includes(q) || q.includes(r.quote)));
  });
  const suppressedBy: string[] = [];
  const seen = new Set<string>();
  const out: (BrandFinding & { order: number })[] = [];
  [...rules, ...g].forEach((f, order) => {
    const key = fingerprintTag(f.fingerprint);
    const allow = allowed.get(key);
    if (allow) {
      suppressedBy.push(allow);
      return;
    }
    const id = `bf_${sha256(`${f.source}|${f.fingerprint}|${locKey(f)}`).slice(0, 20)}`;
    if (seen.has(id)) return; // identical issue reported twice at the same place
    seen.add(id);
    const { fingerprint: _fp, ...rest } = f;
    out.push({ ...rest, id, key, order });
  });
  out.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.order - b.order);
  return { findings: out.slice(0, 100).map(({ order: _o, ...f }) => f), suppressedBy: [...new Set(suppressedBy)] };
}

/** Status from the findings nobody dismissed. */
export function statusOf(findings: BrandFinding[]): "passed" | "warnings" | "blocked" {
  const open = findings.filter((f) => f.resolution?.state !== "dismissed");
  if (open.some((f) => f.severity === "block")) return "blocked";
  if (open.some((f) => f.severity === "warn")) return "warnings";
  return "passed";
}

export function countsLine(findings: BrandFinding[]): string {
  const open = findings.filter((f) => !f.resolution);
  const n = (sev: BrandFinding["severity"]) => open.filter((f) => f.severity === sev).length;
  const parts = [n("block") && `${n("block")} blocking`, n("warn") && `${n("warn")} warning${n("warn") === 1 ? "" : "s"}`, n("info") && `${n("info")} note${n("info") === 1 ? "" : "s"}`].filter(Boolean);
  return parts.length ? parts.join(" · ") : "No issues found";
}

function glimmerNote(err: unknown): string {
  const e = toAppError(err);
  if (e.code === "PROVIDER_NOT_CONFIGURED") return "Muse Glimmer isn't connected on this deployment (GLIMMER_BASE_URL not set), so only the deterministic rules ran.";
  if (e.code === "TIMEOUT") return "Muse Glimmer didn't answer in time, so only the deterministic rules ran.";
  if (e.code === "PROVIDER_ERROR") return "Muse Glimmer's answer couldn't be validated, so only the deterministic rules ran.";
  return `Muse Glimmer was unreachable (${clip(e.message, 120)}), so only the deterministic rules ran.`;
}

export interface ExecuteOptions {
  actor: string;
  jobId?: string;
  signal?: AbortSignal;
  /** Glimmer timeout; gates use a shorter one so a slow GPU never stalls a render request. */
  glimmerTimeoutMs?: number;
  progress?: (pct: number, stage: string) => Promise<void>;
}

/**
 * Run a review: deterministic rules + (when configured) Muse Glimmer reasoning over retrieved
 * memory. Never pretends Glimmer ran and never substitutes a cloud model: without Glimmer the review
 * is labelled rules-only with the reason. Idempotent: a finished review is returned unchanged.
 */
export async function executeReview(p: Platform, workspaceId: string, reviewId: string, opts: ExecuteOptions): Promise<BrandReview> {
  const ws = p.db.ws(workspaceId);
  const repo = ws.collection("brandReviews");
  const review = await repo.getOrThrow(reviewId);
  if (isTerminalReview(review)) return review;
  const started = Date.now();
  try {
    await repo.update(reviewId, { status: "running", error: undefined, ...(opts.jobId ? { jobId: opts.jobId } : {}) }, { actor: opts.actor });
    const subject = await loadSubject(ws, review.subject, review.subjectVersion);
    if (subject.appId !== review.appId) throw new AppError("BAD_REQUEST", "Review subject belongs to another app");
    if (review.contentHash && subject.contentHash !== review.contentHash) {
      throw new AppError("CONFLICT", "The content changed before the review ran", { userMessage: "This content changed before Brand Guardian could review it. Run the review again." });
    }
    await opts.progress?.(15, "Loading brand kit, claims and memory");
    const { brand, allowed } = await loadBrandContext(ws, subject);
    const ruleFindings = runRules(subject, brand);
    let memory: BrandPreference[] = [];
    let glimmer: Awaited<ReturnType<typeof glimmerReview>> | null = null;
    let note: string | undefined;
    if (glimmerClient(p).configured) {
      const mem = await retrieveMemory(p, { workspaceId, appId: subject.appId, task: "brand_review", query: subjectQuery(subject), limit: 8, jobId: opts.jobId });
      memory = mem.items;
      await opts.progress?.(40, "Muse Glimmer is reviewing locally");
      try {
        glimmer = await glimmerReview(
          p,
          { workspaceId, task: "brand.review", appId: subject.appId, jobId: opts.jobId, actor: opts.actor, signal: opts.signal },
          { subject, brand, memory, ruleFindings, timeoutMs: opts.glimmerTimeoutMs },
        );
      } catch (err) {
        if (toAppError(err).code === "CANCELLED") throw err;
        note = glimmerNote(err);
        p.log.warn({ err: (err as Error).message, reviewId }, "brand guardian: glimmer unavailable, rules-only review");
      }
    } else note = glimmerNote(new AppError("PROVIDER_NOT_CONFIGURED", "not configured"));
    await opts.progress?.(85, "Validating findings");
    const { findings, suppressedBy } = mergeFindings(ruleFindings, glimmer?.findings ?? [], allowed);
    const status = statusOf(findings);
    const ruleMemory = [...findings.flatMap((f) => f.evidence.preferenceIds), ...suppressedBy];
    const memoryRefs = [...new Set([...(glimmer ? memory.map((m) => m.id) : []), ...ruleMemory])].slice(0, 100);
    const cited = findings.flatMap((f) => f.evidence.claimIds);
    const claimIds = [...new Set([...cited, ...brand.verifiedClaims.map((c) => c.id), ...subject.texts.flatMap((t) => t.claimIds)])].slice(0, 100);
    const extra = [
      suppressedBy.length ? `Skipped ${suppressedBy.length} issue${suppressedBy.length === 1 ? "" : "s"} your team allowed before.` : "",
      glimmer && glimmer.dropped.findings + glimmer.dropped.ops ? `${glimmer.dropped.findings + glimmer.dropped.ops} Glimmer suggestion(s) failed validation and were dropped.` : "",
    ].filter(Boolean);
    const lead = glimmer ? glimmer.summary || "Muse Glimmer reviewed this asset against your brand kit, claims and memory." : `Rules-only review. ${note}`;
    return await repo.update(
      reviewId,
      {
        status,
        reviewer: glimmer ? { engine: "glimmer", model: clip(glimmer.model, 80), label: clip(p.cfg.GLIMMER_LABEL, 120) } : { engine: "rules", note: note ? clip(note, 300) : undefined },
        findings,
        summary: clip([lead, `${countsLine(findings)}.`, ...extra].join(" "), 1500),
        memoryRefs,
        claimIds,
        latencyMs: Date.now() - started,
        checkedAt: new Date().toISOString(),
        subjectVersion: subject.version ?? review.subjectVersion,
        contentHash: subject.contentHash,
        error: undefined,
      },
      { actor: opts.actor },
    );
  } catch (raw) {
    const err = toAppError(raw);
    if (err.code !== "CANCELLED") {
      await repo.update(reviewId, { status: "failed", error: clip(err.opts.userMessage ?? err.message, 1000), latencyMs: Date.now() - started }, { actor: opts.actor }).catch(() => {});
    }
    throw err;
  }
}

/** Job handler `brand.review` ({appId, reviewId}; the BrandReview is created first by the producer). */
export async function brandReviewHandler(ctx: JobContext<"brand.review">): Promise<JobResult> {
  const { appId, reviewId } = ctx.payload;
  const review = await ctx.ws.collection("brandReviews").get(reviewId);
  if (!review) throw new AppError("NOT_FOUND", `Brand review ${reviewId} not found`, { retryable: false });
  if (review.appId !== appId) throw new AppError("BAD_REQUEST", "Review does not belong to this app");
  if (isTerminalReview(review)) return { refs: [{ entity: "brandReviews", id: reviewId }], creditsUsed: 0, data: { alreadyReviewed: true, status: review.status } };
  await ctx.progress(5, "Brand Guardian starting");
  const done = await executeReview(ctx.platform, ctx.workspaceId, reviewId, { actor: ctx.actor, jobId: ctx.job.id, signal: ctx.signal, progress: (pct, stage) => ctx.progress(pct, stage) });
  await ctx.progress(100, `${done.status} · ${done.reviewer.engine === "glimmer" ? "Muse Glimmer" : "rules only"}`);
  return {
    refs: [{ entity: "brandReviews", id: reviewId }],
    creditsUsed: ctx.job.reservation?.credits ?? 1,
    data: { status: done.status, engine: done.reviewer.engine, findings: done.findings.length, latencyMs: done.latencyMs },
  };
}
