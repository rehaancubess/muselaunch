# Phase 2: three unmistakable differentiators

Owner direction (27 Oct). MuseLaunch wins by creating *better marketing because it understands the
app*, not by generating more ads. Make three technical differentiators impossible to miss, and show
how the models work together. Never claim a model we can't legitimately demonstrate (Muse Image is
restricted for India; Muse Code is a development tool, not a product feature).

## 1. Object-aware video editing (Spark + SAM 3.1 + HyperFrames)

A developer records themselves holding a phone and demoing the app. SAM identifies and **tracks the
person, the phone and other relevant objects**; HyperFrames uses those masks and tracks to:
- layer the app demo and motion graphics **behind** the presenter (depth sandwich),
- **highlight the phone** (spotlight / outline glow / focus blur) as it moves,
- place callouts and labels **anchored to real objects** so they follow them,
- put the real app recording **onto the phone in hand** (screen insert, clipped by the phone matte).

Spark decides which effects support the message (effects director); SAM provides precise spatial
information; HyperFrames renders. Contracts: `ObjectAnchor` on any layer, `EffectLayer`,
`Segmentation.tracksAssetId/objectOutputs`, `TracksFile/ObjectTrack`, `ClipAnalysis`, job
`media.analyze_clip`, templates `presenter-depth`, `object-spotlight`, `product-in-hand`,
`composition.edit.clipAnalysisIds`, `composition.variants.mode = "hooks"`.

## 2. Muse Glimmer as the local Brand Guardian

Not a database: Firestore holds durable memory; Glimmer **reasons** over retrieved, workspace-scoped
memory. Running locally/self-hosted, it reviews generated assets (composition versions, copy packs,
outreach drafts, scheduled posts) against the approved brand kit, verified claims and remembered
preferences; detects inconsistent or unsupported claims, tone drift, prohibited phrases, CTA/platform
fit; and gives low-latency, one-click suggestions (validated `suggestedOps` for compositions).
Deterministic rules always run as well; each finding says which engine produced it. Runs before
final render and before approval requests. Contracts: `BrandReview`, `BrandFinding`, job `brand.review`.
Show the contrast: cloud agents (Wonder/Spark) create; the local guardian checks, privately and fast.

## 3. A real, bounded autonomous marketing loop (Growth Autopilot)

Not "a huge JSON plan". Muse Wonder actually: uses research tools → selects an audience (citing
findings) → formulates a testable hypothesis (creates an Experiment) → delegates creation (concepts,
storyboards, compositions via existing jobs) → **verifies the outputs** (lint, claim validation,
Brand Guardian; requests fixes via scene edits) → checkpoint → renders → drafts the calendar (every
post still needs human approval) → measures real results → analyses → recommends and starts the next
iteration with lessons stored in memory. Bounded: credit budget, iteration cap, per-step
auto-approve threshold, full decision log with citations. Contracts: `Autopilot`, `AutopilotStage`,
job `autopilot.step`, `StartAutopilotRequest`.

## The demo sequence we are building toward

1. Sign up, import a real app. App DNA from the real listing + screenshots (Spark).
2. Start Growth Autopilot with a goal. Wonder researches three possible audiences with citations,
   picks one with rationale, writes a hypothesis, and recommends distinct campaigns.
3. Complete videos are generated from the real app recordings (HyperFrames).
4. The developer uploads a clip of themselves presenting the app and says (voice → Muse Voice
   Transcribe): *"Make this look like a professional Apple product commercial. Put the app
   demonstration behind me, emphasise the search feature, and create three different hooks."*
5. MuseLaunch analyses the clip (SAM tracks person + phone), Spark directs object-aware effects,
   edits the actual scenes, and produces **three hook variants**; HyperFrames renders exportable MP4s.
6. Brand Guardian (Glimmer, local) reviews each variant and flags/fixes issues before approval.
7. The agent prepares a campaign calendar (approval-gated), and later uses real (or clearly labelled
   imported) performance data to recommend what to test next, remembering what it learned.

## Ownership (phase 2)

| Work | Owner |
|---|---|
| `media.analyze_clip`, multi-object SAM tracks, per-object cutouts/mattes, clip analysis API + UI | D (media) |
| Compiler support for anchors + effect layers, new templates, hooks variants, Studio UI for effects/anchors/clip panel, real object-aware render test | C (video) |
| Growth Autopilot (`autopilot.step`, routes, UI), effects direction in `composition.edit` with clip context | B (intelligence) |
| Brand Guardian (`brand.review`, Glimmer reasoning + rules, routes, Studio/approval integration, UI panel) | G (guardian) |
| UI integration across modules, fixture mode, journey E2E, landing copy honesty | A (experience) |
| Security & isolation review | Reviewer |
