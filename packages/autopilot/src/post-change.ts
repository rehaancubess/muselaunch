/**
 * "Tell Muse what to change" on a post (Creator → Today, the post sheet): the person says what to
 * change, typed or spoken, and the post then uses the changed version. Nothing new is invented here;
 * it chains the paths the Studio already uses:
 *
 *  - video: the Studio's AI edit (`composition.edit`, Muse Spark, scene-scoped, on the editable
 *    composition; applied as a new version with undo) → the same Brand Guardian gate the Studio's
 *    final render has (never overridden here) → `render.final` (HyperFrames) → the post uses the new
 *    render (growth `usePostRender`), so an approval given for the old video expires;
 *  - caption: `post.revise_copy` (Muse Spark rewrites the copy as asked, the fact check runs again)
 *    → the post shows it (growth `usePostCopyPack`), same approval rule.
 *
 * Asking for a change ends the approval waiting (or given) for the old version, so it can't go out
 * meanwhile; afterwards (changed or not) the post asks for approval again, through the same Brand
 * Guardian gate Autopilot uses, so it shows up in Needs you / Today again. The post
 * remembers the newest change (`post.change`) with honest progress (the job running now) and one
 * plain line on what changed. Steps advance from the job lifecycle hook (hooks.ts) and, if a hook
 * was missed, when Today is read (repairPostChanges).
 */
import { brandGate, rewriteCopyForPost } from "@muselaunch/agents";
import { totalDuration } from "@muselaunch/compositions";
import { getVersion } from "@muselaunch/compositions/store";
import { isPostChangeRunning, TERMINAL_JOB_STATUSES, type ChangePostRequest, type Job, type PostChange, type ScheduledPost } from "@muselaunch/contracts";
import { expireApprovals, factCheckOfPack, requestPostApproval, usePostCopyPack, usePostRender } from "@muselaunch/growth";
import { AppError, toAppError, type JobContext, type JobResult, type Platform } from "@muselaunch/platform";
import { hashId } from "./state";

/** Posts that can still change (not going out, not out, not cancelled). */
export const CHANGEABLE_POST: readonly ScheduledPost["status"][] = ["draft", "failed", "awaiting_approval", "scheduled", "manual_post_needed"];
/** Statuses that mean someone asked for (or gave) approval: it is asked for again after a change. */
const ASKED: readonly ScheduledPost["status"][] = ["awaiting_approval", "scheduled", "manual_post_needed"];
/** Job types a post change waits on. */
export const POST_CHANGE_JOBS: ReadonlySet<Job["type"]> = new Set(["composition.edit", "render.final", "post.revise_copy"]);

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const isDone = (j: Pick<Job, "status">) => (TERMINAL_JOB_STATUSES as readonly string[]).includes(j.status);
const nowIso = () => new Date().toISOString();

/** "scene 1", "scenes 1 and 3", "scenes 1, 2 and 4". */
export function sceneWords(numbers: number[]): string {
  const n = [...new Set(numbers)].sort((a, b) => a - b);
  if (!n.length) return "";
  if (n.length === 1) return `scene ${n[0]}`;
  return `scenes ${n.slice(0, -1).join(", ")} and ${n[n.length - 1]}`;
}

/** One plain line for a video change: Spark's own summary plus the scenes it touched. */
export function videoChangeLine(summary: string | undefined, sceneNumbers: number[]): string {
  const s = (summary ?? "").trim().replace(/[.\s]+$/, "") || "Changed the video";
  const where = sceneWords(sceneNumbers);
  return clip(where ? `${s} (${where})` : s, 500);
}

/** Credits a change uses, shown before anything is spent ("Uses about N credits"). */
export async function estimatePostChange(p: Platform, wid: string, postId: string, part: PostChange["part"]): Promise<{ credits: number; breakdown: { label: string; credits: number }[]; available: number }> {
  const ws = p.db.ws(wid);
  const post = await ws.collection("scheduledPosts").getOrThrow(postId);
  const available = (await p.credits.balance(wid)).available;
  if (part === "caption") return { ...p.credits.estimate("post.revise_copy"), available };
  if (!post.compositionId) throw noVideo();
  const comp = await ws.collection("compositions").getOrThrow(post.compositionId);
  const v = await getVersion(ws, comp.id, comp.currentVersion);
  // The edit may change the length a little; the render is reserved for the new length when it starts.
  const durationSec = Math.round(totalDuration(v.doc));
  const edit = p.credits.estimate("composition.edit");
  const render = p.credits.estimate("render.final", { durationSec });
  return { credits: edit.credits + render.credits, breakdown: [{ label: "Change the video (Muse Spark)", credits: edit.credits }, ...render.breakdown], available };
}

