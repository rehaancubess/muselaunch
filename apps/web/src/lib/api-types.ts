/**
 * Response envelopes for API routes, composed from contract entity types (never redefined).
 * Shapes follow docs/INTERFACES.md and the implemented route files.
 */
import type {
  AgentRun,
  AgentStep,
  AttributionLink,
  App,
  AppEvidence,
  AppImport,
  BrandPreference,
  BrandProfile,
  Campaign,
  CampaignBrief,
  CampaignVariant,
  Claim,
  Competitor,
  Composition,
  CopyPack,
  CreditBalance,
  CreditLedgerEntry,
  Invite,
  Job,
  JobEvent,
  MediaAsset,
  ModelUsageEvent,
  Plan,
  ResearchFinding,
  ResearchRun,
  Storyboard,
  ToolInvocation,
  UserProfile,
  Workspace,
  WorkspaceMember,
} from "@muselaunch/contracts";

export type Page<T> = { items: T[]; nextCursor?: string | null };

export type MeResponse = { user: UserProfile; workspaces: { workspace: Workspace; member: WorkspaceMember }[] };
export type WorkspaceResponse = { workspace: Workspace; member: WorkspaceMember; credits: CreditBalance };
export type CreateWorkspaceResponse = { workspace: Workspace; member: WorkspaceMember };
export type InviteResponse = { invite: Omit<Invite, "tokenHash"> & { tokenHash?: undefined }; acceptUrl: string; delivery: "copy_link" | "email" };
export type AcceptInviteResponse = { workspaceId: string; member: WorkspaceMember };

export type AppResponse = { app: App };
export type CreateAppResponse = { app: App; job: Job | null };
export type ImportResponse = { job: Job; import: AppImport };

export type JobResponse = { job: Job };
export type JobLogResponse = { items: JobEvent[] };

export type CreditsResponse = { balance: CreditBalance; plan: Plan; ledger: CreditLedgerEntry[]; spend: { monthUsd: number; ceilingUsd: number } };
export type EstimateResponse = { credits: number; breakdown: { label: string; credits: number }[]; available: number };

export type UploadResponse = { asset: MediaAsset; upload: { url: string; method: "PUT" | "POST"; headers: Record<string, string>; expiresAt: string } };
export type AssetResponse = { asset: MediaAsset };
export type CompleteUploadResponse = { asset: MediaAsset; job: Job | null };
export type SignedUrl = { url: string; expiresAt: string };

export type ProviderState = "live" | "not_configured" | "restricted" | "manual_only" | "pending_approval";
export type ProviderStatus = { id: string; label: string; role: string; state: ProviderState; detail: string };
/** Which text engine each route uses on this deployment (providers/router.ts `textRouting`). */
export type TextEngine = "muse-spark" | "muse-spark-open";
export type TextRoutingStatus = { sparkOpen: { configured: boolean; model: string; label: string; tasks: string[]; fallback: boolean }; routes: Record<string, TextEngine> };
export type ProviderStatusResponse = { items: ProviderStatus[]; country: string | null; jobDispatch: string; storage: string; db: string; textRouting?: TextRoutingStatus };

// ---- Module B (App DNA) — INTERFACES.md: GET /apps/:appId/dna → { profile, evidence, claims, import }
export type AppDnaResponse = { profile: BrandProfile | null; evidence: AppEvidence[]; claims: Claim[]; import: AppImport | null };
export type CompetitorsResponse = Page<Competitor>;
export type GlimmerStatus = { connected: boolean; model?: string; label?: string };
export type MemoryResponse = Page<BrandPreference> & { glimmer?: GlimmerStatus };

// ---- Module B (campaigns)
export type CreateCampaignResponse = { campaign: Campaign; job: Job };
export type VariantActionResponse = { variant: CampaignVariant; campaign: Campaign };
export type ConfirmDnaResponse = { profile: BrandProfile; app: App };
export type CampaignDetailResponse = {
  campaign: Campaign;
  brief: CampaignBrief | null;
  variants: CampaignVariant[];
  storyboards: Storyboard[];
  compositions: Composition[];
  copyPacks: CopyPack[];
};
export type AgentRunResponse = { run: AgentRun; steps: AgentStep[]; usage: ModelUsageEvent[]; tools: ToolInvocation[] };
export type ResearchRunResponse = { run: ResearchRun; findings: ResearchFinding[] };
export type CreateResearchResponse = { researchRun: ResearchRun; job: Job };
export type TrackedLinkView = AttributionLink & { publicUrl: string };
export type CreateTrackedLinkResponse = { link: AttributionLink; publicUrl: string };

export type UsagePage = Page<ModelUsageEvent>;
