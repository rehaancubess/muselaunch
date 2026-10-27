import { z } from "zod";
import { BaseEntity, Channel, HttpUrl, Id, IsoDateTime, Percent01, SourceRef } from "./common";

export const ResearchKind = z.enum(["market", "competitors", "audience", "creators", "opportunities", "trends"]);
export type ResearchKind = z.infer<typeof ResearchKind>;

export const ResearchRun = BaseEntity.extend({
  appId: Id,
  kinds: z.array(ResearchKind).min(1),
  status: z.enum(["queued", "running", "succeeded", "partial", "failed", "cancelled"]),
  agentRunId: Id.optional(),
  jobId: Id.optional(),
  inputs: z.object({
    countries: z.array(z.string().length(2)).default([]),
    languages: z.array(z.string()).default([]),
    channels: z.array(Channel).default([]),
    competitorIds: z.array(Id).default([]),
    focus: z.string().max(1000).optional(),
  }),
  summary: z.string().max(4000).optional(),
  findingCount: z.number().int().nonnegative().default(0),
  /** Recurring refresh (only where the user enabled it). */
  refreshEveryDays: z.number().int().positive().optional(),
  startedAt: IsoDateTime.optional(),
  completedAt: IsoDateTime.optional(),
});
export type ResearchRun = z.infer<typeof ResearchRun>;

export const FindingKind = z.enum([
  "trend",
  "audience_conversation",
  "format",
  "hook",
  "competitor_strategy",
  "community",
  "creator",
  "market",
]);

/**
 * A researched statement. `statement` is what the sources say; `interpretation` is the
 * model's reading of what it means for this app (kept separate per spec 4.3).
 */
export const ResearchFinding = BaseEntity.extend({
  appId: Id,
  runId: Id,
  kind: FindingKind,
  statement: z.string().min(1).max(1500),
  interpretation: z.string().max(1500).optional(),
  evidence: z.array(SourceRef).min(1),
  confidence: Percent01,
  /** Number of independent sources agreeing. */
  corroboration: z.number().int().min(1).default(1),
  channels: z.array(Channel).default([]),
  tags: z.array(z.string().max(40)).max(20).default([]),
  observedAt: IsoDateTime,
  /** Dedup key (normalised statement hash). */
  dedupKey: z.string().max(128),
});
export type ResearchFinding = z.infer<typeof ResearchFinding>;

export const AudienceSegment = BaseEntity.extend({
  appId: Id,
  name: z.string().min(1).max(120),
  description: z.string().max(1500),
  painPoints: z.array(z.string().max(300)).default([]),
  motivations: z.array(z.string().max(300)).default([]),
  channels: z.array(Channel).default([]),
  communities: z.array(z.object({ name: z.string().max(160), url: HttpUrl.optional(), channel: Channel })).default([]),
  evidence: z.array(SourceRef).default([]),
  origin: z.enum(["dna", "research", "user"]),
});
export type AudienceSegment = z.infer<typeof AudienceSegment>;

export const ContentType = z.enum([
  "short_video",
  "carousel",
  "static",
  "thread",
  "long_video",
  "community_post",
  "creator_collab",
  "launch",
]);

export const Opportunity = BaseEntity.extend({
  appId: Id,
  title: z.string().min(1).max(200),
  topic: z.string().max(300),
  audience: z.string().max(300),
  whyRelevant: z.string().max(1500),
  proposedAngle: z.string().max(1000),
  confidence: Percent01,
  evidence: z.array(SourceRef).min(1),
  findingIds: z.array(Id).default([]),
  channels: z.array(Channel).default([]),
  contentType: ContentType,
  effort: z.enum(["low", "medium", "high"]),
  geography: z.array(z.string().length(2)).default([]),
  observedAt: IsoDateTime,
  score: z.number().min(0).max(100),
  status: z.enum(["new", "saved", "dismissed", "used"]).default("new"),
  campaignId: Id.optional(),
  runId: Id.optional(),
  /** Follow-up research runs started from Discover ("investigate"). */
  investigationRunIds: z.array(Id).max(20).default([]),
});
export type Opportunity = z.infer<typeof Opportunity>;
