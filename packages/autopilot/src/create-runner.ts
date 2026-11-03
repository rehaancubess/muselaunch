/**
 * The server's Create runner: moves every Create run ("Generate video", campaigns with origin
 * "create") along without a browser, from job-completion hooks (hooks.ts) and the one-minute
 * "autopilot-wake" sweep (missed hooks, waits that are over). It takes exactly the steps a person
 * would take on the campaign page and in the Studio, through the same checks:
 *
 *   ideas ready   → select the best-fitting idea → storyboard.generate in the chosen format and length
 *                   (then the existing chain: b-roll → editable video → preview)
 *   preview ready → the facts check (lint) → the final render's real price vs what was shown → the
 *                   Brand check (brandGate) → render.final
 *
 * It acts as the person who started the run (their permissions; the workspace's credits are reserved
 * per job as usual), with ONE idempotency key per step — the same keys the browser used
 * (`<uid>:create-produce-<campaignId>`, `<uid>:create-final-<compositionId>-v<version>`) — so a hook,
 * the sweep and a person's decision can never start a step twice. A short lease on the campaign
 * keeps them from even trying at the same time.
 *
 * When a step needs a person (not enough credits, a plan limit, the facts or Brand check, a longer
 * video than shown, lost permissions, a day without progress) the run stops there and records a
 * decision (Campaign.createRun.decision) that the Create page, Home / Needs you and the phone app show;
 * POST /create-runs/:id/resolve answers it. Passing problems (too many tasks at once, the Brand check
 * still running, a hiccup) wait and try again by themselves. Failed jobs show their error with Try
 * again. Nothing is ever posted: Create only makes videos.
 */
import { brandGate } from "@muselaunch/agents";
import { collectAssetRefs, lintDoc, totalDuration, type LintIssue } from "@muselaunch/compositions";
import { getVersion } from "@muselaunch/compositions/store";
import {
  can,
  type Campaign,
  type Capability,
  type CompositionDoc,
  type CreateRunAction,
  type CreateRunDecision,
  type CreateRunStage,
  type CreateRunState,
  type CreateRunStatus,
  type CreateRunView,
  type CopyPack,
  type Job,
  type MediaAsset,
  type NeedsYouItem,
  type ResolveCreateRunRequest,
  type WorkspaceMember,
} from "@muselaunch/contracts";
import { newId, type WorkspaceDb } from "@muselaunch/db";
import { AppError, toAppError, type Platform } from "@muselaunch/platform";
import { textPostText } from "@muselaunch/agents";
import { deriveRun, isStillOutput, MAX_GLITCH_WAITS, overspend, problemFromError, runNoun, runSettings, stageLabel, stepKeyOf, waitMs, type Derived, type JobLike, type NextStep, type RunOutput, type StepProblem } from "./create-run";
import { nowMs } from "./state";

type Member = Pick<WorkspaceMember, "role" | "canPublish" | "canManageAccounts" | "status">;

/** Create runs followed closely (older ones live on Make → Campaigns and Videos). */
export const CREATE_RUN_FOLLOW_MS = 7 * 86_400_000;
/** A run nobody (and nothing) moved for this long doesn't carry on, or spend, without the person. */
export const CREATE_RUN_STALE_MS = 24 * 3_600_000;
/** How long one hook / sweep / decision may hold a run. */
const LEASE_MS = 3 * 60_000;
/** Job types of a Create run's own chain. */
export const CREATE_RUN_JOBS: ReadonlySet<Job["type"]> = new Set(["campaign.generate_concepts", "storyboard.generate", "storyboard.resolve_media", "composition.build", "render.preview", "render.final", "copy.generate"]);
const FOOTAGE_JOBS: ReadonlySet<Job["type"]> = new Set(["media.extract_ui", "media.analyze_recording"]);
const ACTOR = "system";

/** Step names for a video run (stills and text posts: `stageLabel(output, stage)`). */
export const STAGE_LABEL: Record<Exclude<CreateRunStage, "done">, string> = {
  idea: "Writing the idea",
  plan: "Planning the video",
  make: "Making it",
  check: "Checking facts and brand",
  finish: "Finishing",
};

/** Plain words for the piece a run makes: "your carousel needs…", "your screenshots need…". */
function wordsOf(output: RunOutput) {
  const n = runNoun(output);
  const pl = n.plural;
  return {
    ...n,
    it: pl ? "them" : "it",
    they: pl ? "they" : "it",
    its: pl ? "they’re" : "it’s",
    is: pl ? "are" : "is",
    was: pl ? "were" : "was",
    s: pl ? "" : "s",
    this: pl ? "These" : "This",
  };
}

/** "This video stopped at “Planning the video”. Muse doesn’t carry on with an older video by itself." */
function resumeMessage(output: RunOutput, stage: CreateRunStage): string {
  const w = wordsOf(output);
  return `${w.this} ${w.one} stopped at “${stage === "done" ? "a step" : stageLabel(output, stage)}”. Muse doesn’t carry on with an older ${w.one} by itself.`;
}

const iso = (ms: number) => new Date(ms).toISOString();
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const isActive = (j: Pick<Job, "status">) => j.status === "queued" || j.status === "running";

/** The stored state of a run (runs started before the server runner get one on first touch). */
export function initialRunState(c: Pick<Campaign, "createdBy" | "createdAt">, at = c.createdAt): CreateRunState {
  return { startedBy: c.createdBy, actingAs: c.createdBy, status: "working", stage: "idea", waits: 0, jobIds: [], touchedAt: at };
}

