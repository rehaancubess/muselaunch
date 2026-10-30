# Cross-module interfaces (agreed signatures)

Modules code against these before the implementing branch merges. Change only via the integrator.

## @muselaunch/compositions (module C, pure — also used by the web preview)

```ts
export class PatchError extends Error { errors: string[] }
export function validateDoc(doc: unknown): { ok: true; doc: CompositionDoc } | { ok: false; errors: string[] };
/** Apply ops atomically; returns the new doc, touched scene ids and inverse ops. Throws PatchError. */
export function applyPatch(doc: CompositionDoc, ops: PatchOp[]): { doc: CompositionDoc; affectedSceneIds: string[]; inverse: PatchOp[] };
export function lintDoc(doc: CompositionDoc, ctx: { assets: Record<string, MediaAsset> }): { level: "error" | "warning"; sceneId?: string; layerId?: string; message: string }[];
/** Compact, id-annotated description for prompting Spark to produce patches. */
export function describeForLLM(doc: CompositionDoc): string;
export function sceneHash(scene: Scene): string;
export function docHash(doc: CompositionDoc): string;
export const TEMPLATE_CATALOG: Record<TemplateId, { label: string; description: string; purposes: string[]; needs: ("screenshot" | "app_recording" | "founder_cutout" | "image" | "video" | "logo" | "none")[] }>;
export function buildFromStoryboard(input: {
  storyboard: Storyboard; app: App; brand: BrandProfile | null; assets: MediaAsset[]; segmentations?: Segmentation[];
}): CompositionDoc;
/** HTML for HyperFrames (render + preview). `assetUrl` resolves asset ids to URLs/paths. */
export function compileToHtml(doc: CompositionDoc, opts: { assetUrl: (assetId: string) => string; mode: "preview" | "render"; gsapSource: "inline" | string }): { html: string; durationSec: number };
```

## @muselaunch/compositions/store (module C; depends on @muselaunch/db types)

```ts
export async function createComposition(ws: WorkspaceDb, input: { appId: string; campaignId?: string; variantId?: string; storyboardId?: string; title: string; doc: CompositionDoc; derivedFromCompositionId?: string; id?: string }, actor: string): Promise<{ composition: Composition; version: CompositionVersion }>;
/** CONFLICT if baseVersion !== composition.currentVersion. Clears redo stack. */
export async function commitVersion(ws: WorkspaceDb, compositionId: string, input: { baseVersion: number; doc: CompositionDoc; source: CompositionVersion["source"]; summary: string; patchId?: string }, actor: string): Promise<{ composition: Composition; version: CompositionVersion }>;
export async function getVersion(ws: WorkspaceDb, compositionId: string, version?: number): Promise<CompositionVersion>;
export async function undo(ws: WorkspaceDb, compositionId: string, actor: string): Promise<Composition>;
export async function redo(ws: WorkspaceDb, compositionId: string, actor: string): Promise<Composition>;
```

## @muselaunch/agents (module B)

```ts
/** Scoped Glimmer memory retrieval. Falls back to deterministic ranking when Glimmer is not configured (usedGlimmer=false). */
export async function retrieveMemory(p: Platform, input: { workspaceId: string; appId?: string; task: string; query: string; limit?: number; jobId?: string }): Promise<{ items: BrandPreference[]; summary: string; usedGlimmer: boolean }>;
/** Record a preference/lesson (writes BrandPreference; Glimmer may normalise wording). */
export async function rememberPreference(p: Platform, input: { workspaceId: string; appId?: string; kind: PreferenceKind; text: string; source: BrandPreference["source"]; actor: string }): Promise<BrandPreference>;
/** Spark claim validator for any copy (outreach, captions, scene text). */
export async function validateClaims(p: Platform, input: { workspaceId: string; appId: string; texts: { id: string; text: string }[]; jobId?: string }): Promise<{ ok: boolean; issues: { id: string; issue: string }[] }>;
```

