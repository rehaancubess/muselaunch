import { z } from "zod";
import { Actor, BaseEntity, Channel, EntityRef, HttpUrl, Id, IsoDateTime, SourceRef } from "./common";

export const ApprovalAction = z.enum(["publish", "outreach_send", "spend", "account_change", "claim_use", "render_over_budget", "agent_continue"]);
export type ApprovalAction = z.infer<typeof ApprovalAction>;

/** Explicit human authorisation for an external or costly action (spec principle 4). */
export const Approval = BaseEntity.extend({
  appId: Id.optional(),
  action: ApprovalAction,
  subject: EntityRef,
  /** Hash of the exact content/version being approved; execution must match it. */
  snapshotHash: z.string().max(128),
  summary: z.string().max(1000),
  requestedBy: Actor,
  status: z.enum(["pending", "approved", "rejected", "expired", "consumed"]),
  decidedBy: Actor.optional(),
  decidedAt: IsoDateTime.optional(),
  note: z.string().max(1000).optional(),
  expiresAt: IsoDateTime.optional(),
  /** Credits or money at stake, if any. */
  estimate: z.object({ credits: z.number().int().optional(), usd: z.number().optional() }).optional(),
});
export type Approval = z.infer<typeof Approval>;

export const ConnectionProvider = z.enum([
  "instagram",
  "facebook",
  "youtube",
  "tiktok",
  "linkedin",
  "x",
  "threads",
  "reddit",
  "revenuecat",
  "app_store_connect",
  "google_play_console",
  "google_analytics",
  "gmail",
  "smtp",
]);
export type ConnectionProvider = z.infer<typeof ConnectionProvider>;

/** OAuth/API connection. Tokens live encrypted in the `secrets` store, referenced by `secretId`. */
export const ConnectedAccount = BaseEntity.extend({
  appId: Id.optional(),
  provider: ConnectionProvider,
  purposes: z.array(z.enum(["publishing", "analytics", "outreach"])).min(1),
  externalAccountId: z.string().max(200),
  displayName: z.string().max(200),
  scopes: z.array(z.string().max(200)).default([]),
  status: z.enum(["connected", "expired", "revoked", "pending_review", "error"]),
  /** What the integration can actually do with the granted scopes. */
  capabilities: z.array(z.enum(["publish_video", "publish_image", "publish_text", "read_insights", "read_revenue", "send_message"])).default([]),
  secretId: Id.optional(),
  /** Honest limits of this connection (e.g. "TikTok app not audited: posts are private only"). */
  limitations: z.array(z.string().max(300)).max(10).default([]),
  connectedBy: Actor,
  lastSyncAt: IsoDateTime.optional(),
  lastError: z.string().max(1000).optional(),
});
export type ConnectedAccount = z.infer<typeof ConnectedAccount>;

export const PostStatus = z.enum([
  "draft",
  "awaiting_approval",
  "scheduled",
  "publishing",
  "published",
  "failed",
  "manual_post_needed",
  "manually_posted",
  "cancelled",
]);
export type PostStatus = z.infer<typeof PostStatus>;

/**
 * "Tell Muse what to change" on a post (POST /posts/:id/change): the newest change asked for, as
 * the post remembers it. A video change runs the Studio's AI edit (Muse Spark, scene-scoped, on the
 * editable composition) and then a final render; the post then uses the new render, so its approval
 * starts over. A caption change rewrites the post's copy (Muse Spark) and checks it against the
 * app's facts again. Never part of the approval snapshot (the content it changes is).
 */
export const PostChangePart = z.enum(["video", "caption"]);
export type PostChangePart = z.infer<typeof PostChangePart>;
export const PostChangeStatus = z.enum(["editing", "rendering", "rewriting", "done", "failed"]);
export type PostChangeStatus = z.infer<typeof PostChangeStatus>;
export const PostChange = z.object({
  id: Id,
  part: PostChangePart,
  instruction: z.string().max(2000),
  /** Said out loud (transcribed by Muse Voice Transcribe) rather than typed. */
  spoken: z.boolean().default(false),
  status: PostChangeStatus,
  /** The job running now (the edit, then the render; or the rewrite). */
  jobId: Id,
  editJobId: Id.optional(),
  renderJobId: Id.optional(),
  patchId: Id.optional(),
  fromVersion: z.number().int().optional(),
  toVersion: z.number().int().optional(),
  /** The post was waiting for approval (or approved) when the change was asked: it asks again afterwards. */
  hadApproval: z.boolean().default(false),
  /** One plain line on what changed, e.g. "Muse made the opening shorter (scene 1)". */
  summary: z.string().max(500).optional(),
  /** Why it stopped, in plain words (failed), or what still needs the person (done, approval not requested). */
  note: z.string().max(500).optional(),
  by: Actor,
  startedAt: IsoDateTime,
  finishedAt: IsoDateTime.optional(),
});
export type PostChange = z.infer<typeof PostChange>;