const noVideo = () => new AppError("BAD_REQUEST", "This post has no editable video", { userMessage: "This post’s video wasn’t made in MuseLaunch, so Muse can’t change it. You can still change the caption." });

/**
 * Start a change (route: POST /posts/:id/change, content.write). The job is created first, the post
 * remembers it, and only then does the job start, so its finish always finds the post.
 */
export async function requestPostChange(p: Platform, wid: string, postId: string, input: ChangePostRequest, actor: string): Promise<{ post: ScheduledPost; change: PostChange; job: Job }> {
  const ws = p.db.ws(wid);
  const post = await ws.collection("scheduledPosts").getOrThrow(postId);
  if (!CHANGEABLE_POST.includes(post.status)) throw new AppError("CONFLICT", `Post is ${post.status}`, { userMessage: post.status === "publishing" ? "This post is going out right now, so it can’t change." : post.status === "cancelled" ? "This post was cancelled, so it can’t change." : "This post is already out, so it can’t change any more." });
  if (isPostChangeRunning(post.change)) throw new AppError("CONFLICT", "A change to this post is already running", { userMessage: "Muse is still making your last change to this post. It takes a moment." });
  const instruction = clip(input.instruction.trim(), 2000);
  const startedAt = nowIso();
  const id = hashId("chg", post.id, startedAt, instruction);
  const base = { id, part: input.part, instruction, spoken: Boolean(input.spoken), hadApproval: ASKED.includes(post.status), by: actor, startedAt };
  let job: Job;
  let change: PostChange;
  if (input.part === "caption") {
    if (!post.caption.trim() && !post.title?.trim()) throw new AppError("BAD_REQUEST", "This post has no caption", { userMessage: "This post has no caption to change yet." });
    job = await p.jobs.create(wid, "post.revise_copy", { appId: post.appId, postId: post.id, changeId: id, instruction }, { actor, appId: post.appId, idempotencyKey: `post.change:${id}:copy`, credits: { operation: "post.revise_copy" }, deferDispatch: true });
    change = { ...base, status: "rewriting", jobId: job.id };
  } else {
    if (!post.compositionId) throw noVideo();
    const comp = await ws.collection("compositions").getOrThrow(post.compositionId);
    if (comp.appId !== post.appId) throw new AppError("NOT_FOUND", "Composition not found");
    // Same records as the Studio's AI edit (POST /compositions/:id/ai-edit), applied on its own here:
    // the person reviews the result as the post's new version before approving it.
    const patch = await ws.collection("compositionPatches").create(
      { compositionId: comp.id, baseVersion: comp.currentVersion, ops: [], summary: "Generating edit…", source: "ai", instruction, affectedSceneIds: [], status: "proposed", validationErrors: [], memoryRefs: [] },
      { actor },
    );
    job = await p.jobs.create(
      wid,
      "composition.edit",
      { appId: comp.appId, compositionId: comp.id, baseVersion: comp.currentVersion, instruction, sceneIds: [], patchId: patch.id, autoApply: true, clipAnalysisIds: [] },
      { actor, appId: comp.appId, idempotencyKey: `post.change:${id}:edit`, credits: { operation: "composition.edit" }, deferDispatch: true },
    );
    change = { ...base, status: "editing", jobId: job.id, editJobId: job.id, patchId: patch.id, fromVersion: comp.currentVersion };
  }
  // Asking for a change means "not this version": the approval waiting (or given) for it ends now,
  // so the old version can't go out while Muse works. It's asked for again when the change is done.
  if (base.hadApproval) await expireApprovals(ws, { entity: "scheduledPosts", id: post.id }, post.appId, actor, "Asked Muse for a change");
  const updated = await ws.collection("scheduledPosts").update(post.id, { change, lastError: undefined, ...(base.hadApproval ? { status: "draft" as const, approvalId: undefined, publishState: undefined } : {}) }, { actor });
  await p.jobs.dispatch(job);
  return { post: updated, change, job };
}

/** Ask for the post's approval again, through the same gates Autopilot uses. Returns why not, if it couldn't. */
async function askAgain(p: Platform, wid: string, postId: string, actor: string): Promise<string | undefined> {
  try {
    await brandGate(p, wid, { subject: { entity: "scheduledPosts", id: postId }, actor, canOverride: false, action: "request_approval" });
    await requestPostApproval(p, wid, postId, actor);
    return undefined;
  } catch (raw) {
    const e = toAppError(raw);
    return clip(`It isn’t waiting for your OK yet: ${e.opts.userMessage ?? e.message}`, 500);
  }
}

