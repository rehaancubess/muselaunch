/**
 * The response shapes the phone app reads, copied (only the fields it uses) from the API's shared
 * schemas so the app builds on its own (EAS uploads only mobile/). Sources:
 *   packages/contracts/src/today.ts       TodayPost, TodayResponse
 *   packages/contracts/src/autopilot.ts   NeedsYouItem
 *   packages/contracts/src/publishing.ts  PostChange, PostStatus
 *   packages/contracts/src/devices.ts     DeviceView, DeviceLinkResponse, RedeemDeviceLinkResponse
 *   packages/contracts/src/analytics.ts   InsightsOverview, ResultsSummary, Experiment, …
 *   packages/contracts/src/campaign.ts    Campaign, CampaignVariant, Deliverable
 *   packages/contracts/src/composition.ts Composition
 *   packages/contracts/src/media.ts       MediaAsset
 *   packages/contracts/src/jobs.ts        Job
 *   apps/web/src/lib/api-types.ts         MeResponse, EstimateResponse, UploadResponse, …
 *   apps/web/src/features/publishing/types.ts  CalendarResponse
 *   apps/web/src/features/discover/picks.ts    FeedItem
 * When a contract changes there, change it here too.
 */

export type Channel =
  | "instagram"
  | "facebook"
  | "tiktok"
  | "youtube"
  | "linkedin"
  | "x"
  | "threads"
  | "reddit"
  | "producthunt"
  | "hackernews"
  | "newsletter"
  | "website"
  | "app_store"
  | "google_play"
  | "other";

export type AspectRatio = "9:16" | "1:1" | "16:9" | "4:5";

export type Page<T> = { items: T[]; nextCursor?: string | null };

export interface ApiErrorBody {
  error?: { code?: string; message?: string; userMessage?: string; retryable?: boolean; details?: Record<string, unknown> };
}

// ---- Me, workspaces, apps -------------------------------------------------

export type Role = "owner" | "admin" | "editor" | "viewer";

export interface Workspace {
  id: string;
  name: string;
  settings: { defaultTimezone?: string; sound?: { aiVoiceover?: boolean } };
}

export interface WorkspaceMember {
  userId: string;
  role: Role;
  canPublish?: boolean;
  status?: "active" | "removed";
}

export interface UserProfile {
  id: string;
  email?: string;
  displayName?: string;
  defaultWorkspaceId?: string;
}

export interface MeResponse {
  user: UserProfile;
  workspaces: { workspace: Workspace; member: WorkspaceMember }[];
}

export interface App {
  id: string;
  name: string;
  tagline?: string;
  status: string;
  dnaStatus?: string;
  iconAssetId?: string;
  postTo?: { channels: string[]; manual?: boolean };
  /** The interface colour for this app (from its icon, or chosen on the web); none = monochrome. */
  theme?: { color: string | null; source: "icon" | "custom" };
}

// ---- Phone links (packages/contracts/src/devices.ts) ----------------------

export type DevicePlatform = "ios" | "android" | "web";

export interface DeviceView {
  id: string;
  name: string;
  platform: DevicePlatform;
  createdAt: string;
  lastUsedAt?: string;
  expiresAt: string;
  notifications: { enabled: boolean; registered: boolean };
  current: boolean;
}

export interface RedeemResponse {
  token: string;
  device: DeviceView;
  user: { id: string; email?: string; displayName?: string };
}

// ---- Jobs -----------------------------------------------------------------

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "blocked";

export interface Job {
  id: string;
  type: string;
  status: JobStatus;
  payload: Record<string, unknown>;
  progress?: { pct?: number; stage?: string };
  parentJobId?: string;
  error?: { code?: string; message?: string; userMessage?: string };
  output?: { data?: Record<string, unknown> };
  createdAt: string;
}

// ---- Home (Today) ----------------------------------------------------------

export type PostStatus = "draft" | "awaiting_approval" | "scheduled" | "publishing" | "published" | "failed" | "manual_post_needed" | "manually_posted" | "cancelled";
export type PostChangePart = "video" | "caption";
export type PostChangeStatus = "editing" | "rendering" | "rewriting" | "done" | "failed";

export interface PostChange {
  id: string;
  part: PostChangePart;
  instruction: string;
  spoken?: boolean;
  status: PostChangeStatus;
  jobId: string;
  hadApproval?: boolean;
  summary?: string;
  note?: string;
  startedAt: string;
  finishedAt?: string;
}