/** POST /posts/:id/change */
export const ChangePostRequest = z.object({ part: PostChangePart, instruction: z.string().trim().min(2).max(2000), spoken: z.boolean().optional() });
export type ChangePostRequest = z.infer<typeof ChangePostRequest>;

/** A change is still running (a new one is refused until it ends). */
export const isPostChangeRunning = (c: Pick<PostChange, "status"> | null | undefined) => Boolean(c && (c.status === "editing" || c.status === "rendering" || c.status === "rewriting"));

export const ScheduledPost = BaseEntity.extend({
  appId: Id,
  campaignId: Id,
  variantId: Id.optional(),
  compositionId: Id.optional(),
  compositionVersion: z.number().int().optional(),
  /**
   * The media, in posting order: one video, one image, or a carousel's slides (Instagram takes at
   * most 10, X 4; the adapter says what it takes). Empty for a text-only post (X, Threads, LinkedIn,
   * Reddit, Facebook): preflight refuses an empty post on a channel that needs media.
   */
  assetIds: z.array(Id).max(20),
  channel: Channel,
  accountId: Id.optional(),
  mode: z.enum(["api", "manual"]),
  title: z.string().max(300).optional(),
  caption: z.string().max(5000),
  tags: z.array(z.string().max(100)).max(50).default([]),
  thumbnailAssetId: Id.optional(),
  trackingLinkId: Id.optional(),
  /** Copy pack the caption/title were taken from. */
  copyPackId: Id.optional(),
  /** Requested audience visibility where the channel supports it. Part of the approved snapshot. */
  visibility: z.enum(["public", "unlisted", "private"]).default("public"),
  /** Disclose AI-generated/synthetic media where the channel supports a label (YouTube, TikTok). */
  containsSyntheticMedia: z.boolean().default(false),
  scheduledAt: IsoDateTime.optional(),
  timezone: z.string().max(64).default("UTC"),
  suggestedTimeReason: z.string().max(500).optional(),
  status: PostStatus,
  approvalId: Id.optional(),
  manualInstructions: z.array(z.string().max(500)).default([]),
  /** Export package job (module C `package.export`) and its ZIP asset for manual posting. */
  exportJobId: Id.optional(),
  packageAssetId: Id.optional(),
  /** In-app reminder for manual posting. */
  reminderAt: IsoDateTime.optional(),
  /** Adapter resume state (upload session / container / publish ids; never tokens). */
  publishState: z.record(z.string(), z.unknown()).optional(),
  publicationId: Id.optional(),
  attempts: z.number().int().nonnegative().default(0),
  lastError: z.string().max(2000).optional(),
  /** The newest fact-check fix for this post (`post.fix_facts` job: "Remove it" / "It's true, add it"). */
  factFixJobId: Id.optional(),
  /** The newest "Tell Muse what to change" request on this post (POST /posts/:id/change). */
  change: PostChange.optional(),
});
export type ScheduledPost = z.infer<typeof ScheduledPost>;

/**
 * GET /posts/:id `factCheck`: whether the post's copy passed the fact check, in plain words, and
 * what the two one-tap fixes would do. Only statements backed by a confirmed fact or the app's own
 * listing/website pass; "It's true, add it" records the person's confirmation as a sourced fact.
 */
export const PostFactCheck = z.object({
  copyPackId: Id,
  ok: z.boolean(),
  checkedAt: IsoDateTime.optional(),
  /** Fact problems only (unsupported statements, figures, prohibited wording); limits stay in preflight. */
  issues: z.array(
    z.object({
      itemId: Id,
      kind: z.enum(["unsupported", "figure", "prohibited"]),
      issue: z.string().max(500),
      quote: z.string().max(300).optional(),
      terms: z.array(z.string().max(80)).default([]),
      statement: z.string().max(500).optional(),
    }),
  ),
  /** e.g. "This post mentions racing and bowling, which aren't in your confirmed facts yet." */
  message: z.string().max(600),
  /** The words in the copy, e.g. "racing, bowling". */
  quotes: z.array(z.string().max(300)).max(6).default([]),
  /** The sentences of the post that say them, e.g. "Arcade, racing, bowling & co-op fun for game night." */
  excerpts: z.array(z.string().max(300)).max(4).default([]),
  /** What "It's true, add it" confirms as facts; empty when it can't be offered (prohibited wording only). */
  statements: z.array(z.string().max(500)).max(3),
  /** The preflight error this replaces in the UI (so it isn't shown twice). */
  preflightError: z.string().max(2000).optional(),
  /** A fix in progress or just finished (job id and which fix). */
  fix: z.object({ jobId: Id, action: z.enum(["remove", "recheck"]), status: z.string().max(40) }).optional(),
});
export type PostFactCheck = z.infer<typeof PostFactCheck>;