/** The step keys (the same ones the browser used, namespaced to the starter like the routes do). */
export const produceKey = (s: Pick<CreateRunState, "startedBy">, campaignId: string) => `${s.startedBy}:create-produce-${campaignId}`;
export const finalKey = (s: Pick<CreateRunState, "startedBy">, compositionId: string, version: number) => `${s.startedBy}:create-final-${compositionId}-v${version}`;
export const copyKey = (s: Pick<CreateRunState, "startedBy">, campaignId: string) => `${s.startedBy}:create-copy-${campaignId}`;

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

interface Records {
  campaign: Campaign;
  derived: Derived;
  /** Final render assets of the campaign (for the finished video's details). */
  assets: Map<string, MediaAsset>;
  /** Text posts: the campaign's copy packs. */
  packs: Map<string, CopyPack>;
}

/** Loads what a run is derived from; the app's recent jobs are shared between runs of one app. */
function loader(p: Platform, wid: string) {
  const ws = p.db.ws(wid);
  const appJobs = new Map<string, Promise<Job[]>>();
  const jobsOf = (appId: string) => {
    let hit = appJobs.get(appId);
    if (!hit) {
      hit = Promise.all([
        ws.collection("jobs").list({ where: [["appId", "==", appId]], orderBy: { field: "createdAt", dir: "desc" }, limit: 200 }),
        // Anything still running, however many jobs came after it.
        ws.collection("jobs").list({ where: [["appId", "==", appId], ["status", "in", ["queued", "running"]]], orderBy: { field: "createdAt", dir: "desc" }, limit: 100 }),
      ]).then(([a, b]) => [...a.items, ...b.items]);
      appJobs.set(appId, hit);
    }
    return hit;
  };
  return async (campaign: Campaign): Promise<Records> => {
    const byCampaign = { where: [["campaignId", "==", campaign.id]] as const, orderBy: { field: "createdAt", dir: "desc" as const }, limit: 100 };
    const text = runSettings(campaign).output === "text_post";
    const [variants, compositions, jobs, own, media, packs] = await Promise.all([
      ws.collection("campaignVariants").list(byCampaign),
      ws.collection("compositions").list(byCampaign),
      jobsOf(campaign.appId),
      ws.collection("jobs").getMany(campaign.createRun?.jobIds ?? []),
      ws.collection("mediaAssets").list(byCampaign),
      text ? ws.collection("copyPacks").list(byCampaign) : Promise.resolve({ items: [] as CopyPack[] }),
    ]);
    const all: JobLike[] = [...jobs, ...own];
    const finals = media.items.filter((a) => a.role === "render" && a.render?.quality === "final");
    const derived = deriveRun({
      campaign,
      variants: variants.items.reverse(),
      compositions: compositions.items,
      jobs: all,
      finals,
      copyPacks: packs.items,
      footageBusy: jobs.some((j) => FOOTAGE_JOBS.has(j.type) && isActive(j)),
    });
    return { campaign, derived, assets: new Map(media.items.map((a) => [a.id, a])), packs: new Map(packs.items.map((x) => [x.id, x])) };
  };
}

// ---------------------------------------------------------------------------
// Stored state: lease + read-modify-write
// ---------------------------------------------------------------------------

/** Patch the run's stored state (keeps the lease fields as stored). */
async function patchRun(p: Platform, wid: string, campaignId: string, patch: Partial<CreateRunState>, actor = ACTOR): Promise<Campaign | null> {
  return p.db.runTransaction(async (tx) => {
    const c = await tx.get(wid, "campaigns", campaignId);
    if (!c) return null;
    const s = c.createRun ?? initialRunState(c);
    const { lease: _l, again: _a, ...rest } = patch;
    // Nothing changed (most hooks and sweeps of a working run): no write.
    if (c.createRun && Object.entries(rest).every(([k, v]) => JSON.stringify(v) === JSON.stringify((s as Record<string, unknown>)[k]))) return c;
    return tx.update(wid, "campaigns", campaignId, { createRun: { ...s, ...rest } }, { actor });
  });
}

/**
 * Run `fn` holding the run's lease. Someone else holding it: they're told to look again before they
 * let go (so a finished job or a person's decision is never lost), and this call returns at once.
 */
async function withLease(p: Platform, wid: string, campaignId: string, fn: () => Promise<void>): Promise<boolean> {
  const token = newId("lease").slice(0, 64);
  const got = await p.db.runTransaction(async (tx) => {
    const c = await tx.get(wid, "campaigns", campaignId);
    if (!c || c.origin !== "create") return false;
    const now = nowMs(p);
    const s = c.createRun ?? initialRunState(c);
    if (s.lease && Date.parse(s.lease.until) > now) {
      tx.update(wid, "campaigns", campaignId, { createRun: { ...s, again: true } }, { actor: ACTOR });
      return false;
    }
    tx.update(wid, "campaigns", campaignId, { createRun: { ...s, lease: { token, until: iso(now + LEASE_MS) }, again: false } }, { actor: ACTOR });
    return true;
  });
  if (!got) return false;
  let rounds = 0;
  for (;;) {
    try {
      await fn();
    } catch (err) {
      await release(true);
      throw err;
    }
    if (!(await release(rounds++ >= 3))) return true;
  }

  /** Let go, unless something changed meanwhile (then keep it and go again; `final`: let go anyway). */
  async function release(final: boolean): Promise<boolean> {
    return p.db.runTransaction(async (tx) => {
      const c = await tx.get(wid, "campaigns", campaignId);
      const s = c?.createRun;
      if (!c || !s || s.lease?.token !== token) return false;
      if (s.again && !final) {
        tx.update(wid, "campaigns", campaignId, { createRun: { ...s, again: false, lease: { token, until: iso(nowMs(p) + LEASE_MS) } } }, { actor: ACTOR });
        return true;
      }
      tx.update(wid, "campaigns", campaignId, { createRun: { ...s, again: false, lease: undefined } }, { actor: ACTOR });
      return false;
    });
  }
}

