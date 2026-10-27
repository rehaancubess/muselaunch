import type { BrandFinding, BrandPreference, BrandReview, CompositionPatch, CompositionVersion, Composition, EntityRef, Job } from "@muselaunch/contracts";
import { applyPatch, PatchError } from "@muselaunch/compositions";
import { commitVersion, getVersion } from "@muselaunch/compositions/store";
import type { WorkspaceDb } from "@muselaunch/db";
import { AppError, type Platform } from "@muselaunch/platform";
import { glimmerClient } from "@muselaunch/providers";
import { rememberPreference } from "../memory";
import { clip, hashId } from "../util";
import { countsLine, executeReview, GUARDIAN_ALLOW_TAG, isTerminalReview, statusOf } from "./review";
import { loadSubject, type LoadedSubject } from "./subject";

/**
 * Brand Guardian service: request reviews (job `brand.review`), gate final renders and approval
 * requests on the latest review of the exact version/content, and learn from people's decisions
 * (dismissals and applied fixes become brandPreferences that later reviews read).
 */

/** Gates wait at most this long for Glimmer before falling back to a labelled rules-only review. */
export const GATE_GLIMMER_TIMEOUT_MS = 25_000;
/** A queued/running review older than this is considered stuck (the gate reviews inline instead). */
const INFLIGHT_STALE_MS = 3 * 60_000;

function provisionalReviewer(p: Platform): BrandReview["reviewer"] {
  return glimmerClient(p).configured ? { engine: "glimmer", model: p.cfg.GLIMMER_MODEL, label: clip(p.cfg.GLIMMER_LABEL, 120) } : { engine: "rules", note: "Muse Glimmer isn't connected on this deployment (GLIMMER_BASE_URL not set), so only the deterministic rules will run." };
}

const sameContent = (r: BrandReview, s: Pick<LoadedSubject, "version" | "contentHash">) => (s.version !== undefined ? r.subjectVersion === s.version : r.contentHash === s.contentHash);

/** Reviews of one subject (newest first), optionally only those of the exact version/content. */
export async function reviewsFor(ws: WorkspaceDb, subject: EntityRef, exact?: Pick<LoadedSubject, "version" | "contentHash">): Promise<BrandReview[]> {
  const page = await ws.collection("brandReviews").list({ where: [["subject.id", "==", subject.id]], orderBy: { field: "createdAt", dir: "desc" }, limit: 50 });
  return page.items.filter((r) => r.subject.entity === subject.entity && (!exact || sameContent(r, exact)));
}

export interface RequestReviewInput {
  subject: EntityRef;
  version?: number;
  rerun?: boolean;
  actor: string;
  idempotencyKey?: string;
  /** Growth Autopilot: link the review job to the step that requested it. */
  parentJobId?: string;
  agentRunId?: string;
}

/**
 * Create a BrandReview (status `queued`) and enqueue `brand.review` {appId, reviewId}. Idempotent per
 * subject + version/content: an existing non-failed review of the same content is returned
 * (`reused: true`) unless `rerun` is set.
 */
export async function requestBrandReview(p: Platform, workspaceId: string, input: RequestReviewInput): Promise<{ review: BrandReview; job: Job | null; reused: boolean }> {
  const ws = p.db.ws(workspaceId);
  const s = await loadSubject(ws, input.subject, input.version);
  const existing = await reviewsFor(ws, s.ref, s);
  if (!input.rerun) {
    const reuse = existing.find((r) => r.status !== "failed");
    if (reuse) return { review: reuse, job: reuse.jobId ? await p.jobs.get(workspaceId, reuse.jobId) : null, reused: true };
  }
  const repo = ws.collection("brandReviews");
  const id = existing.length ? repo.newId() : hashId("brv", s.ref.entity, s.ref.id, s.version ?? s.contentHash);
  const { entity: created } = await repo.createIfAbsent(
    { id, appId: s.appId, subject: s.ref, subjectVersion: s.version, contentHash: s.contentHash, status: "queued", reviewer: provisionalReviewer(p), findings: [], summary: "", memoryRefs: [], claimIds: [], overrides: [] },
    { actor: input.actor },
  );
  let job: Job;
  try {
    job = await p.jobs.create(
      workspaceId,
      "brand.review",
      { appId: s.appId, reviewId: created.id },
      { actor: input.actor, appId: s.appId, idempotencyKey: input.idempotencyKey ?? `brand.review:${created.id}`, credits: { operation: "brand.review" }, parentJobId: input.parentJobId, agentRunId: input.agentRunId },
    );
  } catch (err) {
    await repo.delete(created.id).catch(() => {});
    throw err;
  }
  const review = (await repo.get(created.id)) ?? created;
  const withJob = review.jobId ? review : await repo.update(created.id, { jobId: job.id }, { actor: input.actor });
  return { review: withJob, job, reused: false };
}

