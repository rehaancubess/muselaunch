# MuseLaunch implementation plan

Authoritative spec: `MUSELAUNCH_PRODUCT_SPEC.md` (project docs). This file records the decisions
taken to implement it within the hackathon window (submission: 4 Nov 2026, 9:00 PM ET).

## Decisions (agreed with the owner on 27 Oct)

| Area | Decision | Why / note |
|---|---|---|
| Hosting | Google Cloud: Cloud Run (web, api, workers) + Cloud Tasks | Scale-to-zero, cheap; Cloud Tasks gives durable at-least-once jobs with retries. |
| Data | Firestore (Native) via Admin SDK only; deny-all client rules | Replaces Supabase/Postgres from the spec. Tenancy enforced in API + repository (paths derived from workspace id). Credit ledger uses Firestore transactions. |
| Auth | Firebase Auth (email link / Google), ID tokens verified by the API | `dev:` tokens only in local/test. |
| Storage | Firebase Cloud Storage (GCS) with v4 signed URLs; local driver for dev | Keys always `workspaces/{wid}/...`. |
| Queue | Cloud Tasks (prod), HTTP dispatch (local multi-process), inline (tests) | Same worker endpoint `/tasks/execute`. |
| Video | HyperFrames 0.8.x: JSON `CompositionDoc` → allowlisted components → HTML → `@hyperframes/producer` MP4 | Preview with `@hyperframes/player`. |
| Images | OpenAI Images (`gpt-image-2.5-flare`, configurable; `gpt-image-1` was shut down 23 Oct 2026) | Owner is in India: Meta policy bars Muse Image access from India. Muse Image adapter exists behind the eligibility gate and stays off unless organisers confirm otherwise. |
| Glimmer | Dev/demo on the owner's RTX 5090 (llama.cpp/SGLang/Ollama, OpenAI-compatible); production via partner credits (Modal/Baseten) | Memory itself lives in Firestore (`brandPreferences`); Glimmer retrieves/reasons over it. |
| Research | Meta search grounding (Responses API tool) + SSRF-safe fetch of user-provided URLs | Every finding stores source URL + retrieved timestamp. |
| Track | Indie developer track | Demo path first, breadth second. |

## Module ownership (parallel agents)

| Module | Owns | First integration artifact |
|---|---|---|
| A — Experience | `apps/web` shell, landing, auth/onboarding, workspace/app switcher, App DNA screens, campaign list/wizard, settings, `packages/ui` | Register → create workspace → add app → watch import job → review App DNA |
| B — Intelligence | `packages/agents`, `providers/meta` text, Glimmer client | Store URL → App DNA with evidence + claims → Wonder research with citations → 3 distinct concepts → storyboard → composition build → AI scene patch |
| C — Video Studio | `packages/compositions`, `packages/render`, `features/studio` | Storyboard + real screenshots → editable composition → real MP4; patch one scene, others byte-identical; undo/redo |
| D — Multimodal media | `packages/media`, `providers/{sam,voice,images,stock,tts}`, `features/media` | Founder clip → Voice transcript → SAM mask (cached) → cutout layer in exported MP4 |
| E — Growth & distribution | `packages/growth`, Discover feed, trackers, calendar, approvals, OAuth adapters, outreach | Approved campaign → export package / manual posting flow with honest status; Discover feed with sources |
| F — Analytics & platform | `packages/analytics`, billing/plans/quotas, insights, RevenueCat, CSV import, tracked links, experiments, ops | CSV/RevenueCat data → labelled observations → experiment result → next recommendation; cost ledger |
| Integrator | contracts, db, platform, API core, worker, CI, deploy, E2E | One public working service |

## Vertical slice (target: 28–29 Oct)

new user → workspace → add app (store URL) → import + App DNA (Spark, evidence) → confirm claims →
research (Wonder + search grounding, cited) → 3 concepts → storyboard (Spark) → composition (real screenshots) →
render MP4 (HyperFrames) → "make scene 2 punchier" (Spark patch, scene-scoped) → re-render → export package →
CSV results → experiment insight → next experiment (Glimmer memory applied).

## External access blockers (owner actions)

| Item | Status | Fallback in product |
|---|---|---|
| Meta Model API key + $150 hackathon credit | Owner to create | Features show "not connected"; jobs fail with PROVIDER_NOT_CONFIGURED (no fake output) |
| Muse Image | Restricted for India (policy §2.2) | OpenAI Images, labelled; Muse Image hidden/"restricted" |
| Glimmer weights on 5090 | Owner to run Ollama/llama.cpp | Memory still stored and applied via Spark; Glimmer marked not connected |
| Modal/Baseten/Fireworks credits | Claim from hackathon | 5090 for demo |
| GCP project, Firebase, billing | Owner to create | Local mode (memory/local storage) for development |
| OpenAI API key | Owner to create | Image generation unavailable; real screenshots + uploads still work |
| Social publishing OAuth (IG/TikTok/YouTube/X/LinkedIn) | App review needed (days–weeks) | Export package + manual posting checklist; "manually posted" confirmation; never a fake published state |
| RevenueCat | Owner's own account (secret key) | CSV import labelled "imported" |
| App Store Connect / Play Console | Owner keys | CSV import |
| Payments (Stripe/Razorpay) | Not needed for beta | Credits-only beta; adapter stubbed, honestly labelled |

## Checkpoints

- 27–28 Oct: foundation (done), modules A–F backend + core UI, first MP4 from real screenshots.
- 29–30 Oct: full vertical slice integrated; SAM + voice in exported video; Discover with real citations.
- 31 Oct–1 Nov: publishing/export, insights/experiments, credits/plans UI, polish.
- 2–3 Nov: deploy to Cloud Run, outside beta testers, isolation tests, load/cost checks.
- 4 Nov: regression, demo video, submission.