// ---------------------------------------------------------------------------
// Advancing a run
// ---------------------------------------------------------------------------

/** A decision about another step (the person produced it themselves, say) no longer applies. Same video, another version: it still does. */
function decisionApplies(d: CreateRunDecision, next: NextStep | null): boolean {
  if (!next) return false;
  const key = stepKeyOf(next);
  if (d.stepKey === key) return true;
  return next.kind === "final" && d.stepKey.startsWith(`final:${next.compositionId}:v`);
}

const isStale = (now: number, s: CreateRunState, d: Derived) => now - Math.max(Date.parse(s.touchedAt), d.lastActivity) > CREATE_RUN_STALE_MS;

export type AdvanceSource = "hook" | "sweep" | "person";

/**
 * Take the run's next step if it has one and nothing stops it. Safe to call any number of times, from
 * anywhere: every step has one idempotency key and the lease keeps two callers from overlapping.
 */
export async function advanceCreateRun(p: Platform, wid: string, campaignId: string, opts: { source: AdvanceSource } = { source: "hook" }): Promise<Campaign | null> {
  await withLease(p, wid, campaignId, async () => {
    for (let round = 0; round < 3; round++) {
      const again = await advanceOnce(p, wid, campaignId, opts.source);
      if (!again) return;
    }
  });
  return p.db.ws(wid).collection("campaigns").get(campaignId);
}

/** One look at the run. Returns true when a step went through but its job was already finished (look again). */
async function advanceOnce(p: Platform, wid: string, campaignId: string, source: AdvanceSource): Promise<boolean> {
  const ws = p.db.ws(wid);
  const campaign = await ws.collection("campaigns").get(campaignId);
  if (!campaign || campaign.origin !== "create" || campaign.status === "archived") return false;
  const s = campaign.createRun ?? initialRunState(campaign);
  const { derived: d } = await loader(p, wid)(campaign);
  const now = nowMs(p);
  const save = (patch: Partial<CreateRunState>) => patchRun(p, wid, campaignId, { stage: d.stage, ...patch });
  const clearWait = { waitUntil: undefined, waitReason: undefined, waitKind: undefined } as Partial<CreateRunState>;

  if (d.stage === "done") {
    if (s.status !== "done") await save({ status: "done", decision: undefined, failure: undefined, ...clearWait, waits: 0, doneAt: iso(now) });
    return false;
  }
  if (d.failure) {
    // A run the person left keeps out of Needs you even if a job it had running failed afterwards.
    await save({ status: s.status === "stopped" ? "stopped" : "failed", failure: d.failure, decision: undefined, ...clearWait });
    return false;
  }
  if (d.working || !d.next) {
    await save({ status: s.status === "stopped" ? "stopped" : "working", failure: undefined, ...(d.working ? { decision: undefined, ...clearWait } : {}) });
    return false;
  }
  const next = d.next;
  const key = stepKeyOf(next);
  if (s.status === "stopped") return false;
  if (s.decision && decisionApplies(s.decision, next)) {
    if (s.status !== "needs_you" || s.failure) await save({ status: "needs_you", failure: undefined });
    return false;
  }
  const stage: CreateRunStage = next.kind === "final" ? "check" : "plan";
  const output = runSettings(campaign).output;
  const w = wordsOf(output);
  const decide = async (kind: CreateRunDecision["kind"], message: string, extra: Partial<CreateRunDecision> = {}) => {
    await save({ status: "needs_you", stage, failure: undefined, ...clearWait, waits: 0, decision: { kind, stepKey: key, stage, message: clip(message, 1000), at: iso(now), ...extra } });
    return false;
  };
  // A run nobody moved for a day waits for the person (it doesn't carry on, or spend, by itself).
  if (isStale(now, s, d)) return decide("resume", resumeMessage(output, d.stage));
  // A passing problem: try again once its wait is over (a finished job frees a task slot: a hook tries a "busy" wait at once).
  if (s.status === "waiting" && s.waitUntil && Date.parse(s.waitUntil) > now && !(source !== "sweep" && s.waitKind === "busy")) return false;

  const member = await ws.collection("members").get(s.actingAs);
  if (!member || !can(member, "content.write")) {
    const who = member?.displayName ?? member?.email ?? "The person who started it";
    return decide("permission", `${who} can no longer make ${w.many} in this workspace, so Muse stopped here. An editor can continue ${w.it}.`);
  }
  try {
    const out = next.kind === "produce" ? await produce(p, wid, campaign, s, next) : next.kind === "copy" ? await writePost(p, wid, campaign, s, next) : await finish(p, wid, campaign, s, next, member);
    if ("decision" in out) return decide(out.decision.kind, out.decision.message, out.decision.extra);
    const job = out.job;
    await save({ status: "working", stage: next.kind === "final" ? "finish" : "plan", decision: undefined, failure: undefined, ...clearWait, waits: 0, touchedAt: iso(now), jobIds: [...new Set([...s.jobIds, job.id])].slice(-20) });
    // An earlier attempt with the same key already finished: read the records again.
    return !isActive(job);
  } catch (raw) {
    const e = toAppError(raw);
    const info = e.toInfo();
    const problem: StepProblem = problemFromError({ code: e.code, status: e.status, retryable: e.retryable, userMessage: info.userMessage, message: e.message, details: e.opts.details });
    if (problem.wait && !(problem.glitch && s.waits >= MAX_GLITCH_WAITS)) {
      if (problem.glitch) p.log.warn({ err: { code: e.code, message: e.message }, campaignId }, "Create step hit a passing problem; trying again later");
      await save({ status: "waiting", stage, waitUntil: iso(now + waitMs(s.waits)), waitReason: clip(problem.reason, 300), waitKind: problem.glitch ? "glitch" : "busy", waits: s.waits + 1, failure: undefined });
      return false;
    }
    if (problem.wait) return decide("error", `${problem.reason} Muse tried a few times.`);
    const extra: Partial<CreateRunDecision> = {};
    if (problem.kind === "brand") Object.assign(extra, { canOverride: problem.canOverride && can(member, "content.write"), reviewId: problem.reviewId, compositionId: next.kind === "final" ? next.compositionId : undefined, version: next.kind === "final" ? next.version : undefined });
    if (problem.kind === "credits" && problem.credits) extra.credits = problem.credits;
    if (next.kind === "final" && !extra.compositionId) Object.assign(extra, { compositionId: next.compositionId, version: next.version });
    return decide(problem.kind, problem.message, extra);
  }
}

