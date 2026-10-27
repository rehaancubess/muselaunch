import { z } from "zod";
import { App } from "./app";
import { CreditBalance, CreditLedgerEntry, Plan } from "./billing";
import { CampaignGoal, Deliverable } from "./campaign";
import { AspectRatio, Channel, ErrorInfo, HttpUrl, Id } from "./common";
import { PatchOp } from "./composition";
import { Job } from "./jobs";
import { MediaAsset, MediaRole } from "./media";
import { Role, UserProfile, Workspace, WorkspaceMember } from "./tenancy";

/**
 * HTTP API conventions
 * - Base path: `/v1`. Workspace data lives under `/v1/workspaces/:workspaceId/...`.
 * - Auth: `Authorization: Bearer <Firebase ID token>`.
 * - Errors: non-2xx with `ApiErrorBody`.
 * - Async work returns `202` with `{ job }`; poll `GET .../jobs/:id` or stream `GET .../jobs/:id/events` (SSE).
 * - Mutations that create jobs accept an `Idempotency-Key` header.
 */
export const API_BASE = "/v1";

export const ApiErrorBody = z.object({ error: ErrorInfo });
export type ApiErrorBody = z.infer<typeof ApiErrorBody>;

export const MeResponse = z.object({
  user: UserProfile,
  workspaces: z.array(z.object({ workspace: Workspace, member: WorkspaceMember })),
});
export type MeResponse = z.infer<typeof MeResponse>;

export const UpdateMeRequest = z.object({
  displayName: z.string().max(120).optional(),
  country: z.string().length(2).optional(),
  defaultWorkspaceId: Id.optional(),
  onboardingCompleted: z.boolean().optional(),
});

export const CreateWorkspaceRequest = z.object({ name: z.string().min(1).max(120) });
export const InviteMemberRequest = z.object({ email: z.email(), role: Role.exclude(["owner"]) });
export const UpdateMemberRequest = z.object({ role: Role.exclude(["owner"]).optional(), canPublish: z.boolean().optional(), canManageAccounts: z.boolean().optional() });

export const CreateAppRequest = z.object({
  name: z.string().min(1).max(120).optional(),
  appStoreUrl: HttpUrl.optional(),
  playStoreUrl: HttpUrl.optional(),
  websiteUrl: HttpUrl.optional(),
  /** Manual description when there is no public listing. */
  description: z.string().max(5000).optional(),
  targetCountries: z.array(z.string().length(2)).max(20).optional(),
});
export type CreateAppRequest = z.infer<typeof CreateAppRequest>;
export const CreateAppResponse = z.object({ app: App, job: Job.nullable() });

export const CreateUploadRequest = z.object({
  filename: z.string().min(1).max(260),
  mimeType: z.string().min(1).max(120),
  bytes: z.number().int().positive().max(2 * 1024 * 1024 * 1024),
  role: MediaRole,
  appId: Id.optional(),
  campaignId: Id.optional(),
  /** Required for founder/voice recordings. */
  consent: z.object({ scope: z.string().max(300) }).optional(),
});
export type CreateUploadRequest = z.infer<typeof CreateUploadRequest>;
export const CreateUploadResponse = z.object({
  asset: MediaAsset,
  upload: z.object({ url: z.string(), method: z.enum(["PUT", "POST"]), headers: z.record(z.string(), z.string()), expiresAt: z.string() }),
});
export type CreateUploadResponse = z.infer<typeof CreateUploadResponse>;

export const SignedUrlResponse = z.object({ url: z.string(), expiresAt: z.string() });

export const CreateCampaignRequest = z.object({
  request: z.string().min(1).max(4000),
  goal: CampaignGoal.default("awareness"),
  channels: z.array(Channel).min(1).max(8).default(["instagram", "tiktok"]),
  deliverables: z.array(Deliverable).max(12).optional(),
  opportunityIds: z.array(Id).max(10).default([]),
  conceptCount: z.number().int().min(3).max(6).default(3),
  creditCap: z.number().int().positive().optional(),
});
export type CreateCampaignRequest = z.infer<typeof CreateCampaignRequest>;

export const ProduceVariantRequest = z.object({
  aspectRatio: AspectRatio.default("9:16"),
  targetDurationSec: z.number().positive().max(90).default(15),
});

export const ApplyPatchRequest = z.object({ baseVersion: z.number().int().min(1), ops: z.array(PatchOp).min(1).max(100), summary: z.string().max(500).default("Manual edit") });
export const AiEditRequest = z.object({ baseVersion: z.number().int().min(1), instruction: z.string().min(1).max(2000), sceneIds: z.array(Id).max(30).default([]), autoApply: z.boolean().default(false) });
export const RenderRequest = z.object({ version: z.number().int().min(1).optional(), quality: z.enum(["preview", "final"]).default("preview") });

export const EstimateRequest = z.object({ operation: z.string().max(80), params: z.record(z.string(), z.unknown()).default({}) });
export const EstimateResponse = z.object({ credits: z.number().int().nonnegative(), breakdown: z.array(z.object({ label: z.string(), credits: z.number().int() })), available: z.number().int() });

export const CreditsResponse = z.object({ balance: CreditBalance, plan: Plan, ledger: z.array(CreditLedgerEntry) });

export const JobResponse = z.object({ job: Job });
export type JobResponse = z.infer<typeof JobResponse>;
