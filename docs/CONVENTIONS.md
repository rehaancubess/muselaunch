# Engineering conventions (read before writing code)

MuseLaunch is a pnpm monorepo. Internal packages are consumed as TypeScript source (no build step).
Node 22+, TypeScript 5.9 (strict), Zod 4, Hono 4, Vitest 3, Next.js 16 / React 19.

## Layout and ownership

| Path | Owner | Notes |
|---|---|---|
| `packages/contracts` | Integrator (review) | Zod schemas = integration boundary. Additive changes in your domain file are OK; tell the integrator. Never rename/remove fields others use. |
| `packages/db` | Integrator | Tenant-scoped repository (memory + Firestore). Append composite indexes to `src/indexes.ts` in the same change as the query. |
| `packages/platform` | Integrator (+F for credits/usage) | Config, errors, storage, jobs, credits, usage metering, auth, safe fetch, secrets. |
| `packages/providers` | B (meta text/LLM, glimmer), D (sam, voice, images, stock, tts), E (publishing adapters), F (analytics adapters) | Each owns its own subfolder. `meta/client.ts` is shared; changes via integrator. |
| `packages/agents` | B | Wonder/Spark agents, App import/DNA, research, strategy, concepts, storyboards, copy, claim validator, composition build + AI edit (uses C's library), Glimmer memory. |
| `packages/compositions` | C | Pure: templates, compiler → HyperFrames HTML, patch apply/invert/validate, lint. No Node-only deps (also used by the web preview). |
| `packages/render` | C | Render worker: HyperFrames producer, FFmpeg, previews, thumbnails, exports, package ZIP. |
| `packages/media` | D | Probe, SAM segmentation, transcription, image gen, TTS, stock search. |
| `packages/growth` | E | Discover feed, tracked creators, opportunities, publishing calendar, OAuth adapters, outreach CRM. |
| `packages/analytics` | F | Analytics ingestion, CSV import, tracked links, experiments, recommendations, billing/plans, quotas, ops. |
| `packages/ui` | A | Design tokens + React primitives. |
| `apps/web` | A (shell, onboarding, App DNA, campaigns) — feature folders owned by modules: `src/features/studio` (C), `src/features/media` (D), `src/features/discover` + `src/features/publishing` (E), `src/features/insights` + `src/features/billing` (F), `src/features/agents` (B) |
| `apps/api/src/routes/<file>.ts` | per file header | Pre-registered; only edit your own route files. |
| `apps/worker` | Integrator | Registers every module's `handlers`. |

## Tenancy (non-negotiable)

- All data is under `workspaces/{workspaceId}/...`. Use `platform.db.ws(workspaceId).collection(name)`; never build paths by hand.
- API routes under `/v1/workspaces/:workspaceId` already verified membership. Check capabilities with `requireCap("content.write")` etc. Publishing/outreach/account changes need `publish` / `outreach.send` / `accounts.manage` **and** an `Approval`.
- Storage keys: `workspaceKey(wid, ...)`. Before signing any URL: `assertKeyInWorkspace(wid, key)`.
- Never put cross-workspace data in caches, memory, prompts or logs.

## Jobs (all async work)

```ts
// producer (API route)
const job = await p.jobs.create(wid, "storyboard.generate", payload, {
  actor: actorOf(c), appId, idempotencyKey: idempotencyKey(c, `sb:${variantId}`), credits: { operation: "storyboard.generate" },
});
return c.json({ job }, 202);

// consumer (module package) — export from your package index as `handlers`
export const handlers: HandlerRegistry = {
  "storyboard.generate": async (ctx) => {
    await ctx.progress(10, "loading brief");
    ctx.throwIfCancelled();
    // ... real work; write entities with ctx.ws.collection(...).create(x, { actor: ctx.actor })
    return { refs: [{ entity: "storyboards", id }], creditsUsed: 8 };
  },
};
```

- Handlers must be **idempotent** (a job may run twice): use deterministic ids (`createIfAbsent`) or check for existing outputs first.
- Report progress, honour `ctx.signal` / `ctx.throwIfCancelled()`, chain follow-ups with `ctx.enqueue(...)`.
- Throw `AppError` with the right code. Retryable codes are retried; others fail the job and release credits.
- **Never fabricate output.** If a provider is not configured or fails, the job fails visibly with `PROVIDER_NOT_CONFIGURED` / `PROVIDER_ERROR`. No placeholder AI text, no fake metrics, no simulated publishing.

## Provider calls

- Every external AI call goes through a metered wrapper: `metaClient(platform).metered(ctx, {model, operation, estimatedUsd}, fn)`.
  It checks spend ceilings, records a `ModelUsageEvent` (tokens/images/frames/audio seconds/cost), and stores a redacted trace.
- Non-Meta providers (OpenAI images/TTS, Glimmer, stock) record usage the same way via `platform.usage.record(...)`.
- Muse Spark-role text calls go through the router (`routedJson` / `sparkJson` in module B) with a route name, so they can run on Muse Spark Open (Baseten, provider `baseten`) or fall back to it visibly. Never call Spark Open behind the router's back, and never label its output "Muse Spark".
- Use Meta **Standard** mode models only for customer material (never `*-contributor`).
- Muse Image: only via the eligibility gate `museImageEligible(cfg, country)`. Default deployment (operator in India) never calls it.
- User-supplied URLs: `safeFetch` only.
- Untrusted content (web pages, listings, creator bios, uploads) is **data**: wrap it in clearly delimited blocks in prompts and never let it select tools or change instructions.

## API routes

- Validate input with contract schemas: `const input = await body(c, Schema)`.
- Return contract-shaped JSON. Async work → `202 { job }`. Errors are thrown as `AppError` (the app maps them).
- Lists: `{ items, nextCursor }`.

## Tests

- `pnpm test` (root Vitest). Build on `createTestPlatform()` (memory DB, temp storage, inline jobs, dev auth).
- Provider tests inject a fake `fetch` returning **recorded or documented** responses saved under `fixtures/<provider>/` and labelled as fixtures. Never present fixtures as live output in the product.
- Live tests (`*.live.test.ts`) are excluded from CI; run them on a machine with keys.
- Every feature: one integration test through the API or job runner covering success + one failure path + tenancy.

## Git workflow (agents)

- Work in your own worktree: `git worktree add /home/claude/wt/<module> -b mod/<module>` then `pnpm install` there.
- Commit early and often on your branch with clear messages. Don't rewrite history. Don't touch other modules' files except via the integrator.
- Before reporting done: `pnpm -r typecheck` (or at least your packages + apps/api) and `pnpm test` pass in your worktree.