type StepOut = { job: Job } | { decision: { kind: CreateRunDecision["kind"]; message: string; extra?: Partial<CreateRunDecision> } };

/** "Use this idea" on the campaign page: the chosen idea is selected (remembered as an accepted angle). */
async function useIdea(p: Platform, wid: string, campaign: Campaign, s: CreateRunState, variantId: string) {
  const ws = p.db.ws(wid);
  const actor = s.actingAs;
  const variant = await ws.collection("campaignVariants").getOrThrow(variantId);
  if (variant.campaignId !== campaign.id) throw new AppError("NOT_FOUND", "Variant not found");
  if (variant.status === "rejected") throw new AppError("CONFLICT", "This concept was rejected; select it again first");
  if (variant.status === "proposed") {
    // POST /campaigns/:id/variants/:variantId/select (remembered as an accepted angle).
    await ws.collection("campaignVariants").update(variant.id, { status: "selected" }, { actor });
    const fresh = await ws.collection("campaigns").getOrThrow(campaign.id);
    if (!fresh.selectedVariantIds.includes(variant.id)) await ws.collection("campaigns").update(campaign.id, { selectedVariantIds: [...fresh.selectedVariantIds, variant.id] }, { actor });
    await p.jobs
      .create(wid, "memory.ingest", { appId: campaign.appId, ref: { entity: "campaignVariants", id: variant.id } }, { actor, appId: campaign.appId, idempotencyKey: `memory.ingest:variant:${variant.id}:selected` })
      .catch((err) => p.log.warn({ err, variantId: variant.id }, "Create: remembering the chosen idea failed"));
  }
  return variant;
}

/** Plan the chosen idea (what "Use this idea" + "Make the video" do on the campaign page); stills in their format and slide count. */
async function produce(p: Platform, wid: string, campaign: Campaign, s: CreateRunState, next: Extract<NextStep, { kind: "produce" }>): Promise<StepOut> {
  const variant = await useIdea(p, wid, campaign, s, next.variantId);
  // POST /campaigns/:id/variants/:variantId/produce in the chosen format and length (stills: format, slides, store).
  const payload = next.format
    ? { appId: campaign.appId, campaignId: campaign.id, variantId: variant.id, aspectRatio: next.aspectRatio, format: next.format, ...(next.slides ? { slides: next.slides } : {}), ...(next.store ? { store: next.store } : {}) }
    : { appId: campaign.appId, campaignId: campaign.id, variantId: variant.id, aspectRatio: next.aspectRatio, targetDurationSec: next.targetDurationSec ?? variant.targetDurationSec };
  const job = await p.jobs.create(wid, "storyboard.generate", payload, { actor: s.actingAs, appId: campaign.appId, idempotencyKey: produceKey(s, campaign.id), credits: { operation: "storyboard.generate" } });
  return { job };
}

/** Text posts: Muse Spark writes the post for the run's one channel (POST /campaigns/:id/copy), fact-checked. */
async function writePost(p: Platform, wid: string, campaign: Campaign, s: CreateRunState, next: Extract<NextStep, { kind: "copy" }>): Promise<StepOut> {
  const variant = await useIdea(p, wid, campaign, s, next.variantId);
  const job = await p.jobs.create(
    wid,
    "copy.generate",
    { appId: campaign.appId, campaignId: campaign.id, variantId: variant.id, channels: [next.channel] },
    { actor: s.actingAs, appId: campaign.appId, idempotencyKey: copyKey(s, campaign.id), credits: { operation: "copy.generate" } },
  );
  return { job };
}

