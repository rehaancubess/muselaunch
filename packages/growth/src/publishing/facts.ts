/**
 * One-tap fixes for a post the fact check held back ("This post mentions racing and bowling, which
 * aren't in your confirmed facts yet."), instead of a dead draft:
 *
 *  - "Remove it": Muse Spark rewrites the post's copy without the flagged words, the copy is checked
 *    again, and the post shows the rewritten copy (`post.fix_facts` job, action `remove`).
 *  - "It's true, add it": the person confirms the statement. It becomes a fact sourced to them
 *    (founder-confirmed evidence + a claim citing it; confirmed straight away only for members who
 *    may approve content, like every other fact they add), then the copy is checked again
 *    (`post.fix_facts`, action `recheck`).
 *
 * Nothing passes without a source: the re-check uses the same validator (confirmed facts + the
 * app's own listing/website evidence), and a flagged word that survives a rewrite keeps the post
 * held back. When Autopilot drafted the post, its publish approval is requested afterwards exactly
 * as Autopilot would have (Brand Guardian gate, never overridden), so it shows up in Needs you.
 */
import { brandGate, readPackIssue, recheckCopyPack, reviseCopyPack, sentenceWith } from "@muselaunch/agents";
import { can, type AppEvidence, type Autopilot, type Claim, type ConfirmPostFactRequest, type CopyPack, type CopyValidationIssue, type Job, type PostFactCheck, type ScheduledPost, type WorkspaceMember } from "@muselaunch/contracts";
import { nowIso, type WorkspaceDb } from "@muselaunch/db";
import { AppError, toAppError, type JobContext, type JobResult, type Platform } from "@muselaunch/platform";
import { expireApprovals } from "../approvals";
import { normText, sha256 } from "../util";
import { captionForPack, preflight, requestPostApproval } from "./posts";

type FactIssue = PostFactCheck["issues"][number];
type Member = Pick<WorkspaceMember, "role" | "canPublish" | "canManageAccounts" | "status">;

/** Post states a fact fix may change (never one that is approved, publishing or done). */
const FIXABLE: ScheduledPost["status"][] = ["draft", "failed", "awaiting_approval"];
const AUTOPILOT_BUSY: Autopilot["status"][] = ["running", "waiting_on_jobs"];

