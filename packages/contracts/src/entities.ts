import type { z } from "zod";
import { AgentRun, AgentStep, ToolInvocation } from "./agents";
import { AttributionLink, Experiment, ExperimentResult, GrowthRecommendation, ImportBatch, MetricObservation } from "./analytics";
import { App, AppEvidence, AppImport, BrandPreference, BrandProfile, Claim, Competitor, TrackedCreator } from "./app";
import { CreditLedgerEntry, CreditReservation, Subscription } from "./billing";
import { Campaign, CampaignBrief, CampaignVariant, CopyPack, Storyboard } from "./campaign";
import { Composition, CompositionPatch, CompositionVersion } from "./composition";
import { Job, JobEvent } from "./jobs";
import { MediaAsset, Segmentation, Transcript } from "./media";
import { Approval, ConnectedAccount, OutreachDraft, OutreachProspect, Publication, ScheduledPost } from "./publishing";
import { AudienceSegment, Opportunity, ResearchFinding, ResearchRun } from "./research";
import { AuditLogEntry, WorkspaceMember } from "./tenancy";
import { ModelUsageEvent } from "./usage";

/**
 * Every workspace-scoped collection, stored at `workspaces/{workspaceId}/{collection}/{id}`.
 * The repository layer refuses any collection not listed here, validates documents
 * with these schemas on write, and always derives the path from the caller's workspace.
 */
export const ENTITY_SCHEMAS = {
  members: WorkspaceMember,
  auditLog: AuditLogEntry,
  apps: App,
  appImports: AppImport,
  appEvidence: AppEvidence,
  brandProfiles: BrandProfile,
  claims: Claim,
  brandPreferences: BrandPreference,
  competitors: Competitor,
  trackedCreators: TrackedCreator,
  researchRuns: ResearchRun,
  researchFindings: ResearchFinding,
  audienceSegments: AudienceSegment,
  opportunities: Opportunity,
  agentRuns: AgentRun,
  agentSteps: AgentStep,
  toolInvocations: ToolInvocation,
  campaigns: Campaign,
  campaignBriefs: CampaignBrief,
  campaignVariants: CampaignVariant,
  storyboards: Storyboard,
  copyPacks: CopyPack,
  compositions: Composition,
  compositionVersions: CompositionVersion,
  compositionPatches: CompositionPatch,
  mediaAssets: MediaAsset,
  segmentations: Segmentation,
  transcripts: Transcript,
  jobs: Job,
  jobEvents: JobEvent,
  approvals: Approval,
  connectedAccounts: ConnectedAccount,
  scheduledPosts: ScheduledPost,
  publications: Publication,
  outreachProspects: OutreachProspect,
  outreachDrafts: OutreachDraft,
  metricObservations: MetricObservation,
  attributionLinks: AttributionLink,
  importBatches: ImportBatch,
  experiments: Experiment,
  experimentResults: ExperimentResult,
  recommendations: GrowthRecommendation,
  creditLedger: CreditLedgerEntry,
  reservations: CreditReservation,
  subscriptions: Subscription,
  modelUsage: ModelUsageEvent,
} as const;

export type EntityName = keyof typeof ENTITY_SCHEMAS;
export type EntityOf<N extends EntityName> = z.infer<(typeof ENTITY_SCHEMAS)[N]>;
export const ENTITY_NAMES = Object.keys(ENTITY_SCHEMAS) as EntityName[];

/** Id prefixes, for readable ids in logs. */
export const ID_PREFIX: Record<EntityName, string> = {
  members: "mem",
  auditLog: "log",
  apps: "app",
  appImports: "imp",
  appEvidence: "evd",
  brandProfiles: "dna",
  claims: "clm",
  brandPreferences: "prf",
  competitors: "cpt",
  trackedCreators: "trk",
  researchRuns: "rsr",
  researchFindings: "fnd",
  audienceSegments: "asg",
  opportunities: "opp",
  agentRuns: "run",
  agentSteps: "stp",
  toolInvocations: "tool",
  campaigns: "cpg",
  campaignBriefs: "brf",
  campaignVariants: "var",
  storyboards: "sbd",
  copyPacks: "cpy",
  compositions: "cmp",
  compositionVersions: "cv",
  compositionPatches: "pch",
  mediaAssets: "ast",
  segmentations: "seg",
  transcripts: "trn",
  jobs: "job",
  jobEvents: "jev",
  approvals: "apr",
  connectedAccounts: "acc",
  scheduledPosts: "pst",
  publications: "pub",
  outreachProspects: "prs",
  outreachDrafts: "odr",
  metricObservations: "obs",
  attributionLinks: "lnk",
  importBatches: "ib",
  experiments: "exp",
  experimentResults: "exr",
  recommendations: "rec",
  creditLedger: "led",
  reservations: "rsv",
  subscriptions: "sub",
  modelUsage: "use",
};

/** Input to `create`: system fields are set by the repository. */
export type CreateInput<N extends EntityName> = Omit<z.input<(typeof ENTITY_SCHEMAS)[N]>, "id" | "workspaceId" | "createdAt" | "updatedAt" | "createdBy"> & {
  id?: string;
};