/** The facts check of POST /compositions/:id/render (the same lint, read from this workspace only). */
async function lintForFinal(ws: WorkspaceDb, doc: CompositionDoc): Promise<LintIssue[]> {
  const refs = collectAssetRefs(doc);
  const segs = await ws.collection("segmentations").getMany(refs.segmentationIds);
  const cutouts = new Set<string>();
  for (const sg of segs) {
    if (sg.cutoutAssetId) cutouts.add(sg.cutoutAssetId);
    for (const o of Object.values(sg.objectOutputs ?? {})) if (o.cutoutAssetId) cutouts.add(o.cutoutAssetId);
  }
  const assets = await ws.collection("mediaAssets").getMany([...new Set([...refs.assetIds, ...cutouts])]);
  const claimIds = [...new Set(doc.scenes.flatMap((sc) => sc.layers.flatMap((l) => (l.type === "text" ? l.claimIds : []))))];
  const claims = claimIds.length ? await ws.collection("claims").getMany(claimIds) : [];
  return lintDoc(doc, { assets: Object.fromEntries(assets.map((a) => [a.id, a])), claims: Object.fromEntries(claims.map((x) => [x.id, x])), segmentations: Object.fromEntries(segs.map((x) => [x.id, x])) });
}

/**
 * Finish the video: what "Finish it" (POST /compositions/:id/render { quality: "final" }) does, with
 * the price check the page made first: facts check → price vs shown → Brand check → render.final.
 */
async function finish(p: Platform, wid: string, campaign: Campaign, s: CreateRunState, next: Extract<NextStep, { kind: "final" }>, member: Member): Promise<StepOut> {
  const ws = p.db.ws(wid);
  const actor = s.actingAs;
  const comp = await ws.collection("compositions").getOrThrow(next.compositionId);
  if (comp.appId !== campaign.appId) throw new AppError("NOT_FOUND", "Composition not found");
  const version = comp.currentVersion;
  const key = stepKeyOf({ kind: "final", compositionId: comp.id, version });
  const ver = await getVersion(ws, comp.id, version);
  const durationSec = totalDuration(ver.doc);
  const at = { compositionId: comp.id, version };
  const output = runSettings(campaign).output;
  const w = wordsOf(output);

  // 1. Facts check (the render route's lint: missing media, unconfirmed claims, other blocking issues).
  const errors = (await lintForFinal(ws, ver.doc)).filter((i) => i.level === "error");
  if (errors.length) {
    const missing = errors.some((i) => /missing asset/.test(i.message));
    const head = missing ? (output === "video" ? "Some of the video’s media is missing, so it can’t be finished yet." : `Some of the media in your ${w.one} is missing, so ${w.they} can’t be finished yet.`) : "Fix the flagged issues before the final render.";
    return { decision: { kind: "fix", message: `${head} ${errors[0]!.message}`, extra: at } };
  }

  // 2. The final render is priced on the video's real length: ask first if that's more than "Generate video" showed.
  const isVideo = ver.doc.kind === "video";
  const credits = isVideo ? { operation: "render.final", params: { durationSec } } : { operation: "render.final", amount: Math.max(1, Math.ceil(ver.doc.scenes.length / 4)) };
  const price = credits.amount ?? p.credits.estimate("render.final", { durationSec }).credits;
  const chosen = runSettings(campaign).lengthSec;
  const over = isVideo && chosen ? overspend(price, p.credits.estimate("render.final", { durationSec: chosen }).credits) : null;
  if (over && !(s.approvedSpend?.stepKey === key && s.approvedSpend.credits >= over.credits)) {
    return { decision: { kind: "spend", message: `The video came out ${Math.round(durationSec)} s long (you chose ${chosen} s), so finishing it costs ${over.credits} credits instead of ${over.shown}.`, extra: { ...at, credits: over.credits, shown: over.shown } } };
  }

  // 3. Brand check of this exact version (reviewed now if it hasn't been). A blocked one goes ahead only
  // with the person's reason for this version, or a reason someone already gave for it.
  try {
    await brandGate(p, wid, { subject: { entity: "compositions", id: comp.id }, version, actor, canOverride: can(member, "content.write"), action: "render_final" });
  } catch (raw) {
    const e = toAppError(raw);
    if (e.code !== "APPROVAL_REQUIRED") throw raw;
    const reviewId = (e.opts.details as { review?: { id?: string } } | undefined)?.review?.id;
    const review = reviewId ? await ws.collection("brandReviews").get(reviewId) : null;
    const already = review?.overrides.some((o) => o.action === "render_final");
    if (!already) {
      if (s.override?.stepKey !== key) throw raw;
      await brandGate(p, wid, { subject: { entity: "compositions", id: comp.id }, version, override: { reason: s.override.reason }, actor: s.override.by, canOverride: can(member, "content.write"), action: "render_final" });
    }
  }

  // 4. The final render (HyperFrames), reserved at the real price. Stills: JPEG for posts, carousels and
  // thumbnails (Instagram's API takes JPEG only), flattened PNG for store screenshot sets.
  const format = isVideo ? "mp4" : isStillOutput(output) && output !== "store_screenshots" ? "jpeg" : "png";
  const job = await p.jobs.create(wid, "render.final", { appId: comp.appId, compositionId: comp.id, version, format }, { actor, appId: comp.appId, idempotencyKey: finalKey(s, comp.id, version), credits });
  return { job };
}

// ---------------------------------------------------------------------------
// Hooks and the sweep
// ---------------------------------------------------------------------------

async function campaignOfJob(p: Platform, wid: string, job: Pick<Job, "type" | "payload">): Promise<string | undefined> {
  if (!CREATE_RUN_JOBS.has(job.type)) return undefined;
  const ws = p.db.ws(wid);
  const pl = job.payload as { campaignId?: unknown; compositionId?: unknown; storyboardId?: unknown };
  if (typeof pl.campaignId === "string") return pl.campaignId;
  if (typeof pl.compositionId === "string") return (await ws.collection("compositions").get(pl.compositionId))?.campaignId;
  if (typeof pl.storyboardId === "string") return (await ws.collection("storyboards").get(pl.storyboardId))?.campaignId;
  return undefined;
}

