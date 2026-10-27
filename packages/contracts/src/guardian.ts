import { z } from "zod";
import { Actor, BaseEntity, EntityRef, Id, IsoDateTime } from "./common";
import { PatchOp } from "./composition";

/**
 * Brand Guardian: Muse Glimmer (self-hosted, local) reviews generated assets against the approved
 * brand kit, verified claims and remembered preferences BEFORE render/approval. Durable memory lives
 * in Firestore; Glimmer reasons over the retrieved, workspace-scoped items. Deterministic rules
 * (palette distance, prohibited phrases, unverified numbers) always run too; findings say which
 * engine produced them.
 */
export const BrandFindingCategory = z.enum([
  "tone",
  "claim",
  "prohibited",
  "palette",
  "typography",
  "logo",
  "cta",
  "consistency",
  "accessibility",
  "privacy",
  "platform_fit",
]);
export type BrandFindingCategory = z.infer<typeof BrandFindingCategory>;

/** Subjects the guardian can review (BrandReview.subject.entity). */
export const BrandReviewSubjectEntity = z.enum(["compositions", "copyPacks", "outreachDrafts", "scheduledPosts"]);
export type BrandReviewSubjectEntity = z.infer<typeof BrandReviewSubjectEntity>;

/** What a person did with a finding (dismissals and applied fixes are remembered as preferences). */
export const BrandFindingResolution = z.object({
  state: z.enum(["dismissed", "applied"]),
  by: Actor,
  at: IsoDateTime,
  reason: z.string().max(500).optional(),
  /** Preference recorded from this decision (future reviews adapt to it). */
  preferenceId: Id.optional(),
  /** Applied fixes on compositions: the version the fix produced. */
  resultVersion: z.number().int().min(1).optional(),
});
export type BrandFindingResolution = z.infer<typeof BrandFindingResolution>;

export const BrandFinding = z.object({
  id: z.string().max(40),
  severity: z.enum(["info", "warn", "block"]),
  category: BrandFindingCategory,
  message: z.string().max(600),
  location: z
    .object({ sceneId: Id.optional(), layerId: Id.optional(), copyItemId: z.string().max(40).optional(), field: z.string().max(80).optional() })
    .optional(),
  suggestion: z.string().max(600).optional(),
  /** For compositions: a validated fix the user can apply in one click. */
  suggestedOps: z.array(PatchOp).max(20).optional(),
  evidence: z
    .object({ preferenceIds: z.array(Id).default([]), claimIds: z.array(Id).default([]), guideline: z.string().max(400).optional() })
    .default({ preferenceIds: [], claimIds: [] }),
  source: z.enum(["rules", "glimmer"]),
  /** Deterministic rule id (rules findings), e.g. `claim.unverified_figure`, `palette.off_brand`. */
  rule: z.string().max(60).optional(),
  /** The exact text span / value the finding is about (used for highlighting and for learning). */
  quote: z.string().max(300).optional(),
  /** Stable identity of the issue across versions; dismissals are remembered by this key. */
  key: z.string().max(80).optional(),
  resolution: BrandFindingResolution.optional(),
});
export type BrandFinding = z.infer<typeof BrandFinding>;

/** A human decision to proceed past a `blocked` review (always written to the audit log too). */
export const BrandReviewOverride = z.object({
  at: IsoDateTime,
  by: Actor,
  reason: z.string().max(500),
  action: z.enum(["render_final", "request_approval"]),
  findingIds: z.array(z.string().max(40)).max(100).default([]),
});
export type BrandReviewOverride = z.infer<typeof BrandReviewOverride>;

export const BrandReview = BaseEntity.extend({
  appId: Id,
  /** compositions (+ version), copyPacks, mediaAssets, outreachDrafts, scheduledPosts */
  subject: EntityRef,
  subjectVersion: z.number().int().min(1).optional(),
  /** Hash of the exact content reviewed (composition version hash, or copy/caption/draft content). */
  contentHash: z.string().max(128).optional(),
  status: z.enum(["queued", "running", "passed", "warnings", "blocked", "failed"]),
  reviewer: z.object({
    engine: z.enum(["glimmer", "rules"]),
    model: z.string().max(80).optional(),
    label: z.string().max(120).optional(),
    /** Why Glimmer did not take part (rules-only reviews), shown to the user verbatim. */
    note: z.string().max(300).optional(),
  }),
  findings: z.array(BrandFinding).max(100).default([]),
  summary: z.string().max(1500).default(""),
  memoryRefs: z.array(Id).default([]),
  claimIds: z.array(Id).default([]),
  latencyMs: z.number().int().nonnegative().optional(),
  checkedAt: IsoDateTime.optional(),
  jobId: Id.optional(),
  error: z.string().max(1000).optional(),
  overrides: z.array(BrandReviewOverride).max(50).default([]),
});
export type BrandReview = z.infer<typeof BrandReview>;

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

/** `override` on gated actions (final render, approval requests) when the latest review is blocked. */
export const GuardianOverride = z.object({ reason: z.string().trim().min(3).max(500) });
export type GuardianOverride = z.infer<typeof GuardianOverride>;

export const CreateBrandReviewRequest = z.object({
  subject: z.object({ entity: BrandReviewSubjectEntity, id: Id }),
  /** Compositions only; defaults to the current version. */
  version: z.number().int().min(1).optional(),
  /** Run again even when this exact version/content was already reviewed. */
  rerun: z.boolean().default(false),
});
export type CreateBrandReviewRequest = z.infer<typeof CreateBrandReviewRequest>;

export const DismissBrandFindingRequest = z.object({ reason: z.string().trim().max(500).default("") });

/** Body of `POST /posts/:id/request-approval` and `POST /outreach/drafts/:id/request-approval`. */
export const GuardedApprovalRequest = z.object({ override: GuardianOverride.optional() });