/** Run a review synchronously (gates). Charges the same `brand.review` credits as the job. */
async function reviewInline(p: Platform, workspaceId: string, s: LoadedSubject, actor: string): Promise<BrandReview> {
  const repo = p.db.ws(workspaceId).collection("brandReviews");
  const id = repo.newId();
  const credits = p.credits.estimate("brand.review").credits;
  const rsv = credits > 0 ? await p.credits.reserve(workspaceId, credits, { operation: "brand.review", idempotencyKey: `brand.review.gate:${id}`, actor }) : null;
  try {
    await repo.create({ id, appId: s.appId, subject: s.ref, subjectVersion: s.version, contentHash: s.contentHash, status: "running", reviewer: provisionalReviewer(p), findings: [], summary: "", memoryRefs: [], claimIds: [], overrides: [] }, { actor });
    const done = await executeReview(p, workspaceId, id, { actor, glimmerTimeoutMs: GATE_GLIMMER_TIMEOUT_MS });
    if (rsv) await p.credits.settle(workspaceId, rsv.reservationId, rsv.credits, { actor, reason: "Brand Guardian review" });
    return done;
  } catch (err) {
    if (rsv) await p.credits.release(workspaceId, rsv.reservationId, { actor, reason: "Brand Guardian review failed" }).catch(() => {});
    throw err;
  }
}

/** Short review shape for error details / gate responses. */
export function reviewBrief(r: BrandReview) {
  return {
    id: r.id,
    status: r.status,
    engine: r.reviewer.engine,
    label: r.reviewer.label,
    note: r.reviewer.note,
    subjectVersion: r.subjectVersion,
    summary: r.summary,
    latencyMs: r.latencyMs,
    blocking: r.findings.filter((f) => f.severity === "block" && f.resolution?.state !== "dismissed").map((f) => ({ id: f.id, category: f.category, message: f.message, location: f.location })),
  };
}

export interface GateInput {
  subject: EntityRef;
  version?: number;
  override?: { reason: string };
  actor: string;
  /** Overriding a blocked review needs `content.approve` (owners/admins). */
  canOverride: boolean;
  action: "render_final" | "request_approval";
}

/**
 * Gate for final renders and approval requests: attach the latest finished review of this exact
 * version/content (reviewing inline when there is none). A `blocked` review needs `override.reason`
 * from someone with `content.approve`; the override is stored on the review and in the audit log.
 */
export async function brandGate(p: Platform, workspaceId: string, input: GateInput): Promise<{ review: BrandReview; overridden: boolean }> {
  const ws = p.db.ws(workspaceId);
  const s = await loadSubject(ws, input.subject, input.version);
  const existing = await reviewsFor(ws, s.ref, s);
  let review = existing.find(isTerminalReview);
  if (!review) {
    const inflight = existing.find((r) => (r.status === "queued" || r.status === "running") && Date.now() - Date.parse(r.updatedAt) < INFLIGHT_STALE_MS);
    if (inflight)
      throw new AppError("CONFLICT", "Brand Guardian is still reviewing this content", { userMessage: "Brand Guardian is still reviewing this. Try again in a moment.", details: { reason: "brand_review_running", reviewId: inflight.id } });
    review = await reviewInline(p, workspaceId, s, input.actor);
  }
  if (review.status !== "blocked") return { review, overridden: false };
  const blocking = review.findings.filter((f) => f.severity === "block" && f.resolution?.state !== "dismissed");
  const what = input.action === "render_final" ? "final render" : "approval request";
  if (!input.override) {
    throw new AppError("APPROVAL_REQUIRED", `Brand Guardian blocked this ${what}: ${clip(blocking[0]?.message ?? review.summary, 300)}`, {
      userMessage: "Brand Guardian found blocking issues. Fix them, or override with a reason.",
      details: { reason: "brand_review_blocked", requiresOverride: true, review: reviewBrief(review) },
    });
  }
  if (!input.canOverride) throw new AppError("FORBIDDEN", "Overriding a blocked Brand Guardian review needs the content.approve capability", { userMessage: "Only workspace owners and admins can override Brand Guardian." });
  const entry = { at: new Date().toISOString(), by: input.actor, reason: clip(input.override.reason.trim(), 500), action: input.action, findingIds: blocking.map((f) => f.id).slice(0, 100) };
  review = await ws.collection("brandReviews").update(review.id, { overrides: [...review.overrides, entry].slice(-50) }, { actor: input.actor });
  await ws.collection("auditLog").create(
    { action: "brand_review.override", target: { entity: "brandReviews", id: review.id }, data: { subject: s.ref, version: s.version, contentHash: s.contentHash, gate: input.action, reason: entry.reason, findingIds: entry.findingIds } },
    { actor: input.actor },
  );
  return { review, overridden: true };
}

