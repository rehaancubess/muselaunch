import { z } from "zod";
import { BaseEntity, Id, IsoDateTime } from "./common";
import { DEFAULT_SOUND_SETTINGS, WorkspaceSoundSettings } from "./sound";

export const Role = z.enum(["owner", "admin", "editor", "viewer"]);
export type Role = z.infer<typeof Role>;

/** Top-level user profile (`users/{uid}`); not workspace-scoped. */
export const UserProfile = z.object({
  id: Id,
  email: z.email().optional(),
  displayName: z.string().max(120).optional(),
  photoUrl: z.string().max(2048).optional(),
  /** ISO 3166-1 alpha-2, self-declared at onboarding; used for provider eligibility. */
  country: z.string().length(2).optional(),
  defaultWorkspaceId: Id.optional(),
  /** Membership index (maintained alongside `workspaces/{wid}/members/{uid}`). */
  workspaceIds: z.array(Id).max(50).default([]),
  onboardingCompletedAt: IsoDateTime.optional(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type UserProfile = z.infer<typeof UserProfile>;

/**
 * Growth Autopilot defaults for the workspace ("AI does the work unless we say no").
 * Backward compatible: workspaces saved before this existed parse to the defaults (on).
 */
export const WorkspaceAutopilotSettings = z.object({
  /** New apps start a Growth Autopilot run after import, and Creator opens on it. */
  enabled: z.boolean().default(true),
  /** Final renders inside a run's budget go ahead without asking (needs billing.manage to change). */
  autoApproveRenders: z.boolean().default(true),
  /** Optional ceiling (credits) for one automatic run; smaller runs are chosen to fit it. */
  maxCreditsPerRun: z.number().int().positive().max(2000).optional(),
});
export type WorkspaceAutopilotSettings = z.infer<typeof WorkspaceAutopilotSettings>;
export const DEFAULT_AUTOPILOT_SETTINGS: WorkspaceAutopilotSettings = { enabled: true, autoApproveRenders: true };

/** `workspaces/{workspaceId}`. `workspaceId` equals `id`. */
export const Workspace = BaseEntity.extend({
  name: z.string().min(1).max(120),
  slug: z.string().min(1).max(64),
  ownerId: Id,
  planId: z.string().default("free"),
  /** Hard monthly USD ceiling for provider spend attributable to this workspace. */
  spendCeilingUsd: z.number().nonnegative().default(25),
  settings: z
    .object({
      defaultTimezone: z.string().default("UTC"),
      defaultLocale: z.string().default("en"),
      /** Meta Model API data mode. Customer material defaults to Standard; never silently Contributor. */
      metaDataMode: z.enum(["standard"]).default("standard"),
      /** Growth Autopilot is the default for everything; "I'll do it myself" turns it off. */
      autopilot: WorkspaceAutopilotSettings.default({ ...DEFAULT_AUTOPILOT_SETTINGS }),
      /** Video sound defaults: original music + effects on, AI voiceover (external TTS) off. Additive. */
      sound: WorkspaceSoundSettings.default({ ...DEFAULT_SOUND_SETTINGS }),
    })
    .default({ defaultTimezone: "UTC", defaultLocale: "en", metaDataMode: "standard", autopilot: { ...DEFAULT_AUTOPILOT_SETTINGS }, sound: { ...DEFAULT_SOUND_SETTINGS } }),
});
export type Workspace = z.infer<typeof Workspace>;

/** `workspaces/{wid}/members/{uid}`; id = uid. */
export const WorkspaceMember = BaseEntity.extend({
  userId: Id,
  email: z.email().optional(),
  displayName: z.string().max(120).optional(),
  role: Role,
  /** Separate grants required by the spec for external actions. */
  canPublish: z.boolean().default(false),
  canManageAccounts: z.boolean().default(false),
  status: z.enum(["active", "removed"]).default("active"),
});
export type WorkspaceMember = z.infer<typeof WorkspaceMember>;

/** Top-level `invites/{tokenHash}` so a recipient can resolve it without workspace access. */
export const Invite = BaseEntity.extend({
  email: z.email(),
  role: Role.exclude(["owner"]),
  tokenHash: z.string().min(16).max(128),
  status: z.enum(["pending", "accepted", "revoked", "expired"]),
  expiresAt: IsoDateTime,
  acceptedBy: Id.optional(),
  acceptedAt: IsoDateTime.optional(),
});
export type Invite = z.infer<typeof Invite>;

export const AuditLogEntry = BaseEntity.extend({
  action: z.string().max(120),
  target: z.object({ entity: z.string(), id: Id }).optional(),
  data: z.record(z.string(), z.unknown()).optional(),
});
export type AuditLogEntry = z.infer<typeof AuditLogEntry>;