/** POST /posts/:id/facts/confirm: the person confirms the statements (defaults to the ones the fact check proposed). */
export const ConfirmPostFactRequest = z.object({ statements: z.array(z.string().trim().min(4).max(500)).min(1).max(3).optional() });
export type ConfirmPostFactRequest = z.infer<typeof ConfirmPostFactRequest>;

/** A real publication record. `mode=api` requires a remote id/receipt; manual requires user confirmation. */
export const Publication = BaseEntity.extend({
  appId: Id,
  campaignId: Id,
  scheduledPostId: Id,
  channel: Channel,
  mode: z.enum(["api", "manual_confirmed"]),
  remoteId: z.string().max(300).optional(),
  remoteUrl: HttpUrl.optional(),
  publishedAt: IsoDateTime,
  receipt: z.record(z.string(), z.unknown()).optional(),
  confirmedBy: Actor.optional(),
});
export type Publication = z.infer<typeof Publication>;

export const ProspectStatus = z.enum(["suggested", "drafted", "awaiting_review", "contacted", "replied", "negotiating", "declined", "successful", "archived"]);

export const OutreachProspect = BaseEntity.extend({
  appId: Id,
  channel: Channel,
  handle: z.string().max(120),
  url: HttpUrl.optional(),
  displayName: z.string().max(160).optional(),
  niche: z.string().max(300),
  relevanceScore: z.number().min(0).max(100),
  relevanceReasons: z.array(z.string().max(400)).max(10).default([]),
  evidence: z.array(SourceRef).min(1),
  /** Only publicly listed contact routes, each with its source; never inferred emails. */
  publicContacts: z
    .array(z.object({ kind: z.enum(["email", "contact_form", "dm", "website", "business_inquiry"]), value: z.string().max(300), source: SourceRef, verified: z.boolean().default(false) }))
    .default([]),
  outreachAngle: z.string().max(1000).optional(),
  status: ProspectStatus.default("suggested"),
  notes: z.string().max(2000).default(""),
  runId: Id.optional(),
});
export type OutreachProspect = z.infer<typeof OutreachProspect>;

export const OutreachDraft = BaseEntity.extend({
  appId: Id,
  prospectId: Id,
  channel: z.enum(["email", "dm", "contact_form", "other"]),
  subject: z.string().max(300).optional(),
  body: z.string().max(8000),
  claimIds: z.array(Id).default([]),
  offer: z.string().max(1000).optional(),
  /** `ai_suggested` offers must be confirmed/edited by the user before approval can be requested. */
  offerSource: z.enum(["user", "ai_suggested"]).optional(),
  /** Recipient: one of the prospect's publicly listed contact routes, with its source. */
  to: z.object({ kind: z.enum(["email", "contact_form", "dm", "website", "business_inquiry"]), value: z.string().max(300), source: SourceRef }).optional(),
  /** Claim validation over subject + body (Spark validator, or deterministic rules when unavailable). */
  validation: z
    .object({
      ok: z.boolean(),
      issues: z.array(z.object({ id: z.string().max(60), issue: z.string().max(500) })).default([]),
      checkedAt: IsoDateTime,
      validator: z.enum(["spark", "rules"]),
    })
    .optional(),
  status: z.enum(["draft", "awaiting_approval", "approved", "sent", "failed", "copied_manual"]),
  approvalId: Id.optional(),
  sentAt: IsoDateTime.optional(),
  sendReceipt: z.record(z.string(), z.unknown()).optional(),
  generatedByRunId: Id.optional(),
});
export type OutreachDraft = z.infer<typeof OutreachDraft>;

/** Placeholder generated copy uses where a link belongs (never an invented URL). */
export const APP_LINK_TOKEN = "[APP_LINK]";

/** Replace the `[APP_LINK]` placeholder with a real (tracked) URL. Text without it is unchanged. */
export function fillAppLink(text: string, url: string | undefined): string {
  return url ? text.split(APP_LINK_TOKEN).join(url) : text;
}
