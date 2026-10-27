import { z } from "zod";
import {
  Actor,
  BaseEntity,
  Channel,
  HexColor,
  HttpUrl,
  Id,
  IsoDateTime,
  Percent01,
  Platform,
  ReviewState,
  SourceRef,
} from "./common";

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export const AppStatus = z.enum(["importing", "draft", "ready", "archived"]);
export const DnaStatus = z.enum(["none", "drafting", "needs_review", "confirmed", "failed"]);

export const App = BaseEntity.extend({
  name: z.string().min(1).max(120),
  tagline: z.string().max(240).optional(),
  platforms: z.array(Platform).default([]),
  storeUrls: z
    .object({ ios: HttpUrl.optional(), android: HttpUrl.optional() })
    .default({}),
  websiteUrl: HttpUrl.optional(),
  category: z.string().max(120).optional(),
  iconAssetId: Id.optional(),
  status: AppStatus.default("draft"),
  dnaStatus: DnaStatus.default("none"),
  /** Current App DNA (BrandProfile id == app id). */
  brandProfileId: Id.optional(),
  /** Target markets, ISO 3166-1 alpha-2. */
  targetCountries: z.array(z.string().length(2)).default([]),
  targetLanguages: z.array(z.string().min(2).max(16)).default(["en"]),
  stage: z.enum(["pre_launch", "launched", "growing", "mature"]).optional(),
  lastImportId: Id.optional(),
});
export type App = z.infer<typeof App>;

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

export const ImportSourceKind = z.enum(["app_store", "google_play", "website", "manual", "upload"]);
export type ImportSourceKind = z.infer<typeof ImportSourceKind>;

/** Normalised public listing metadata. Ratings/reviews are stored only as observed facts with source. */
export const StoreListing = z.object({
  source: z.enum(["app_store", "google_play", "website"]),
  url: HttpUrl,
  fetchedAt: IsoDateTime,
  name: z.string().max(200).optional(),
  subtitle: z.string().max(300).optional(),
  developer: z.string().max(200).optional(),
  description: z.string().max(20_000).optional(),
  category: z.string().max(120).optional(),
  price: z.string().max(60).optional(),
  hasInAppPurchases: z.boolean().optional(),
  iconUrl: HttpUrl.optional(),
  screenshotUrls: z.array(HttpUrl).max(30).default([]),
  /** Observed rating at fetch time; never presented as current without the timestamp. */
  ratingObserved: z.number().min(0).max(5).optional(),
  ratingCountObserved: z.number().int().nonnegative().optional(),
  releaseNotes: z.string().max(5000).optional(),
  lastUpdated: z.string().max(60).optional(),
  contentHash: z.string().max(128).optional(),
});
export type StoreListing = z.infer<typeof StoreListing>;

export const AppImport = BaseEntity.extend({
  appId: Id,
  sources: z
    .array(z.object({ kind: ImportSourceKind, url: HttpUrl.optional() }))
    .min(1),
  status: z.enum(["queued", "fetching", "analyzing", "succeeded", "partial", "failed"]),
  jobId: Id.optional(),
  listings: z.array(StoreListing).default([]),
  /** Media imported from listings (screenshots/icon) as MediaAsset ids. */
  importedAssetIds: z.array(Id).default([]),
  warnings: z.array(z.string().max(500)).default([]),
  error: z.string().max(2000).optional(),
});
export type AppImport = z.infer<typeof AppImport>;

// ---------------------------------------------------------------------------
// Evidence & claims
// ---------------------------------------------------------------------------

export const EvidenceKind = z.enum([
  "feature",
  "pricing",
  "audience",
  "problem",
  "visual",
  "platform",
  "positioning",
  "metric",
  "other",
]);

