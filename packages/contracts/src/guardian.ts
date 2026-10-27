import { z } from "zod";
import { BaseEntity, EntityRef, Id, IsoDateTime } from "./common";
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
});
export type BrandFinding = z.infer<typeof BrandFinding>;

export const BrandReview = BaseEntity.extend({
  appId: Id,
  /** compositions (+ version), copyPacks, mediaAssets, outreachDrafts, scheduledPosts */
  subject: EntityRef,
  subjectVersion: z.number().int().min(1).optional(),
  status: z.enum(["queued", "running", "passed", "warnings", "blocked", "failed"]),
  reviewer: z.object({ engine: z.enum(["glimmer", "rules"]), model: z.string().max(80).optional(), label: z.string().max(120).optional() }),
  findings: z.array(BrandFinding).max(100).default([]),
  summary: z.string().max(1500).default(""),
  memoryRefs: z.array(Id).default([]),
  claimIds: z.array(Id).default([]),
  latencyMs: z.number().int().nonnegative().optional(),
  checkedAt: IsoDateTime.optional(),
  jobId: Id.optional(),
  error: z.string().max(1000).optional(),
});
export type BrandReview = z.infer<typeof BrandReview>;