// ---------------------------------------------------------------------------
// Learning from decisions
// ---------------------------------------------------------------------------

const CATEGORY_LABEL: Record<BrandFinding["category"], string> = {
  tone: "tone",
  claim: "claim wording",
  prohibited: "wording",
  palette: "brand colour use",
  typography: "typography",
  logo: "logo use",
  cta: "CTA wording",
  consistency: "wording",
  accessibility: "styling",
  privacy: "content",
  platform_fit: "for this platform",
};

function preferenceKind(category: BrandFinding["category"]): BrandPreference["kind"] {
  if (category === "tone") return "tone";
  if (category === "palette" || category === "typography" || category === "logo") return "style";
  return "decision";
}

async function ensureTags(p: Platform, workspaceId: string, pref: BrandPreference, tags: string[], actor: string): Promise<BrandPreference> {
  if (tags.every((t) => pref.tags.includes(t))) return pref;
  const merged = [...new Set([...tags, ...pref.tags])].slice(0, 20);
  return p.db.ws(workspaceId).collection("brandPreferences").update(pref.id, { tags: merged }, { actor });
}

async function loadFinding(ws: WorkspaceDb, reviewId: string, findingId: string): Promise<{ review: BrandReview; finding: BrandFinding }> {
  const review = await ws.collection("brandReviews").getOrThrow(reviewId);
  const finding = review.findings.find((f) => f.id === findingId);
  if (!finding) throw new AppError("NOT_FOUND", "Finding not found");
  if (!isTerminalReview(review)) throw new AppError("CONFLICT", `Review is ${review.status}`);
  return { review, finding };
}

/**
 * Dismiss a finding and remember the decision (e.g. `Allowed: "blazing fast" is acceptable tone`),
 * tagged so future reviews of this app skip the same issue. Dismissing a blocking finding needs
 * `content.approve` and is audited.
 */
export async function dismissFinding(
  p: Platform,
  workspaceId: string,
  input: { reviewId: string; findingId: string; reason: string; actor: string; canDismissBlock: boolean },
): Promise<{ review: BrandReview; preference: BrandPreference | null }> {
  const ws = p.db.ws(workspaceId);
  const { review, finding } = await loadFinding(ws, input.reviewId, input.findingId);
  if (finding.resolution?.state === "dismissed") return { review, preference: null };
  if (finding.resolution?.state === "applied") throw new AppError("CONFLICT", "This fix was already applied");
  if (finding.severity === "block" && !input.canDismissBlock) throw new AppError("FORBIDDEN", "Dismissing a blocking finding needs the content.approve capability", { userMessage: "Only workspace owners and admins can dismiss blocking issues." });
  const reason = input.reason.trim();
  const about = finding.quote ? `"${clip(finding.quote, 160)}"` : `"${clip(finding.message, 160)}"`;
  const text = `Allowed: ${about} is acceptable ${CATEGORY_LABEL[finding.category]}${reason ? ` — ${clip(reason, 300)}` : ""}`;
  const tags = ["guardian", GUARDIAN_ALLOW_TAG, ...(finding.key ? [finding.key] : [])];
  let preference = await rememberPreference(p, { workspaceId, appId: review.appId, kind: preferenceKind(finding.category), text, source: { type: "approval", ref: { entity: "brandReviews", id: review.id } }, actor: input.actor, tags });
  preference = await ensureTags(p, workspaceId, preference, tags, input.actor);
  const at = new Date().toISOString();
  const findings = review.findings.map((f) => (f.id === finding.id ? { ...f, resolution: { state: "dismissed" as const, by: input.actor, at, reason: reason ? clip(reason, 500) : undefined, preferenceId: preference.id } } : f));
  const updated = await ws.collection("brandReviews").update(review.id, { findings, status: statusOf(findings), memoryRefs: [...new Set([...review.memoryRefs, preference.id])].slice(0, 100) }, { actor: input.actor });
  if (finding.severity === "block") {
    await ws.collection("auditLog").create({ action: "brand_review.finding_dismissed", target: { entity: "brandReviews", id: review.id }, data: { findingId: finding.id, category: finding.category, message: finding.message, reason, preferenceId: preference.id } }, { actor: input.actor });
  }
  return { review: updated, preference };
}

/**
 * Apply a composition finding's validated `suggestedOps` as a new version (source `user_edit`),
 * remember the accepted fix, and request a fresh review of the new version.
 */