/** A single extracted fact about the app with its provenance. */
export const AppEvidence = BaseEntity.extend({
  appId: Id,
  kind: EvidenceKind,
  fact: z.string().min(1).max(1000),
  source: SourceRef,
  /** Screenshot / recording that shows it (product truth only, never generated media). */
  assetId: Id.optional(),
  /** Region on the screenshot, normalised 0..1. */
  region: z.object({ x: Percent01, y: Percent01, w: Percent01, h: Percent01 }).optional(),
  observedAt: IsoDateTime,
  reviewState: ReviewState.default("needs_review"),
  extractedByRunId: Id.optional(),
});
export type AppEvidence = z.infer<typeof AppEvidence>;

export const ClaimContext = z.enum(["ads", "social", "outreach", "store", "video", "all"]);

export const ClaimHistoryEntry = z.object({
  at: IsoDateTime,
  by: Actor,
  from: ReviewState.optional(),
  to: ReviewState,
  note: z.string().max(500).optional(),
});

/** ApprovedClaim in the spec: a marketing statement only usable once `verified`. */
export const Claim = BaseEntity.extend({
  appId: Id,
  text: z.string().min(1).max(500),
  evidenceIds: z.array(Id).default([]),
  confidence: Percent01,
  state: ReviewState.default("needs_review"),
  permittedContexts: z.array(ClaimContext).default(["all"]),
  origin: z.enum(["extracted", "user", "agent"]),
  /** True when the claim states something beyond its evidence (always needs human review). */
  speculative: z.boolean().default(false),
  reviewedBy: Actor.optional(),
  reviewedAt: IsoDateTime.optional(),
  history: z.array(ClaimHistoryEntry).default([]),
});
export type Claim = z.infer<typeof Claim>;

// ---------------------------------------------------------------------------
// App DNA / Brand kit (one per app; id === appId)
// ---------------------------------------------------------------------------

const Evidenced = z.object({
  id: Id,
  text: z.string().min(1).max(600),
  evidenceIds: z.array(Id).default([]),
});

export const DnaAudience = z.object({
  id: Id,
  name: z.string().max(120),
  description: z.string().max(1000),
  painPoints: z.array(z.string().max(300)).default([]),
  motivations: z.array(z.string().max(300)).default([]),
  evidenceIds: z.array(Id).default([]),
});

export const DnaFeature = z.object({
  id: Id,
  name: z.string().max(120),
  description: z.string().max(1000),
  evidenceIds: z.array(Id).default([]),
  /** Real screenshots/recordings showing this feature. */
  assetIds: z.array(Id).default([]),
});

export const Monetization = z.object({
  model: z.enum(["free", "freemium", "paid", "subscription", "iap", "ads", "mixed", "unknown"]),
  notes: z.string().max(500).optional(),
  evidenceIds: z.array(Id).default([]),
});

export const BrandVisual = z.object({
  palette: z
    .array(z.object({ hex: HexColor, role: z.enum(["primary", "secondary", "accent", "background", "text", "other"]) }))
    .max(12)
    .default([]),
  headingFont: z.string().max(80).optional(),
  bodyFont: z.string().max(80).optional(),
  styleKeywords: z.array(z.string().max(60)).max(20).default([]),
  logoAssetIds: z.array(Id).default([]),
  sampleAssetIds: z.array(Id).default([]),
});

export const BrandTone = z.object({
  voice: z.array(z.string().max(60)).max(12).default([]),
  vocabularyUse: z.array(z.string().max(80)).max(50).default([]),
  vocabularyAvoid: z.array(z.string().max(80)).max(50).default([]),
});

