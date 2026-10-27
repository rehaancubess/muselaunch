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

export const ScheduledPost = BaseEntity.extend({
  appId: Id,
  campaignId: Id,
  variantId: Id.optional(),
  compositionId: Id.optional(),
  compositionVersion: z.number().int().optional(),
  assetIds: z.array(Id).min(1),
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
});
export type ScheduledPost = z.infer<typeof ScheduledPost>;

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