/** Move a post's running change on once the job it waits on has finished. Safe to call twice. */
export async function advancePostChange(p: Platform, wid: string, postId: string, depth = 0): Promise<ScheduledPost | null> {
  const ws = p.db.ws(wid);
  const post = await ws.collection("scheduledPosts").get(postId);
  const c = post?.change;
  if (!post || !c || !isPostChangeRunning(c)) return post;
  const job = await ws.collection("jobs").get(c.jobId);
  if (!job || !isDone(job)) return post;
  const save = async (patch: Partial<PostChange>) => {
    // Only this change, and only while it's still the post's newest one.
    const fresh = await ws.collection("scheduledPosts").getOrThrow(post.id);
    if (fresh.change?.id !== c.id || !isPostChangeRunning(fresh.change)) return fresh;
    return ws.collection("scheduledPosts").update(post.id, { change: { ...fresh.change, ...patch } }, { actor: c.by });
  };
  // Not changed: the post is as it was, so it waits for approval again if it was before.
  const fail = async (note: string, extra: Partial<PostChange> = {}) => {
    const again = c.hadApproval ? await askAgain(p, wid, post.id, c.by) : undefined;
    return save({ ...extra, status: "failed", note: clip(again ? `${note} ${again}` : note, 500), finishedAt: nowIso() });
  };
  const jobMessage = (j: Job) => j.error?.userMessage ?? (j.status === "cancelled" ? "It was stopped." : "That didn’t work.");

  if (c.status === "rewriting") {
    if (job.status !== "succeeded") return fail(`${jobMessage(job)} The caption is as it was.`);
    // The handler finishes the change itself; this only covers a handler that stopped right after.
    const data = (job.output?.data ?? {}) as { summary?: string; note?: string; skipped?: string };
    if (data.skipped) return fail("The post went out before the change finished.");
    return save({ status: "done", summary: data.summary ? clip(data.summary, 500) : undefined, note: data.note, finishedAt: nowIso() });
  }

  if (c.status === "editing") {
    if (job.status !== "succeeded") return fail(`${jobMessage(job)} The video is as it was.`);
    const data = (job.output?.data ?? {}) as { status?: string; resultVersion?: number; routedTo?: string };
    if (data.routedTo) return fail("That asks for new versions, so Muse is making them as separate videos (they show up in Your videos). This post is as it was.");
    if (data.status !== "applied" || !data.resultVersion || !post.compositionId) return fail("Muse couldn’t make that change safely on its own, so the video is as it was. Open Edit in detail to review the suggested change.");
    const comp = await ws.collection("compositions").getOrThrow(post.compositionId);
    const v = await getVersion(ws, comp.id, data.resultVersion);
    const patch = c.patchId ? await ws.collection("compositionPatches").get(c.patchId) : null;
    const numbers = (patch?.affectedSceneIds ?? []).map((id) => v.doc.scenes.findIndex((s) => s.id === id) + 1).filter((n) => n > 0);
    const summary = videoChangeLine(patch?.summary, numbers);
    const kept = ` The change is saved in the editor (version ${data.resultVersion}); the post still uses the earlier video.`;
    try {
      await brandGate(p, wid, { subject: { entity: "compositions", id: comp.id }, version: data.resultVersion, actor: c.by, canOverride: false, action: "render_final" });
    } catch (raw) {
      const e = toAppError(raw);
      if ((e.opts.details as { reason?: string } | undefined)?.reason === "brand_review_running") return post; // tried again when it's done
      if (e.code === "APPROVAL_REQUIRED") return fail(`The brand check found a problem with the changed video, so it wasn’t finished.${kept} Fix it in the editor, or undo the change there.`, { summary, toVersion: data.resultVersion });
      return fail(`${e.opts.userMessage ?? e.message}${kept}`, { summary, toVersion: data.resultVersion });
    }
    let render: Job;
    try {
      render = await p.jobs.create(
        wid,
        "render.final",
        { appId: comp.appId, compositionId: comp.id, version: data.resultVersion, format: "mp4" },
        { actor: c.by, appId: comp.appId, idempotencyKey: `post.change:${c.id}:render`, credits: { operation: "render.final", params: { durationSec: Math.round(totalDuration(v.doc)) } }, deferDispatch: true },
      );
    } catch (raw) {
      const e = toAppError(raw);
      return fail(`${e.opts.userMessage ?? e.message}${kept}`, { summary, toVersion: data.resultVersion });
    }
    const saved = await save({ status: "rendering", jobId: render.id, renderJobId: render.id, toVersion: data.resultVersion, summary });
    if (isDone(render)) return depth < 2 ? advancePostChange(p, wid, post.id, depth + 1) : saved;
    await p.jobs.dispatch(render);
    return saved;
  }

  // rendering
  if (job.status !== "succeeded") return fail(`${jobMessage(job)} The change is saved in the editor${c.toVersion ? ` (version ${c.toVersion})` : ""}; the post still uses the earlier video.`);
  const assetId = (job.output?.data as { assetId?: string } | undefined)?.assetId;
  if (!assetId || !c.toVersion) return fail("The new video didn’t finish, so the post still uses the earlier one.");
  try {
    await usePostRender(p, wid, post.id, { assetId, compositionVersion: c.toVersion }, c.by);
  } catch (raw) {
    const e = toAppError(raw);
    return fail(e.opts.userMessage ?? e.message);
  }
  const note = c.hadApproval ? await askAgain(p, wid, post.id, c.by) : undefined;
  return save({ status: "done", note, finishedAt: nowIso() });
}