export const isPostChangeRunning = (c: Pick<PostChange, "status"> | null | undefined) => Boolean(c && (c.status === "editing" || c.status === "rendering" || c.status === "rewriting"));

export interface NeedsYouItem {
  id: string;
  kind: string;
  action: string;
  appId?: string;
  title: string;
  summary: string;
  createdAt: string;
  requiredCap: string;
  canDecide: boolean;
  stale: boolean;
  approve: { path: string; body: Record<string, unknown> } | null;
  reject: { path: string; body: Record<string, unknown> } | null;
  labels?: { approve: string; reject: string; approved?: string; rejected?: string };
}

export type TimeBasis = "your_youtube" | "your_results" | "suggested";

export interface TodayPost {
  id: string;
  channel: Channel;
  mode: "api" | "manual";
  status: PostStatus;
  title?: string;
  caption: string;
  copyText: string;
  scheduledAt?: string;
  timezone: string;
  timeBasis?: TimeBasis;
  timeReason?: string;
  account: { name: string; status: string } | null;
  manualReason?: string;
  video: { assetId: string; posterAssetId?: string; kind: "video" | "image"; durationSec?: number; width?: number; height?: number } | null;
  compositionId?: string;
  compositionTitle?: string;
  decision: NeedsYouItem | null;
  blocked?: string;
  change: PostChange | null;
  canChange: boolean;
}

export interface TodayResponse {
  appId: string;
  posts: TodayPost[];
  needs: NeedsYouItem[];
  videos: { compositionId: string; title: string; assetId: string; posterAssetId?: string; durationSec?: number; renderedAt: string }[];
}

export interface CalendarItem {
  id: string;
  campaignId: string;
  channel: Channel;
  mode: "api" | "manual";
  status: PostStatus;
  title?: string;
  scheduledAt?: string;
  at?: string;
  thumbnailAssetId?: string;
}

export interface CalendarResponse {
  timezone: string;
  days: Record<string, CalendarItem[]>;
  unscheduled: CalendarItem[];
}

export interface EstimateResponse {
  credits: number;
  breakdown: { label: string; credits: number }[];
  available: number;
}

export interface SignedUrl {
  url: string;
  expiresAt: string;
}

export interface MediaAsset {
  id: string;
  kind: "image" | "video" | "audio" | "document" | string;
  role: string;
  status: string;
  appId?: string;
  campaignId?: string;
  posterAssetId?: string;
  durationSec?: number;
  width?: number;
  height?: number;
  title?: string;
  isProductTruth?: boolean;
  render?: { compositionId: string; version: number; quality: "preview" | "final" } | null;
  createdAt: string;
}

export interface UploadResponse {
  asset: MediaAsset;
  upload: { url: string; method: "PUT" | "POST"; headers: Record<string, string>; expiresAt: string };
}

export interface Transcript {
  id: string;
  status: string;
  text: string;
}

// ---- Create ----------------------------------------------------------------

export type CampaignGoal = "awareness" | "feature_announcement" | string;
export type DeliverableKind = "short_video" | "feature_promo" | string;

export interface Deliverable {
  kind: DeliverableKind;
  channel?: Channel;
  aspectRatio?: AspectRatio;
  durationSec?: number;
  count?: number;
}

export interface Campaign {
  id: string;
  appId: string;
  name: string;
  goal: CampaignGoal;
  status: string;
  request?: string;
  channels: Channel[];
  deliverables: Deliverable[];
  origin?: string;
  createdBy?: string;
  createdAt: string;
}

export interface CampaignVariant {
  id: string;
  title: string;
  status: "proposed" | "selected" | "rejected" | "produced";
  angleType?: string;
  compositionIds?: string[];
}

export interface Composition {
  id: string;
  title: string;
  status: string;
  currentVersion: number;
  variantId?: string;
  lastRender?: { jobId: string; version: number; quality: "preview" | "final"; assetId?: string; at: string };
  createdAt: string;
}

export interface CampaignDetailResponse {
  campaign: Campaign;
  variants: CampaignVariant[];
  compositions: Composition[];
}

// ---- Create runs, carried by the server (packages/contracts/src/create-run.ts) ----