/** The app's recent Create runs that the server may still move along. */
async function liveRunsOf(p: Platform, wid: string, appId: string): Promise<Campaign[]> {
  const page = await p.db.ws(wid).collection("campaigns").list({ where: [["appId", "==", appId]], orderBy: { field: "createdAt", dir: "desc" }, limit: 50 });
  const now = nowMs(p);
  return page.items.filter((c) => c.origin === "create" && c.status !== "archived" && now - Date.parse(c.createdAt) < CREATE_RUN_FOLLOW_MS && (c.createRun?.status === "working" || c.createRun?.status === "waiting"));
}

/**
 * Lifecycle hook (a job reached a terminal state): move on the run the job belongs to, and the app's
 * other runs that wait for a free task slot or for the app's footage. Errors are logged, never thrown.
 */
export async function advanceCreateRunsForJob(p: Platform, wid: string, job: Pick<Job, "id" | "type" | "appId" | "payload">): Promise<number> {
  if (!job.appId) return 0;
  const ids = new Set<string>();
  const own = await campaignOfJob(p, wid, job).catch(() => undefined);
  if (own) {
    const c = await p.db.ws(wid).collection("campaigns").get(own);
    if (c?.origin === "create") ids.add(own);
  }
  for (const c of await liveRunsOf(p, wid, job.appId)) if (c.createRun?.status === "waiting" || c.createRun?.stage === "plan") ids.add(c.id);
  for (const id of ids) await advanceCreateRun(p, wid, id, { source: "hook" }).catch((err) => p.log.warn({ err, campaignId: id, jobId: job.id }, "Create run step failed"));
  return ids.size;
}

