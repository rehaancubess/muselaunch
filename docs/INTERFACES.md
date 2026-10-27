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
- F / analytics: analytics.sync, analytics.import_csv, experiment.analyze, recommendations.generate

Pipelines: `campaign.generate_concepts` (B) → user selects → `storyboard.generate` (B) → enqueues `composition.build` (C) → enqueues `render.preview` (C).
AI edit: route `POST /compositions/:id/ai-edit` (C's route file) creates a `CompositionPatch{status:"proposed"}` and job `composition.edit` (B's handler), which fills the patch ops via Spark + `applyPatch` validation and, if `autoApply`, commits via `commitVersion`.

## API surface (route file owner)

- B `app-dna.ts`: `GET /apps/:appId/dna` → `{ profile, evidence, claims, import }`; `POST /apps/:appId/dna/analyze` (202); `PATCH /apps/:appId/dna`; `POST /apps/:appId/dna/confirm`; `POST|PATCH /apps/:appId/claims[/:claimId]`; `GET|POST|DELETE /apps/:appId/competitors[/:id]`; `GET|POST|PATCH|DELETE /apps/:appId/memory[/:id]`.
- B `campaigns.ts`: `GET|POST /apps/:appId/campaigns` (POST → 202 `{campaign, job}`); `GET /campaigns/:campaignId` → `{campaign, brief, variants, storyboards, compositions, copyPacks}`; `POST /campaigns/:id/variants/:variantId/select`; `POST /campaigns/:id/variants/:variantId/produce` (202); `POST /campaigns/:id/copy` (202); `POST /apps/:appId/research` (202); `POST /apps/:appId/strategy` (202); `GET /apps/:appId/agent-runs`; `GET /agent-runs/:runId` → `{run, steps, usage}`.
- C `compositions.ts`: `GET /compositions/:id`; `GET /compositions/:id/versions[/:v]`; `POST /compositions/:id/patch`; `POST /compositions/:id/ai-edit` (202 `{job, patch}`); `GET /compositions/:id/patches/:patchId`; `POST /compositions/:id/patches/:patchId/apply|reject`; `POST /compositions/:id/undo|redo`; `POST /compositions/:id/render` (202); `GET /compositions/:id/preview` → `{ html, durationSec, version }`; `POST /compositions/:id/variants` (202); `POST /campaigns/:campaignId/export` (202).
- D `media.ts`: `POST /assets/:assetId/segment` (202 `{job, segmentation}`); `GET /segmentations/:id`; `POST /segmentations/:id/correct`; `POST /assets/:assetId/transcribe` (202); `GET /transcripts/:id`; `POST /images/generate` (202, response names the provider); `GET /stock/search`; `POST /stock/import`; `POST /tts` (202).
- E `discover.ts` / `publishing.ts` / `oauth.ts`: feed, opportunities, trackers, prospects, outreach drafts, approvals, calendar/posts, connections, OAuth callbacks.
- F `analytics.ts` / `billing.ts` / `public-links.ts`: insights overview, observations, CSV imports, RevenueCat connection/sync, tracked links, experiments, recommendations, plans, usage summary, admin ops, `/r/:slug`.