export type CreateRunStage = "idea" | "plan" | "make" | "check" | "finish" | "done";
export type CreateRunStatus = "working" | "waiting" | "needs_you" | "failed" | "stopped" | "done";
export type CreateRunAction = "retry" | "approve_spend" | "override" | "stop";

export interface CreateRunDecision {
  kind: "credits" | "limit" | "fix" | "brand" | "spend" | "permission" | "resume" | "error";
  stepKey: string;
  stage: CreateRunStage;
  message: string;
  at: string;
  credits?: number;
  shown?: number;
  canOverride?: boolean;
}

export interface CreateRunView {
  campaignId: string;
  appId: string;
  request: string;
  name: string;
  kind: "promote" | "feature";
  format: { aspectRatio: AspectRatio; lengthSec?: number; channel?: Channel };
  startedBy: string;
  createdAt: string;
  stage: CreateRunStage;
  status: CreateRunStatus;
  pct: number;
  detail?: string;
  ideaTitle?: string;
  ideaCount: number;
  compositionId?: string;
  decision: CreateRunDecision | null;
  failure: { stage: CreateRunStage; message: string; jobId?: string; canRetry: boolean } | null;
  wait: { until?: string; reason: string } | null;
  video: { assetId: string; posterAssetId?: string; durationSec?: number } | null;
  actions: CreateRunAction[];
}

export interface DnaFeature {
  id: string;
  name: string;
  description: string;
}

export interface AppDnaResponse {
  profile: { oneLiner?: string; features: DnaFeature[] } | null;
}

export interface CreditsResponse {
  balance: { available: number };
  plan: { name?: string; limits: { maxVideoSec: number } };
}

export interface SourceRef {
  url?: string;
  title?: string;
  publisher?: string;
  kind?: string;
}

export interface FeedItem {
  id: string;
  type: "opportunity" | "finding" | "tracker_update";
  refId: string;
  title: string;
  summary: string;
  interpretation?: string;
  proposedAngle?: string;
  sources: SourceRef[];
  retrievedAt: string;
  status?: "new" | "saved" | "dismissed" | "used";
  campaignId?: string;
}

export interface FeedResponse {
  items: FeedItem[];
}

// ---- Results ---------------------------------------------------------------

export type AttributionLevel = "platform_reported" | "link" | "direct" | "aggregate" | "none";

export interface MetricSourceValue {
  source: string;
  label: string;
  imported: boolean;
  observationCount: number;
}

export interface InsightMetric {
  metric: string;
  label: string;
  value: number | null;
  byCurrency?: { currency: string; value: number }[];
  sources: MetricSourceValue[];
  attribution: AttributionLevel | null;
  coverage: { daysWithData: number; daysInRange: number } | null;
}

export interface MissingMetric {
  metric: string;
  label: string;
  reason: string;
  action: string;
}

export interface InsightsOverview {
  appId: string;
  metrics: InsightMetric[];
  missing: MissingMetric[];
}

export interface ResultsSeries {
  metric: "views" | "clicks";
  label: string;
  points: { date: string; value: number | null }[];
  measuredDays: number;
  sources: MetricSourceValue[];
  multiDayLeftOut: number;
}

export interface ResultsBestPost {
  publicationId: string;
  scheduledPostId: string;
  channel: Channel;
  title: string;
  thumbnailAssetId?: string;
  remoteUrl?: string;
  metric: "views" | "clicks";
  value: number;
  sources: MetricSourceValue[];
  comparedPosts: number;
  tiedWith: number;
}

export interface ResultsSummary {
  appId: string;
  series: ResultsSeries | null;
  postsPublished: { value: number; api: number; manual: number };
  bestPost: ResultsBestPost | null;
}

export interface Experiment {
  id: string;
  title: string;
  primaryMetric: string;
  status: string;
  lastResultId?: string;
  updatedAt: string;
  variants: { key: string; label: string; publicationIds: string[] }[];
}

export interface ExperimentResult {
  id: string;
  confidence: "insufficient_data" | "low" | "medium" | "high";
  measured: { text: string; observationIds: string[] }[];
  perVariant: { key: string; metrics: { metric: string; value: number | null }[] }[];
}

export interface GrowthRecommendation {
  id: string;
  title: string;
  rationale: string;
  status: "new" | "accepted" | "dismissed" | "done";
  confidence: "low" | "medium" | "high";
  basedOn: { observationIds: string[]; resultIds: string[] };
  proposedExperiment?: { variants: string[] };
}