/** Cron (every minute, with the Autopilot wake-up): runs whose hook was missed, and waits that are over. */
export async function sweepCreateRuns(p: Platform, wid: string): Promise<number> {
  const page = await p.db.ws(wid).collection("campaigns").list({ where: [["createRun.status", "in", ["working", "waiting"]]], limit: 100 });
  const now = nowMs(p);
  let n = 0;
  for (const c of page.items) {
    if (c.origin !== "create" || c.status === "archived") continue;
    // A run that's been working for a week without finishing isn't followed any more (nothing is spent on it).
    if (now - Date.parse(c.createdAt) > CREATE_RUN_FOLLOW_MS) {
      await patchRun(p, wid, c.id, { status: "stopped" });
      continue;
    }
    await advanceCreateRun(p, wid, c.id, { source: "sweep" }).catch((err) => p.log.warn({ err, campaignId: c.id }, "Create run sweep failed"));
    n++;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Read model (any client)
// ---------------------------------------------------------------------------

function actionsFor(status: CreateRunStatus, decision: CreateRunDecision | null, canRetry: boolean): CreateRunAction[] {
  switch (status) {
    case "done":
      return [];
    case "stopped":
      return ["retry"];
    case "failed":
      return canRetry ? ["retry", "stop"] : ["stop"];
    case "needs_you":
      if (decision?.kind === "spend") return ["approve_spend", "stop"];
      if (decision?.kind === "brand" && decision.canOverride) return ["override", "retry", "stop"];
      return ["retry", "stop"];
    default:
      return ["stop"];
  }
}

function toView(rec: Records, member: Member, now: number): CreateRunView {
  const { campaign: c, derived: d } = rec;
  const s = c.createRun;
  const settings = runSettings(c);
  let status: CreateRunStatus;
  let decision: CreateRunDecision | null = null;
  let wait: CreateRunView["wait"] = null;
  const resume = (stage: CreateRunStage): CreateRunDecision => ({
    kind: "resume",
    stepKey: d.next ? stepKeyOf(d.next) : "",
    stage,
    message: resumeMessage(settings.output, stage),
    at: iso(now),
  });
  if (d.stage === "done") status = "done";
  else if (d.working) status = "working";
  else if (s?.status === "stopped") status = "stopped";
  else if (d.failure) status = "failed";
  else if (!s) {
    // Started before the server runner: nothing moves it until the person continues it.
    status = "needs_you";
    decision = resume(d.stage);
  } else if (s.decision && decisionApplies(s.decision, d.next)) {
    status = "needs_you";
    decision = s.decision;
  } else if (s.status === "waiting") {
    status = "waiting";
    wait = { until: s.waitUntil, reason: s.waitReason ?? "Waiting a moment before trying again." };
  } else if (d.next && isStale(now, s, d)) {
    status = "needs_you";
    decision = resume(d.stage);
  } else status = "working";
  const stage = decision?.stage ?? d.stage;
  const still = isStillOutput(settings.output);
  const asset = d.finalAssetId ? rec.assets.get(d.finalAssetId) : undefined;
  const pack = d.copyPackId ? rec.packs.get(d.copyPackId) : undefined;
  return {
    campaignId: c.id,
    appId: c.appId,
    request: c.request ?? c.name,
    name: c.name,
    kind: settings.kind,
    format: {
      aspectRatio: settings.aspectRatio,
      lengthSec: settings.lengthSec,
      channel: settings.channel ?? c.channels[0],
      output: settings.output,
      ...(settings.slides ? { slides: settings.slides } : {}),
      ...(settings.store ? { store: settings.store } : {}),
    },
    startedBy: s?.startedBy ?? c.createdBy,
    createdAt: c.createdAt,
    stage,
    status,
    pct: status === "done" ? 100 : d.pct,
    detail: status === "working" ? d.detail : undefined,
    ideaTitle: d.ideaTitle,
    ideaCount: d.ideaCount,
    variantId: d.variantId,
    compositionId: d.compositionId,
    decision,
    failure: status === "failed" ? d.failure : null,
    wait,
    video:
      d.finalAssetId && settings.output === "video"
        ? { assetId: d.finalAssetId, posterAssetId: asset?.posterAssetId, version: asset?.render?.version, durationSec: asset?.durationSec, width: asset?.width, height: asset?.height, renderedAt: asset?.createdAt }
        : null,
    stills: still && d.finalAssetId ? { assetIds: (d.finalAssetIds?.length ? d.finalAssetIds : [d.finalAssetId]).slice(0, 20), version: asset?.render?.version, width: asset?.width, height: asset?.height, renderedAt: asset?.createdAt } : null,
    text: settings.output === "text_post" && d.copyPackId && pack ? { copyPackId: pack.id, channel: pack.channel, text: textPostText(pack).slice(0, 10_000), ok: pack.validation?.ok ?? false } : null,
    actions: can(member, "content.write") ? actionsFor(status, decision, Boolean(d.failure?.canRetry && d.failure.jobId)) : [],
  };
}

/** GET /apps/:appId/create-runs: the app's Create runs of the last week, newest first. */
export async function listCreateRuns(p: Platform, wid: string, appId: string, member: Member, opts: { limit?: number } = {}): Promise<CreateRunView[]> {
  const page = await p.db.ws(wid).collection("campaigns").list({ where: [["appId", "==", appId]], orderBy: { field: "createdAt", dir: "desc" }, limit: 50 });
  const now = nowMs(p);
  const runs = page.items.filter((c) => c.origin === "create" && c.status !== "archived" && now - Date.parse(c.createdAt) < CREATE_RUN_FOLLOW_MS).slice(0, opts.limit ?? 6);
  const load = loader(p, wid);
  return Promise.all(runs.map(async (c) => toView(await load(c), member, now)));
}

async function createCampaignOrThrow(p: Platform, wid: string, campaignId: string): Promise<Campaign> {
  const c = await p.db.ws(wid).collection("campaigns").getOrThrow(campaignId);
  if (c.origin !== "create") throw new AppError("NOT_FOUND", "Create run not found");
  return c;
}

/** GET /create-runs/:campaignId */
export async function getCreateRun(p: Platform, wid: string, campaignId: string, member: Member): Promise<CreateRunView> {
  const c = await createCampaignOrThrow(p, wid, campaignId);
  return toView(await loader(p, wid)(c), member, nowMs(p));
}

/**
 * POST /create-runs/:campaignId/resolve (the route checks `content.write`). Records the person's
 * answer, then lets the runner take the step as that person; a refused step comes back as the run's
 * new decision. `stepKey` must match the decision the person saw (a newer version → CONFLICT).
 */
export async function resolveCreateRun(p: Platform, wid: string, campaignId: string, input: ResolveCreateRunRequest, actor: string, member: Member): Promise<CreateRunView> {
  const c = await createCampaignOrThrow(p, wid, campaignId);
  const view = toView(await loader(p, wid)(c), member, nowMs(p));
  if (!view.actions.includes(input.action)) {
    throw new AppError("CONFLICT", `This video can’t ${input.action} now (it is ${view.status})`, { userMessage: view.status === "done" ? "This video is already finished." : "That isn’t possible for this video right now. Have a look at where it is now." });
  }
  const stale = () => new AppError("CONFLICT", "The decision changed", { userMessage: "This video changed since you looked. Have a look at it again.", details: { reason: "stale_decision" } });
  if (input.stepKey && view.decision && input.stepKey !== view.decision.stepKey) throw stale();
  const at = iso(nowMs(p));
  const moved = { status: "working" as const, decision: undefined, waitUntil: undefined, waitReason: undefined, waitKind: undefined, waits: 0, touchedAt: at, actingAs: actor };
  switch (input.action) {
    case "stop":
      await patchRun(p, wid, c.id, { status: "stopped", decision: undefined, waitUntil: undefined, waitReason: undefined, waitKind: undefined, touchedAt: at }, actor);
      return getCreateRun(p, wid, c.id, member);
    case "approve_spend": {
      const d = view.decision!;
      if (d.kind !== "spend" || d.credits === undefined) throw stale();
      await patchRun(p, wid, c.id, { ...moved, approvedSpend: { stepKey: d.stepKey, credits: d.credits, by: actor, at } }, actor);
      break;
    }
    case "override": {
      const d = view.decision!;
      if (d.kind !== "brand") throw stale();
      await patchRun(p, wid, c.id, { ...moved, override: { stepKey: d.stepKey, reason: clip(input.reason!.trim(), 500), by: actor, at } }, actor);
      break;
    }
    case "retry":
      if (view.status === "failed" && view.failure?.jobId) {
        // "Try again" on a failed job: run it again as a new job (POST /jobs/:id/retry; credits held again).
        await p.jobs.retry(wid, view.failure.jobId, actor);
        await patchRun(p, wid, c.id, { ...moved, failure: undefined }, actor);
        return getCreateRun(p, wid, c.id, member);
      }
      await patchRun(p, wid, c.id, moved, actor);
      break;
  }
  await advanceCreateRun(p, wid, c.id, { source: "person" });
  return getCreateRun(p, wid, c.id, member);
}

// ---------------------------------------------------------------------------
// Needs you (Home, the Needs you page, the phone app)
// ---------------------------------------------------------------------------

/** Needs-you words for a run's decision ("Your carousel needs a look…", "Your screenshots need a fix…"). */
function wordsFor(output: RunOutput): Record<CreateRunDecision["kind"], { title: string; approve: string; review?: string }> {
  const w = wordsOf(output);
  const your = `Your ${w.one}`;
  const need = w.plural ? "need" : "needs";
  return {
    brand: { title: `${your} ${need} a look before ${w.its} finished`, approve: "Finish it anyway", review: "Open it" },
    spend: { title: `${your} came out longer than you chose`, approve: "Finish it", review: "Open it" },
    credits: { title: `Not enough credits to finish your ${w.one}`, approve: "Try again", review: "Credits" },
    limit: { title: `${your} wait${w.s} for your plan’s limit`, approve: "Try again", review: "See your plan" },
    fix: { title: `${your} ${need} a fix before ${w.its} finished`, approve: "Try again", review: "Open it" },
    permission: { title: `${your} ${w.is} waiting for an editor`, approve: "Continue", review: "Open it" },
    resume: { title: `${your} ${w.is} waiting`, approve: "Continue", review: "Open it" },
    error: { title: `${your} stopped`, approve: "Try again", review: "Open it" },
  };
}

/** Needs-you items for Create runs that stopped for a person (a decision, or a failed step). */
export async function createRunNeedsYou(p: Platform, wid: string, has: (cap: Capability) => boolean, member: Member, opts: { appId?: string } = {}): Promise<NeedsYouItem[]> {
  const where: [string, "==" | "in", unknown][] = [["createRun.status", "in", ["needs_you", "failed"]]];
  if (opts.appId) where.push(["appId", "==", opts.appId]);
  const page = await p.db.ws(wid).collection("campaigns").list({ where, limit: 50 });
  const now = nowMs(p);
  const load = loader(p, wid);
  const out: NeedsYouItem[] = [];
  for (const c of page.items) {
    if (c.origin !== "create" || c.status === "archived" || now - Date.parse(c.createdAt) > CREATE_RUN_FOLLOW_MS) continue;
    const v = toView(await load(c), member, now);
    const item = itemFor(v, has);
    if (item) out.push(item);
  }
  return out;
}

function itemFor(v: CreateRunView, has: (cap: Capability) => boolean): NeedsYouItem | null {
  const resolve = `/create-runs/${v.campaignId}/resolve`;
  const name = `“${clip(v.ideaTitle ?? v.name, 80)}”`;
  const createPage = `/a/${v.appId}/create?run=${encodeURIComponent(v.campaignId)}`;
  const studio = v.compositionId ? `/a/${v.appId}/creator/studio/${v.compositionId}` : createPage;
  const base = {
    id: v.campaignId,
    kind: "decision" as const,
    action: "create_run",
    appId: v.appId,
    subject: { entity: "campaigns", id: v.campaignId },
    requiredCap: "content.write",
    canDecide: has("content.write"),
    stale: false,
    reject: { path: resolve, body: { action: "stop" } },
    preview: v.compositionId ? { compositionId: v.compositionId, compositionTitle: clip(v.ideaTitle ?? v.name, 200) } : undefined,
  };
  const output: RunOutput = v.format.output ?? "video";
  const w = wordsOf(output);
  const stays = output === "text_post" ? "It stays with the campaign" : `${w.plural ? "They stay" : "It stays"} in the editor`;
  const labels = (approve: string, review?: string) => ({ approve, reject: "Leave it", approved: `Muse carries on with your ${w.one}. Nothing is posted without your OK.`, rejected: `Left unfinished. ${stays}, and you can continue ${w.it} from Create.`, ...(review ? { review } : {}) });
  if (v.status === "failed" && v.failure) {
    return {
      ...base,
      title: `Your ${w.one} stopped`,
      summary: clip(`${name}: ${v.failure.message}`, 1000),
      createdAt: v.createdAt,
      approve: v.failure.canRetry && v.failure.jobId ? { path: resolve, body: { action: "retry" } } : null,
      reviewPath: createPage,
      labels: labels("Try again", "Open it"),
    };
  }
  const d = v.decision;
  if (v.status !== "needs_you" || !d) return null;
  const words = wordsFor(output)[d.kind];
  const reviewPath = d.kind === "credits" || d.kind === "limit" ? "/settings/credits" : d.kind === "brand" || d.kind === "fix" || d.kind === "spend" ? studio : createPage;
  let summary = `${name}: ${d.message}`;
  if (d.kind === "brand") summary = `${name}: the Brand check found something: ${d.message} ${d.canOverride ? "Open it to fix it, or finish it anyway with a reason." : "Open it to fix it, then try again."}`;
  if (d.kind === "credits") summary = `${name}: ${d.message} Add credits, then try again.`;
  const override = d.kind === "brand" && d.canOverride;
  return {
    ...base,
    title: words.title,
    summary: clip(summary, 1000),
    createdAt: d.at,
    ...(d.kind === "spend" && d.credits !== undefined ? { credits: d.credits } : {}),
    approve: { path: resolve, body: { action: d.kind === "spend" ? "approve_spend" : override ? "override" : "retry", stepKey: d.stepKey } },
    reviewPath,
    labels: labels(d.kind === "spend" && d.credits !== undefined ? `Finish it · ${d.credits} credits` : d.kind === "brand" && !override ? "Try again" : words.approve, words.review),
    ...(override ? { approveReason: { label: "Why it’s fine to finish it", placeholder: "Why it’s fine (kept with the Brand check)" } } : {}),
  };
}