const idOf = (prefix: string, ...parts: string[]) => `${prefix}_${sha256(parts.join("␟")).slice(0, 24)}`;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** "a", "a and b", "a, b and c". */
function listWords(xs: string[]): string {
  if (xs.length <= 1) return xs[0] ?? "";
  return `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
}

function dedupe(xs: string[]): string[] {
  const seen = new Set<string>();
  return xs.filter((x) => {
    const k = normText(x);
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * A stored validation issue as a fact issue (null for channel limits). Packs written before issues
 * carried a kind are read from their wording, so a draft held back earlier can be fixed too.
 */
export function asFactIssue(raw: CopyValidationIssue): FactIssue | null {
  const i = readPackIssue(raw);
  if (i.kind === "limit") return null;
  return { itemId: i.itemId, kind: i.kind, issue: i.issue, quote: i.quote, terms: i.terms, statement: i.statement };
}

/** "This post mentions racing and bowling, which aren't in your confirmed facts yet." */
export function factMessage(issues: FactIssue[]): string {
  const backed = issues.filter((i) => i.kind !== "prohibited");
  const banned = issues.filter((i) => i.kind === "prohibited");
  const words = dedupe(backed.flatMap((i) => (i.kind === "figure" ? (i.quote ? [`“${i.quote}”`] : []) : i.terms.length ? i.terms : i.quote ? [`“${i.quote}”`] : [])));
  const parts: string[] = [];
  if (backed.length) {
    parts.push(
      words.length
        ? `This post mentions ${listWords(words.slice(0, 4))}${words.length > 4 ? " and more" : ""}, which ${words.length === 1 ? "isn’t" : "aren’t"} in your confirmed facts yet.`
        : "This post says something about your app that isn’t in your confirmed facts yet.",
    );
  }
  if (banned.length) parts.push(`${backed.length ? "It also uses" : "This post uses"} ${listWords(dedupe(banned.map((i) => `“${i.quote ?? "a phrase"}”`)))}, which you asked never to say.`);
  return parts.join(" ");
}

/** The fact check of a post's copy, in plain words, with what each one-tap fix would do. */
export function factCheckOfPack(pack: CopyPack, fixJob?: Pick<Job, "id" | "status" | "payload"> | null): PostFactCheck | null {
  if (!pack.validation) return null;
  const issues = pack.validation.issues.map(asFactIssue).filter((x): x is FactIssue => Boolean(x));
  const textOf = (itemId: string) => pack.items.find((it) => it.id === itemId)?.text ?? "";
  const statements = dedupe(
    issues
      .filter((i) => i.kind !== "prohibited")
      .map((i) => i.statement ?? (i.quote ? sentenceWith(textOf(i.itemId), i.quote) : undefined) ?? (i.terms[0] ? sentenceWith(textOf(i.itemId), i.terms[0]) : undefined))
      .filter((x): x is string => Boolean(x?.trim()))
      .map((x) => clip(x.trim(), 500)),
  ).slice(0, 3);
  const fix = fixJob ? { jobId: fixJob.id, action: ((fixJob.payload as { action?: string }).action === "remove" ? "remove" : "recheck") as "remove" | "recheck", status: fixJob.status } : undefined;
  return {
    copyPackId: pack.id,
    ok: issues.length === 0,
    checkedAt: pack.validation.checkedAt,
    issues,
    message: issues.length ? factMessage(issues) : "The post’s copy passed the fact check.",
    quotes: dedupe(issues.map((i) => i.quote ?? "").filter(Boolean)).slice(0, 6),
    excerpts: dedupe(issues.map((i) => (i.quote ? sentenceWith(textOf(i.itemId), i.quote) : undefined) ?? (i.terms[0] ? sentenceWith(textOf(i.itemId), i.terms[0]) : undefined) ?? "").filter(Boolean)).slice(0, 4),
    statements,
    ...(fix ? { fix } : {}),
  };
}

/** The post's fact check (null when the post has no generated copy to check). */
export async function postFactCheck(ws: WorkspaceDb, post: ScheduledPost): Promise<PostFactCheck | null> {
  if (!post.copyPackId) return null;
  const [pack, job] = await Promise.all([ws.collection("copyPacks").get(post.copyPackId), post.factFixJobId ? ws.collection("jobs").get(post.factFixJobId) : Promise.resolve(null)]);
  return pack ? factCheckOfPack(pack, job) : null;
}

/** The preflight error for a held-back pack, in plain words (limits stay their own errors). */
export function factPreflightErrors(pack: CopyPack): string[] {
  if (!pack.validation || pack.validation.ok) return [];
  const facts = pack.validation.issues.map(asFactIssue).filter((x): x is FactIssue => Boolean(x));
  const limits = pack.validation.issues.filter((i) => asFactIssue(i) === null).map((i) => `${i.issue}.`.replace(/\.\.$/, "."));
  return [...(facts.length ? [`${factMessage(facts)} Remove it or confirm it as a fact, then ask for approval.`] : []), ...limits];
}

async function loadFixable(ws: WorkspaceDb, postId: string): Promise<{ post: ScheduledPost; pack: CopyPack }> {
  const post = await ws.collection("scheduledPosts").getOrThrow(postId);
  if (!FIXABLE.includes(post.status)) throw new AppError("CONFLICT", `Post is ${post.status}`, { userMessage: "This post can’t be changed any more." });
  if (!post.copyPackId) throw new AppError("CONFLICT", "This post has no generated copy to check", { userMessage: "This post’s caption wasn’t written by Muse, so there’s no fact check to fix." });
  const pack = await ws.collection("copyPacks").getOrThrow(post.copyPackId);
  if (pack.appId !== post.appId) throw new AppError("NOT_FOUND", "Copy pack not found");
  return { post, pack };
}

async function fixInFlight(ws: WorkspaceDb, post: ScheduledPost): Promise<void> {
  if (!post.factFixJobId) return;
  const job = await ws.collection("jobs").get(post.factFixJobId);
  if (job && (job.status === "queued" || job.status === "running")) throw new AppError("CONFLICT", "A fix for this post is already running", { userMessage: "Muse is already fixing this post. It takes a moment." });
}

/** "Remove it": start the rewrite (charged like a small copy job). */
export async function requestFactRemoval(p: Platform, wid: string, postId: string, actor: string): Promise<{ post: ScheduledPost; job: Job }> {
  const ws = p.db.ws(wid);
  const { post, pack } = await loadFixable(ws, postId);
  const check = factCheckOfPack(pack);
  if (!check || check.ok) throw new AppError("CONFLICT", "The copy already passes the fact check", { userMessage: "This post’s copy already passes the fact check." });
  await fixInFlight(ws, post);
  const job = await p.jobs.create(
    wid,
    "post.fix_facts",
    { appId: post.appId, postId: post.id, copyPackId: pack.id, action: "remove" },
    { actor, appId: post.appId, idempotencyKey: `post.fix_facts:remove:${post.id}:${pack.id}`, credits: { operation: "post.fix_facts", params: { action: "remove" } } },
  );
  const updated = await ws.collection("scheduledPosts").update(post.id, { factFixJobId: job.id }, { actor });
  return { post: updated, job };
}

/**
 * "It's true, add it": record the person's confirmation as facts with a source, then (when the
 * facts are confirmed) check the copy again. Members who may not approve content add the facts for
 * review, like any fact they add; the post stays held back until an owner or admin confirms them.
 */
export async function confirmPostFacts(
  p: Platform,
  wid: string,
  postId: string,
  input: ConfirmPostFactRequest,
  member: Member,
  actor: string,
): Promise<{ post: ScheduledPost; claims: Claim[]; evidence: AppEvidence[]; job: Job | null; confirmed: boolean }> {
  const ws = p.db.ws(wid);
  const { post, pack } = await loadFixable(ws, postId);
  const check = factCheckOfPack(pack);
  if (!check || check.ok) throw new AppError("CONFLICT", "The copy already passes the fact check", { userMessage: "This post’s copy already passes the fact check." });
  if (check.issues.every((i) => i.kind === "prohibited")) throw new AppError("CONFLICT", "Prohibited wording can't be confirmed", { userMessage: "You asked never to say this, so it can’t be added as a fact. Remove it instead." });
  const statements = dedupe((input.statements?.length ? input.statements : check.statements).map((s) => s.trim()).filter((s) => s.length >= 4));
  if (!statements.length) throw new AppError("BAD_REQUEST", "Nothing to confirm", { userMessage: "Write the fact you want to confirm." });
  const brand = await ws.collection("brandProfiles").get(post.appId);
  for (const s of statements) {
    const hit = (brand?.prohibitedClaims ?? []).find((pc) => pc.trim() && normText(s).includes(normText(pc)));
    if (hit) throw new AppError("BAD_REQUEST", "Statement matches a prohibited claim", { userMessage: `“${hit}” is on your never-say list, so it can’t be confirmed as a fact.` });
  }
  await fixInFlight(ws, post);

  const approver = can(member, "content.approve");
  const state = approver ? ("verified" as const) : ("needs_review" as const);
  const now = nowIso();
  const quote = check.quotes[0];
  const evidence: AppEvidence[] = [];
  const claims: Claim[] = [];
  for (const statement of statements) {
    const key = normText(statement);
    const ev = await ws.collection("appEvidence").createIfAbsent(
      {
        id: idOf("evd", post.appId, "founder", key),
        appId: post.appId,
        kind: "feature",
        fact: clip(statement, 1000),
        source: {
          kind: "user_input",
          publisher: "Founder-confirmed",
          title: "Confirmed by the founder while fixing a post",
          retrievedAt: now,
          excerpt: quote ? clip(`The post said: “${quote}”`, 2000) : undefined,
        },
        observedAt: now,
        reviewState: state,
      },
      { actor },
    );
    let e = ev.entity;
    if (!ev.created && approver && e.reviewState !== "verified") e = await ws.collection("appEvidence").update(e.id, { reviewState: "verified" }, { actor });
    evidence.push(e);

    const claimId = idOf("clm", post.appId, "founder", key);
    const existing = await ws.collection("claims").get(claimId);
    const note = approver ? "Confirmed by the founder while fixing a post the fact check held back" : "Added while fixing a post; waiting for an owner or admin to confirm";
    if (!existing) {
      claims.push(
        await ws.collection("claims").create(
          {
            id: claimId,
            appId: post.appId,
            text: clip(statement, 500),
            evidenceIds: [e.id],
            confidence: 1,
            state,
            permittedContexts: ["all"],
            origin: "user",
            speculative: false,
            reviewedBy: approver ? actor : undefined,
            reviewedAt: approver ? now : undefined,
            history: [{ at: now, by: actor, to: state, note }],
          },
          { actor },
        ),
      );
    } else {
      const promote = approver && existing.state !== "verified";
      claims.push(
        await ws.collection("claims").update(
          claimId,
          {
            evidenceIds: [...new Set([...existing.evidenceIds, e.id])].slice(0, 50),
            ...(promote ? { state: "verified" as const, speculative: false, reviewedBy: actor, reviewedAt: now, history: [...existing.history, { at: now, by: actor, from: existing.state, to: "verified" as const, note }].slice(-50) } : {}),
          },
          { actor },
        ),
      );
    }
  }
  if (!approver) return { post, claims, evidence, job: null, confirmed: false };
  const job = await p.jobs.create(
    wid,
    "post.fix_facts",
    { appId: post.appId, postId: post.id, copyPackId: pack.id, action: "recheck", claimId: claims[0]?.id },
    { actor, appId: post.appId, idempotencyKey: `post.fix_facts:recheck:${post.id}:${pack.id}:${claims.map((c) => c.id).join(",")}`, credits: { operation: "post.fix_facts", params: { action: "recheck" } } },
  );
  const updated = await ws.collection("scheduledPosts").update(post.id, { factFixJobId: job.id }, { actor });
  return { post: updated, claims, evidence, job, confirmed: true };
}

/** The Autopilot run that drafted this post, if any (current or earlier round). */
export async function autopilotOfPost(ws: WorkspaceDb, post: Pick<ScheduledPost, "id" | "appId">): Promise<Autopilot | null> {
  const page = await ws.collection("autopilots").list({ where: [["appId", "==", post.appId]], orderBy: { field: "createdAt", dir: "desc" }, limit: 20 });
  return page.items.find((ap) => ap.scheduledPostIds.includes(post.id) || ap.log.some((e) => e.refs.some((r) => r.entity === "scheduledPosts" && r.id === post.id))) ?? null;
}

/** `post.fix_facts`: rewrite or re-check the copy, show it on the post, and ask for approval as Autopilot would. */
export async function postFixFactsHandler(ctx: JobContext<"post.fix_facts">): Promise<JobResult> {
  const { appId, postId, copyPackId, action } = ctx.payload;
  const ws = ctx.ws;
  let post = await ws.collection("scheduledPosts").getOrThrow(postId);
  if (post.appId !== appId) throw new AppError("NOT_FOUND", "Post not found");
  if (!FIXABLE.includes(post.status)) return { data: { skipped: `Post is ${post.status}` }, creditsUsed: 0 };

  const pack = action === "remove" ? (await reviseCopyPack(ctx, { appId, packId: copyPackId })).pack : await recheckCopyPack(ctx, { appId, packId: copyPackId });
  ctx.throwIfCancelled();
  await ctx.progress(85, pack.validation?.ok ? "the post passes the fact check" : "the fact check still holds the post back");

  // The post shows the rewritten copy. A content change resets any approval (it was for other words).
  if (pack.id !== post.copyPackId) {
    const derived = await captionForPack(ws, post, pack);
    const changed = derived.caption !== post.caption || derived.title !== post.title;
    post = await ws.collection("scheduledPosts").update(post.id, { copyPackId: pack.id, ...derived }, { actor: ctx.actor });
    if (changed && post.approvalId) {
      await expireApprovals(ws, { entity: "scheduledPosts", id: post.id }, post.appId, ctx.actor, "Post copy rewritten by the fact-check fix");
      post = await ws.collection("scheduledPosts").update(post.id, { status: "draft", approvalId: undefined }, { actor: ctx.actor });
    }
  }

  const ok = Boolean(pack.validation?.ok);
  const pf = await preflight(ws, post);
  const ap = await autopilotOfPost(ws, post);
  let approvalId: string | undefined;
  let outcome: string;
  const what = action === "remove" ? "Removed the words the fact check flagged" : "Checked the post again with the fact you confirmed";
  if (!ok) outcome = `${what}, but the fact check still holds the post back: ${factCheckOfPack(pack)?.message ?? "see the post"}`;
  else if (!ap) outcome = pf.errors.length ? `${what}; the post passes the fact check. Before approval: ${pf.errors[0]}` : `${what}; the post passes the fact check and approval can be requested.`;
  else {
    try {
      // Same gates Autopilot uses when it drafts posts (the Brand Guardian is never overridden here).
      await brandGate(ctx.platform, ctx.workspaceId, { subject: { entity: "scheduledPosts", id: post.id }, actor: ctx.actor, canOverride: false, action: "request_approval" });
      const r = await requestPostApproval(ctx.platform, ctx.workspaceId, post.id, ctx.actor);
      approvalId = r.approval.id;
      outcome = `${what}; the post passes the fact check and is waiting for your OK.`;
    } catch (raw) {
      const err = toAppError(raw);
      outcome = `${what}; the post passes the fact check, but approval can’t be requested yet: ${err.opts.userMessage ?? err.message}`;
    }
  }
  if (ap && !AUTOPILOT_BUSY.includes(ap.status)) {
    const fresh = await ws.collection("autopilots").get(ap.id);
    if (fresh && !AUTOPILOT_BUSY.includes(fresh.status)) {
      const refs = [{ entity: "scheduledPosts", id: post.id }, { entity: "copyPacks", id: pack.id }, ...(approvalId ? [{ entity: "approvals", id: approvalId }] : [])];
      await ws.collection("autopilots").update(fresh.id, { log: [...fresh.log, { at: nowIso(), stage: fresh.stage, kind: "action" as const, summary: clip(`Post fact check: ${outcome}`, 1200), refs }].slice(-400) }, { actor: ctx.actor });
    }
  }
  return {
    refs: [{ entity: "scheduledPosts", id: post.id }, { entity: "copyPacks", id: pack.id }, ...(approvalId ? [{ entity: "approvals", id: approvalId }] : [])],
    data: { ok, approvalId, autopilotId: ap?.id, outcome, issues: pack.validation?.issues.length ?? 0 },
  };
}