/** Lifecycle hook: a job a post change waits on finished. */
export async function advancePostChangesForJob(p: Platform, wid: string, job: Pick<Job, "id" | "type" | "appId">): Promise<number> {
  if (!POST_CHANGE_JOBS.has(job.type) || !job.appId) return 0;
  const posts = await p.db.ws(wid).collection("scheduledPosts").list({ where: [["appId", "==", job.appId]], orderBy: { field: "createdAt", dir: "desc" }, limit: 200 });
  let n = 0;
  for (const post of posts.items) {
    if (post.change?.jobId !== job.id || !isPostChangeRunning(post.change)) continue;
    await advancePostChange(p, wid, post.id);
    n++;
  }
  return n;
}

/** A missed hook (e.g. a restart between steps): move on every running change whose job finished. */
export async function repairPostChanges(p: Platform, wid: string, appId: string, posts?: ScheduledPost[]): Promise<number> {
  const list = posts ?? (await p.db.ws(wid).collection("scheduledPosts").list({ where: [["appId", "==", appId]], orderBy: { field: "createdAt", dir: "desc" }, limit: 200 })).items;
  let n = 0;
  for (const post of list) {
    if (!isPostChangeRunning(post.change)) continue;
    const before = post.change!;
    const after = (await advancePostChange(p, wid, post.id))?.change;
    if (after && (after.status !== before.status || after.jobId !== before.jobId)) n++;
  }
  return n;
}

/** `post.revise_copy`: rewrite the caption as asked, show it on the post, ask for approval again if it had been asked. */
export async function postReviseCopyHandler(ctx: JobContext<"post.revise_copy">): Promise<JobResult> {
  const { appId, postId, changeId, instruction } = ctx.payload;
  const ws = ctx.ws;
  const post = await ws.collection("scheduledPosts").getOrThrow(postId);
  if (post.appId !== appId) throw new AppError("NOT_FOUND", "Post not found");
  if (!CHANGEABLE_POST.includes(post.status)) return { data: { skipped: `Post is ${post.status}` }, creditsUsed: 0 };
  const { pack, summary } = await rewriteCopyForPost(ctx, { appId, post, instruction });
  ctx.throwIfCancelled();
  await ctx.progress(85, pack.validation?.ok ? "the new caption passes the fact check" : "the fact check holds the new caption back");
  await usePostCopyPack(ctx.platform, ctx.workspaceId, post.id, pack.id, ctx.actor);
  const change = post.change?.id === changeId ? post.change : undefined;
  let note: string | undefined;
  if (!pack.validation?.ok) note = clip(`${factCheckOfPack(pack)?.message ?? "The fact check holds the new caption back."} Fix it on the post, then ask for approval.`, 500);
  else if (change?.hadApproval) note = await askAgain(ctx.platform, ctx.workspaceId, post.id, ctx.actor);
  const fresh = await ws.collection("scheduledPosts").getOrThrow(post.id);
  if (fresh.change?.id === changeId && isPostChangeRunning(fresh.change)) {
    await ws.collection("scheduledPosts").update(post.id, { change: { ...fresh.change, status: "done", summary: summary || undefined, note, finishedAt: nowIso() } }, { actor: ctx.actor });
  }
  return { refs: [{ entity: "scheduledPosts", id: post.id }, { entity: "copyPacks", id: pack.id }], data: { summary, note, ok: Boolean(pack.validation?.ok) } };
}