export async function applyFinding(
  p: Platform,
  workspaceId: string,
  input: { reviewId: string; findingId: string; actor: string },
): Promise<{ review: BrandReview; composition: Composition; version: CompositionVersion; patch: CompositionPatch | null; reReview: { review: BrandReview; job: Job | null; reused: boolean } }> {
  const ws = p.db.ws(workspaceId);
  const { review, finding } = await loadFinding(ws, input.reviewId, input.findingId);
  if (review.subject.entity !== "compositions" || !finding.suggestedOps?.length) throw new AppError("CONFLICT", "This finding has no one-click fix", { userMessage: "Edit the content yourself, then run the review again." });
  const compId = review.subject.id;
  if (finding.resolution?.state === "applied" && finding.resolution.resultVersion) {
    const composition = await ws.collection("compositions").getOrThrow(compId);
    const version = await getVersion(ws, compId, finding.resolution.resultVersion);
    const reReview = await requestBrandReview(p, workspaceId, { subject: review.subject, version: version.version, actor: input.actor });
    return { review, composition, version, patch: null, reReview };
  }
  if (finding.resolution?.state === "dismissed") throw new AppError("CONFLICT", "This finding was dismissed");
  const comp = await ws.collection("compositions").getOrThrow(compId);
  // Ops address stable scene/layer ids, so a fix found on an older version can still apply cleanly.
  const cur = await getVersion(ws, compId, comp.currentVersion);
  let result: ReturnType<typeof applyPatch>;
  try {
    result = applyPatch(cur.doc, finding.suggestedOps);
  } catch (err) {
    if (err instanceof PatchError) throw new AppError("VALIDATION_FAILED", "This fix no longer applies to the current version", { userMessage: "The composition changed since this review. Run the review again.", details: { errors: err.errors } });
    throw err;
  }
  const patches = ws.collection("compositionPatches");
  const patchId = patches.newId();
  const summary = clip(`Brand Guardian fix: ${finding.suggestion ?? finding.message}`, 500);
  const committed = await commitVersion(ws, compId, { baseVersion: cur.version, doc: result.doc, source: "user_edit", summary, patchId }, input.actor);
  const patch = await patches.create(
    { id: patchId, compositionId: compId, baseVersion: cur.version, resultVersion: committed.version.version, ops: finding.suggestedOps, summary, source: "user", affectedSceneIds: result.affectedSceneIds, status: "applied", validationErrors: [], memoryRefs: finding.evidence.preferenceIds },
    { actor: input.actor },
  );
  const preference = await rememberPreference(p, {
    workspaceId,
    appId: review.appId,
    kind: preferenceKind(finding.category) === "decision" ? "edit_instruction" : preferenceKind(finding.category),
    text: clip(`Accepted Brand Guardian fix (${CATEGORY_LABEL[finding.category]}): ${finding.suggestion ?? finding.message}`, 1000),
    source: { type: "user_edit", ref: { entity: "brandReviews", id: review.id } },
    actor: input.actor,
    tags: ["guardian"],
  });
  const at = new Date().toISOString();
  const findings = review.findings.map((f) => (f.id === finding.id ? { ...f, resolution: { state: "applied" as const, by: input.actor, at, preferenceId: preference.id, resultVersion: committed.version.version } } : f));
  const updated = await ws.collection("brandReviews").update(review.id, { findings, summary: clip(`${review.summary.replace(/\s*Applied fixes:.*$/, "")} Applied fixes: ${findings.filter((f) => f.resolution?.state === "applied").length}.`, 1500) }, { actor: input.actor });
  const reReview = await requestBrandReview(p, workspaceId, { subject: review.subject, version: committed.version.version, actor: input.actor });
  return { review: updated, composition: committed.composition, version: committed.version, patch, reReview };
}

/** Reviews for a subject or an app, newest first (workspace-scoped). */
export async function listReviews(ws: WorkspaceDb, q: { subjectId?: string; appId?: string; version?: number; limit?: number; cursor?: string }) {
  const limit = Math.min(Math.max(q.limit ?? 30, 1), 100);
  if (q.subjectId) {
    const page = await ws.collection("brandReviews").list({ where: [["subject.id", "==", q.subjectId]], orderBy: { field: "createdAt", dir: "desc" }, limit, cursor: q.cursor });
    return { items: page.items.filter((r) => (q.appId ? r.appId === q.appId : true) && (q.version === undefined || r.subjectVersion === q.version)), nextCursor: page.nextCursor };
  }
  if (!q.appId) throw new AppError("BAD_REQUEST", "subjectId or appId is required");
  return ws.collection("brandReviews").list({ where: [["appId", "==", q.appId]], orderBy: { field: "createdAt", dir: "desc" }, limit, cursor: q.cursor });
}

export { countsLine };