export const BrandProfile = BaseEntity.extend({
  appId: Id,
  version: z.number().int().min(1),
  status: z.enum(["draft", "confirmed"]),
  oneLiner: z.string().max(240),
  description: z.string().max(4000),
  category: z.string().max(120).optional(),
  platforms: z.array(Platform).default([]),
  audiences: z.array(DnaAudience).default([]),
  problems: z.array(Evidenced).default([]),
  features: z.array(DnaFeature).default([]),
  differentiators: z.array(Evidenced).default([]),
  monetization: Monetization.default({ model: "unknown", evidenceIds: [] }),
  tone: BrandTone.default({ voice: [], vocabularyUse: [], vocabularyAvoid: [] }),
  visual: BrandVisual.default({ palette: [], styleKeywords: [], logoAssetIds: [], sampleAssetIds: [] }),
  preferredCtas: z.array(z.string().max(120)).max(20).default([]),
  prohibitedClaims: z.array(z.string().max(300)).max(50).default([]),
  competitorIds: z.array(Id).default([]),
  guidelines: z.string().max(4000).default(""),
  /** Field paths the user edited; refresh jobs must not overwrite them. */
  userEditedPaths: z.array(z.string().max(120)).default([]),
  generatedByRunId: Id.optional(),
  confirmedBy: Actor.optional(),
  confirmedAt: IsoDateTime.optional(),
});
export type BrandProfile = z.infer<typeof BrandProfile>;

// ---------------------------------------------------------------------------
// Memory (canonical store for Glimmer retrieval)
// ---------------------------------------------------------------------------

export const PreferenceKind = z.enum([
  "style",
  "tone",
  "angle_accepted",
  "angle_rejected",
  "edit_instruction",
  "decision",
  "lesson",
  "constraint",
]);

export const BrandPreference = BaseEntity.extend({
  /** Absent = workspace-wide preference. */
  appId: Id.optional(),
  kind: PreferenceKind,
  text: z.string().min(1).max(1000),
  source: z.object({
    type: z.enum(["user_edit", "approval", "rejection", "experiment", "explicit", "agent"]),
    ref: z.object({ entity: z.string(), id: Id }).optional(),
  }),
  weight: z.number().min(0).max(1).default(0.5),
  tags: z.array(z.string().max(40)).max(20).default([]),
  active: z.boolean().default(true),
  /** Optional embedding for vector retrieval (Firestore vector field when present). */
  embedding: z.array(z.number()).max(4096).optional(),
  embeddingModel: z.string().max(80).optional(),
});
export type BrandPreference = z.infer<typeof BrandPreference>;

// ---------------------------------------------------------------------------
// Competitors & tracked accounts
// ---------------------------------------------------------------------------

export const SocialHandle = z.object({
  channel: Channel,
  handle: z.string().min(1).max(120),
  url: HttpUrl.optional(),
});
export type SocialHandle = z.infer<typeof SocialHandle>;

export const Competitor = BaseEntity.extend({
  appId: Id,
  name: z.string().min(1).max(120),
  storeUrls: z.object({ ios: HttpUrl.optional(), android: HttpUrl.optional() }).default({}),
  websiteUrl: HttpUrl.optional(),
  handles: z.array(SocialHandle).default([]),
  positioning: z.string().max(1000).optional(),
  observedHooks: z.array(z.string().max(300)).default([]),
  observedFormats: z.array(z.string().max(120)).default([]),
  /** Comparison against the user's verified features (never invented competitor metrics). */
  comparison: z.array(z.object({ topic: z.string().max(120), them: z.string().max(400), us: z.string().max(400), evidence: z.array(SourceRef).default([]) })).default([]),
  sources: z.array(SourceRef).default([]),
  origin: z.enum(["user", "research"]),
  lastResearchedAt: IsoDateTime.optional(),
});
export type Competitor = z.infer<typeof Competitor>;

export const TrackedCreator = BaseEntity.extend({
  appId: Id.optional(),
  channel: Channel,
  handle: z.string().min(1).max(120),
  url: HttpUrl.optional(),
  displayName: z.string().max(120).optional(),
  avatarUrl: HttpUrl.optional(),
  kind: z.enum(["competitor", "creator", "inspiration", "community"]),
  competitorId: Id.optional(),
  notes: z.string().max(2000).default(""),
  /** Latest observations gathered from permitted sources. */
  observations: z
    .array(z.object({ text: z.string().max(600), source: SourceRef }))
    .max(50)
    .default([]),
  lastObservedAt: IsoDateTime.optional(),
});
export type TrackedCreator = z.infer<typeof TrackedCreator>;