Job handlers (module → job types):
- B / agents: app.import, app.analyze, research.run, strategy.run, campaign.generate_concepts, storyboard.generate, composition.edit, copy.generate, memory.ingest
- C / render: composition.build, composition.variants, render.preview, render.final, package.export
- D / media: media.probe, media.segment, media.transcribe, media.image_generate, media.tts
- E / growth: discover.refresh, outreach.draft, outreach.send, publish.post
- F / analytics: analytics.sync (RevenueCat; YouTube per-post stats via the registered `SocialInsightsAdapter`), analytics.import_csv, analytics.youtube_channel (public channel analysis → `youtubeAnalyses` + sourced `researchFindings`), experiment.analyze, recommendations.generate

Pipelines: `campaign.generate_concepts` (B) → user selects → `storyboard.generate` (B) → enqueues `composition.build` (C) → enqueues `render.preview` (C).
AI edit: route `POST /compositions/:id/ai-edit` (C's route file) creates a `CompositionPatch{status:"proposed"}` and job `composition.edit` (B's handler), which fills the patch ops via Spark + `applyPatch` validation and, if `autoApply`, commits via `commitVersion`.

## API surface (route file owner)

- B `app-dna.ts`: `GET /apps/:appId/dna` → `{ profile, evidence, claims, import }`; `POST /apps/:appId/dna/analyze` (202); `PATCH /apps/:appId/dna`; `POST /apps/:appId/dna/confirm`; `POST|PATCH /apps/:appId/claims[/:claimId]`; `GET|POST|DELETE /apps/:appId/competitors[/:id]`; `GET|POST|PATCH|DELETE /apps/:appId/memory[/:id]`.
- B `app-dna.ts` extras: `GET /apps/:appId/claims`; `GET /apps/:appId/competitors/:id`; `GET /apps/:appId/memory/retrieve?task=&query=`; memory list includes `glimmer: {connected, model, label}`.
- B `campaigns.ts`: `GET|POST /apps/:appId/campaigns` (POST → 202 `{campaign, job}`); `GET /campaigns/:campaignId` → `{campaign, brief, variants, storyboards, compositions, copyPacks}`; `POST /campaigns/:id/variants/:variantId/select`; `POST /campaigns/:id/variants/:variantId/produce` (202); `POST /campaigns/:id/copy` (202); `POST /apps/:appId/research` (202); `POST /apps/:appId/strategy` (202); `GET /apps/:appId/agent-runs`; `GET /agent-runs/:runId` → `{run, steps, usage: ModelUsageEvent[], tools}`; `POST /campaigns/:id/variants/:variantId/reject`; `GET /apps/:appId/research`; `GET /research-runs/:runId`; `POST /agent-runs/:runId/approve|reject`.
- C `compositions.ts`: `GET /compositions/:id`; `GET /compositions/:id/versions[/:v]`; `POST /compositions/:id/patch`; `POST /compositions/:id/ai-edit` (202 `{job, patch}`); `GET /compositions/:id/patches/:patchId`; `POST /compositions/:id/patches/:patchId/apply|reject`; `POST /compositions/:id/undo|redo`; `POST /compositions/:id/render` (202); `GET /compositions/:id/preview` → `{ html, durationSec, version }`; `POST /compositions/:id/variants` (202); `POST /campaigns/:campaignId/export` (202).
- D `media.ts`: `POST /assets/:assetId/segment` (202 `{job, segmentation, reused}`, 200 when reused); `GET /assets/:assetId/segmentations`; `GET /segmentations/:id`; `POST /segmentations/:id/correct`; `POST /assets/:assetId/transcribe` (202); `GET /transcripts/:id`; `POST /images/generate` (202, response names the provider); `GET /stock/search`; `POST /stock/import`; `POST /tts` (202).
- E `discover.ts` / `publishing.ts` / `oauth.ts`: feed, opportunities, trackers, prospects, outreach drafts, approvals, calendar/posts, connections, OAuth callbacks.
- F `analytics.ts` / `billing.ts` / `public-links.ts`: insights overview, observations, CSV imports, RevenueCat connection/sync, tracked links, experiments, recommendations, plans, usage summary, admin ops, `/r/:slug`.
- F `analytics.ts` YouTube: `POST /apps/:appId/youtube/analyze` `{channel, relation?, maxVideos?}` → 202 `{job}` (503 `PROVIDER_NOT_CONFIGURED` without `YOUTUBE_API_KEY`, 400 for a link that isn't a channel); `GET /apps/:appId/youtube/analyses` → `{items (summaries), nextCursor, configured}`; `GET /youtube-analyses/:id` → `{analysis}`. `POST /analytics/connections/:id/sync` accepts `{appId}` for workspace-wide YouTube connections.

## Phase 2 (see docs/PHASE2.md)

- D `media.ts`: `POST /assets/:assetId/analyze-clip/estimate` → `{credits, breakdown, available}` (cache-aware); `POST /assets/:assetId/analyze-clip {prompts?: string[] = ["person","phone"], transcribe?: boolean = true}` → 202 `{job, analysis}` (200 `{job: null, analysis}` when reused); `GET /clip-analyses/:id` → `{analysis, segmentations, assets: Record<assetId, {url, kind, role, mimeType}>, tracksUrls: Record<segmentationId, string>, transcript}`; `GET /assets/:assetId/clip-analyses` → `{items}`. Exports: `<ClipAnalyzer assetId onAnalysis?/>` (@/features/media), `loadTracks(p, ws, segmentationId): Promise<TracksFile | null>` (@muselaunch/media).
- C `compositions.ts`: `GET /compositions/:id/clips` → `{items: [{asset, url, posterUrl, usedInDoc, analysis, segmentations: [{id, prompt, status, trackingQuality, hasCutout, hasTracks}]}], tracks: Record<segmentationId, TracksFile (≤10 Hz)>}` (founder clips of the app + clips in the doc); `POST /compositions/:id/ai-edit` accepts `clipAnalysisIds` (≤4, 404 if unknown); `POST /compositions/:id/variants {mode: "hooks", targets: briefs | ["3"]}` → N copies, each with an auto-applied `composition.edit` scoped to the opening scene (job `output.data.hooks: [{compositionId, brief, patchId, jobId}]`); `GET /compositions/:id/preview` adds `posterSec` (paused preview parks there; render posters/export thumbnails use the same frame).
- C `@muselaunch/compositions`: `compileToHtml(doc, {…, tracks?, assetHasAudio?})` (anchors + 6 effect layers), `buildFromStoryboard({…, clipAnalyses?})` (presenter-depth, object-spotlight, product-in-hand), `describeForLLM(doc, {clipAnalyses?})`, `describeClipObjects`, `OBJECT_AWARE_VOCABULARY`, `clipMapping`, `sampleTrack`, `trackUsable`, `trackQuality`, `MIN_TRACK_QUALITY`, `posterTimeSec(doc)`. `@muselaunch/render`: `loadDocMedia`, `lintForRender`, `loadTracksFor`, `hookBriefs`, `DEFAULT_HOOK_BRIEFS`, `variantId`.
- B `autopilot.ts`: `POST /apps/:appId/autopilot` (StartAutopilotRequest), `GET /apps/:appId/autopilots`, `GET /autopilots/:id`, `POST /autopilots/:id/{pause,resume,cancel}`, `POST /autopilots/:id/checkpoint {decision, note}`. Package `@muselaunch/autopilot`: `handlers`, `installAutopilotHooks(p)`, `wakeDueAutopilots(p)`.
- G `guardian.ts`: `POST /reviews {subject, version?, rerun?}` → 202 `{review, job, reused, glimmer}` (200 when reused); `GET /reviews?subjectId=&entity=&appId=&version=` (items flagged `current`); `GET /reviews/:id`; `POST /reviews/:id/findings/:findingId/apply|dismiss`. UI: `<BrandGuardianPanel subject version? onApplied?/>`, `<BrandGuardianBadge/>` (@/features/guardian).
- G services (@muselaunch/agents): `requestBrandReview(p, wid, {subject, version, actor, parentJobId?, idempotencyKey?}) → {review, job, reused}`, `applyFinding(p, wid, {reviewId, findingId, actor})`, `brandGate(...)` used by final render + approval requests (blocked → 409 APPROVAL_REQUIRED `brand_review_blocked`; override `{reason}` audited).
- E: OAuth callback stores a PENDING connection; the signed-in starter completes it with `POST /connections/finish {token}` (uid must match, `accounts.manage`).

## Autopilot by default (B, see packages/autopilot/src/auto.ts, needs-you.ts)

Growth Autopilot is the default for everything; "I'll do it myself" is the explicit opt-out.

- Contracts (backward compatible, Zod defaults): `Workspace.settings.autopilot = { enabled = true, autoApproveRenders = true, maxCreditsPerRun? }` (`WorkspaceAutopilotSettings`, `DEFAULT_AUTOPILOT_SETTINGS`; workspaces saved earlier parse to the defaults). `Autopilot.auto?: { goal, acceptDna }` (run started by MuseLaunch: provisional goal refined from App DNA; App DNA accepted automatically, `confirmedBy: "agent:autopilot:<id>"`). `CreateAppRequest.autopilot?: boolean` (omitted = workspace setting). `CreateAppResponse.autopilot?: AutopilotAutoStart | null`. New: `StartAutoAutopilotRequest`, `AutopilotAutoPlan`, `AutopilotAutoStart`, `NeedsYouItem`, `NeedsYouResponse`.
- `POST /apps` (apps.ts): with something to import and Autopilot wanted, also starts a run → `autopilot: { started, autopilotId?, jobId?, plan?, code?, reason? }` (`code`: insufficient_credits | per_run_limit | no_source | forbidden | already_running | error). The run's `understand` stage waits for the in-flight import/analysis (no second analysis), accepts App DNA, sets the goal ("Get more installs of <App> from <first DNA audience>").
- `GET /apps/:appId/autopilot/auto` → `{ plan: AutopilotAutoPlan, settings }` (any member). Budget = one full iteration (`estimateAutopilot`, renders priced at ≤30 s) + room for the automatic fix rounds; 2 variants, 1 iteration; `autoApproveCredits = min(200, budget)` only when the workspace allows it and the member has billing.manage. `plan.fits=false` → `shortfall {kind: credits|per_run_limit, message}` and `smaller` (fewer variants that fit). A per-run limit picks fewer videos automatically.
- `POST /apps/:appId/autopilot/auto {variants?}` (content.write) → 202 `{ autopilot, job, plan }`; 402 INSUFFICIENT_CREDITS / 400 (per-run limit) with `error.details.plan`; 409 when a run is active. Package: `planAutoStart`, `startAutoAutopilot`, `tryStartAutoAutopilot`, `autopilotSettings`, `defaultGoal`, `dnaJobsInFlight`.
- `GET /needs-you?appId=` → `{ items: NeedsYouItem[], count }` (any member): pending, unexpired approvals that need a person — post publish, outreach send, an autopilot's live spend/continue checkpoint, a strategy run's spend. Each item has `canDecide`, `requiredCap`, `stale`, and `approve`/`reject` `{path, body}` naming the EXISTING decision routes (`/approvals/:id/approve` with the shown `snapshotHash`, `/autopilots/:id/checkpoint/approve|reject`, `/agent-runs/:runId/approve|reject`), which keep their checks (publish / outreach.send / content.approve + billing.manage for spend). Nothing is auto-approved.
- `PATCH /` (workspace.ts) accepts `settings.autopilot {enabled?, autoApproveRenders?, maxCreditsPerRun?: number|null}` (workspace.manage; changing autoApproveRenders or maxCreditsPerRun also needs billing.manage).
- Hook (installAutopilotHooks): with Autopilot on, a succeeded `analytics.sync` / `analytics.import_csv` that wrote observations enqueues `recommendations.generate` (credits reserved as usual, attributed to the importer if they still hold analytics.write; at most once per app per 6 h): `autoRecommendOnNewData`.

## Muse Spark Open + text-model router (@muselaunch/providers; callers in B)

Muse Spark Open is Meta's open-weights Spark model on Baseten Model APIs (`BASETEN_BASE_URL`, OpenAI-compatible Chat Completions, model `SPARK_OPEN_MODEL` = `meta-models/muse-spark-open-1026`). It always reasons; the answer is `content`, reasoning (`reasoning_content`) is private. No JSON mode: JSON is prompted, extracted from the answer, Zod-validated, one repair.

```ts
// spark-open/: metered (provider "baseten", dataMode "third_party"), spend guard, Baseten error mapping
export class SparkOpenClient { configured: boolean; model: string; chat(ctx: CallContext, req: SparkOpenRequest): Promise<SparkOpenResult> }
export function sparkOpenText(p, call: LlmCall & { stream?: boolean }): Promise<SparkOpenTextResult>;           // LlmTextResult & { provider: "baseten", reasoningChars, reasoningSource, … }
export function sparkOpenJson(p, call: LlmCall & { schema, schemaName, stream? }): Promise<SparkOpenTextResult & { data }>;
export function installSparkOpenClient(p, client): void;   // tests / fixture mode

// router.ts
export const TEXT_ROUTES: Record<"copy.generate" | "composition.variant_briefs" | "composition.edit.scoped" | "composition.edit" | "composition.edit.repair" | "claims.validate" | "storyboard.generate" | "concepts.generate", string>;
export function chooseTextModel(p, route: string): TextModelChoice;   // { engine: "muse-spark" | "muse-spark-open", provider, model, name, label, reason }
export function textRouting(p): { sparkOpen: { configured, model, label, tasks, fallback }, routes: Record<TextRoute, engine> };
export function routedJson(p, call: LlmCall & { schema, schemaName }, opts: { route: string; onFallback?: (e: FallbackEvent) => void | Promise<void> }): Promise<LlmTextResult & { data, provider: "meta" | "baseten", fallback?: FallbackEvent }>;
export function routedText(p, call: LlmCall, opts): Promise<LlmTextResult & { provider, fallback? }>;
export function fallbackReason(err): "rate_limited" | "unavailable" | "timeout" | "credits" | null;
```

- Routing: a route runs on Spark Open when it is in `SPARK_OPEN_TASKS` (default `copy.generate,composition.variant_briefs`) and `BASETEN_API_KEY` is set. Wonder calls, web-search calls and Meta file-id inputs never route.
- Fallback (`SPARK_OPEN_FALLBACK`, default on): a Muse Spark call failing with RATE_LIMITED, PROVIDER_UNAVAILABLE, TIMEOUT (after the SDK retry) or a 402/quota/credits error runs once on Spark Open, only when the caller passes `onFallback` (it must record a visible step; no recorder = no fallback). If the fallback fails too, Meta's error code and retry semantics are kept, with `details.fallback`.
- B helpers (`packages/agents/src/models.ts`): `sparkJson(p, rec, route, call)`, `engineName(model)`, `plannedEngine(p, route)`, `fallbackTo(rec)`; `RunRecorder.fallbackStep(e)` writes the decision step. `validateClaims(p, { …, onFallback? })` (additive).
- Contracts (additive): `ProviderId` gains `"baseten"`; `SPARK_OPEN_MODEL`, `SPARK_OPEN_LABEL`, `isSparkOpenModel`, `modelDisplayName(model, {short?})`; `CompositionPatch.model?`, `CompositionPatch.modelNote?`.
- API: `GET /v1/status/providers` adds `textRouting`; the provider list adds `muse-spark-open` (`not_configured` without a key). Web: `useTextEngine(route)` (`apps/web/src/lib/engines.ts`).
- Fixture mode: `installFakeSparkOpen(p, routes)` (@muselaunch/agents/testing) answers Spark Open with the same routes as the fake Meta; `FIXTURE_META_RATE_LIMIT=<schema,…|all>` simulates Meta 429s to show the fallback.

## Spark video review (Track 4: Spark watches its own render)

- Job `video.review` {appId, compositionId, version, renderAssetId, reviewId?} (pool agents, price `video.review` = 6 credits; handler in @muselaunch/agents `review/`). Frames come from the real MP4 (`@muselaunch/render/frames`: first frame, each scene's mid-point, early + late of scenes ≥ 4 s, at most 16, shorter side ≈540 px) and are stored as derived image assets (`role: "preview"`, `sourceLabel: "review_frame"`). Muse Spark (multimodal, `routedJson` route `video.review`, Spark Open fallback only when ≤ 8 frames) reviews them against the rubric; deterministic measurements (reading speed ~3 words/s, flat frames, marketing screenshots inside a device, a screenshot in 3+ scenes) are merged as `source: "measured"`. Template-agnostic: reads scenes/layers (text layers + block text params) from the document.
- Contracts: `VideoReview` (collection `videoReviews`, prefix `vrv`, indexes appId/createdAt and compositionId/createdAt), `VideoReviewFinding {sceneId?, severity: blocker|warn|info, check, issue, fixInstruction, frameRef?, source, measurement?, resolution?}`, `CreateVideoReviewRequest`, `FixVideoReviewRequest`; agent kind `video_review`. A failed review has `status: "failed"`, an `error` and no verdict (never a pass).
- @muselaunch/agents: `requestVideoReview(p, wid, {compositionId, version?, renderAssetId?, rerun?, actor, requestedFrom})`, `renderForVersion(ws, comp, version, assetId?)` (final render of the version, else its preview render; 409 `no_render`), `videoFixPlan(review, doc, {findingIds?, severities?})`, `requestVideoFix(p, wid, {reviewId, findingIds?, actor})` (PROPOSED scene-scoped `composition.edit`, 409 `video_review_stale` when the composition moved on), `markFixRequested`, `videoReviewsFor`.
- API (`routes/video-reviews.ts`): `POST /compositions/:id/video-reviews {version?, renderAssetId?, rerun?}` → 202 `{review, job, reused, engine, credits}` (200 when reused); `GET /compositions/:id/video-reviews?version=` → `{items, current, version, frameUrls: Record<ref, url>, job, render: {assetId, quality} | null, supported, engine: {name, label, configured}, credits}`; `GET /video-reviews/:id` → `{review, job, frameUrls, engine, credits}`; `POST /video-reviews/:id/fix {findingIds?}` → 202 `{review, patch, job}` (content.write).
- Autopilot (`packages/autopilot/src/watch.ts`): after the final renders Spark watches each video (tags `render:watch` → `render:fix` → `render:rerender`, checkpoint `render:rerender:approve` above the auto-approve limit). Blockers tied to a scene get ONE auto-applied scene-scoped fix round per video and iteration, then one re-render through the same Brand Guardian gate; no re-review. Otherwise straight to `schedule`; a failed review is logged as "not counted as a pass". `estimateAutopilot` includes the reviews.
- Web: `VideoReviewPanel`, `useVideoReviews`, `openVideoBlockers` (`src/features/studio/video-review-panel.tsx`), Studio tab "Review"; `PatchCard` is exported from `ai-panel.tsx`.
