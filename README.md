# MuseLaunch

**Build your app. MuseLaunch helps the world discover it.**

> **Built entirely during the Meta Global AI Developer Hackathon (submissions close 4 Nov 2026).** Every line of
> code, prompt, test and asset in this repository was written during the event; the first commit is
> `0bcc02c` on 27 Oct 2026, and the full history is public. The only outside pieces are open-source
> dependencies (listed in `package.json` files) and the models and APIs named below. The music and sound
> effects in videos are synthesized by our own code, not samples.

**Live:** https://muselaunch-web-264489246542.us-central1.run.app · API health:
https://muselaunch-api-264489246542.us-central1.run.app/health

An AI growth studio for indie app developers: connect your app, and MuseLaunch learns what it does,
researches your market, plans distinct campaigns, produces editable 30–60 s promo videos from your real
app footage, prepares publishing and creator outreach with your approval, measures results, and proposes
the next experiment. Growth Autopilot runs the whole loop by default and asks you before anything is
posted, sent or spent beyond its budget.

## How the Meta models work together

| Model | Runs on | Used for |
|---|---|---|
| Muse Wonder | Meta Model API | Research planning with live web search (every finding cited), growth strategy, Growth Autopilot decisions: audience, hypothesis, which concepts to test (tool use) |
| Muse Spark 1.3 | Meta Model API | App DNA from the listing and screenshots (multimodal); labels every shot of a walkthrough recording by feature and flags personal info; concepts and 30–60 s storyboards that point at the exact UI to zoom into; scene-scoped edits; claim checks; **watches the rendered MP4** and fixes the scenes it finds problems in; insights |
| SAM 3.1 | Meta Model API | Cuts the real app screen out of designed App Store images (no phone-inside-a-phone); locates UI elements for focus zooms; tracks the founder and their phone in footage for object-aware effects |
| Muse Voice Transcribe | Meta Model API | Founder recordings and narration, captions, spoken edits, and checking that an AI voiceover says exactly what the script says |
| Muse Glimmer (open weights) | Self-hosted on our RTX 5090 (Ollama) | Brand memory and the Brand Guardian, which reviews every video against the brand kit, verified claims and grounded features before it renders |
| Muse Spark Open (open weights) | Baseten Model APIs | Post copy and hook/audience variant briefs (`SPARK_OPEN_TASKS`); a visible fallback when the Meta Model API is unavailable |
| Muse Image | — | Not used: Meta's geographic policy restricts it in India, where this was built. Images come from OpenAI, labelled. |

Outside Meta: OpenAI for labelled images and the optional labelled AI voice (Meta has no text-to-speech
model), Pexels / Pixabay / Openverse for licensed stock, HyperFrames + FFmpeg for rendering.

Every agent run shows which model did each step, and usage is metered under the provider that ran it.

- Three tabs: **Discover**, **Creator** (default), **Insights**
- Every research claim cites a real source; every number names its source; nothing is simulated
- Approval gates before publishing, outreach or spend; workspace isolation; metered credits

See `docs/PLAN.md` for architecture decisions and module ownership, `docs/ACCESS.md` for getting
API access, `docs/INTERFACES.md` for module contracts, and `docs/CONVENTIONS.md` before contributing.

## Run it on Windows

### The quick way: double-click scripts

Install Node.js once (`winget install OpenJS.NodeJS.LTS` in PowerShell), then double-click:

| Script | What it does |
|---|---|
| `start-demo.cmd` | The whole product with **no keys**: labelled test answers stand in for the AI; rendering, storage, jobs and credits are real. |
| `start-live.cmd` | The whole product with **real AI**, using the keys in `.env`. Data is in memory. Real calls spend real credits, capped by the spend ceilings in `.env`. Uses real sign-in (Google or email link, through Firebase) when the Firebase web config is in `.env`; `start-live.cmd dev` uses the local test sign-in. |
| `check-keys.cmd` | Checks your setup and makes a few tiny live calls with every key that's set in `.env` (Meta, Baseten, Glimmer). `check-keys.cmd media agents autopilot` runs the deeper checks; `check-keys.cmd pipeline` runs the whole product on a real App Store app (default Magic Pocket) end to end and leaves the MP4s in `fixtures/live/pipeline/`. Results also go to `fixtures/live/last-run.log`. |
| `setup-tools.cmd` | One-time install of FFmpeg (video) and the Google Cloud CLI (deploy) with winget. |
| `setup-youtube.cmd` | Creates the YouTube public-data API key (restricted to YouTube Data API v3) and saves it in `.env` without showing it. |
| `deploy.cmd` | Puts MuseLaunch online on Google Cloud Run (project and region from `.env`). Needs the Google Cloud CLI once (`winget install Google.CloudSDK`); signs you in if needed. Creates the Firestore indexes, secrets, queues and four services. Log: `.data/logs/deploy.log`. |
| `setup-glimmer.cmd` | Downloads Muse Glimmer (about 18 GB) into Ollama on your GPU, connects MuseLaunch to it and runs a live Brand Guardian check. |

Both start scripts open the site at http://localhost:3000. Close their two server windows to stop.

### 1. Prerequisites (one time)

Open **PowerShell** and run:

```powershell
winget install OpenJS.NodeJS.LTS     # Node 22+
winget install Git.Git
winget install Gyan.FFmpeg           # FFmpeg for media + rendering
corepack enable                      # provides pnpm
```

Close and reopen PowerShell, then check: `node -v` (22 or newer), `pnpm -v`, `ffmpeg -version`.

### 2. Install

```powershell
cd D:\muselaunch
copy .env.example .env
pnpm install
pnpm run doctor          # checks Node, FFmpeg, your .env and which providers you can reach
```

### 3. Quick local mode (no Google Cloud needed)

Everything runs in one API process with an in-memory database (data resets on restart). Put these
in `.env`:

```
DB_DRIVER=memory
JOB_DISPATCH=inline
AUTH_MODE=dev
AUTH_DEV_TOKENS=true
NEXT_PUBLIC_AUTH_MODE=dev
STORAGE_DRIVER=local
```

Then, in two terminals:

```powershell
pnpm --filter @muselaunch/api dev     # http://localhost:8080
pnpm --filter @muselaunch/web dev     # http://localhost:3000
```

Add `META_API_KEY` (and `BASETEN_API_KEY`, `OPENAI_API_KEY`, `GLIMMER_BASE_URL`) to `.env` to turn on
the real AI features. Anything without a key shows **Not connected**; nothing is faked.

#### Fixture mode (development and tests only)

To click through the whole product without keys, run the API in fixture mode instead:

```powershell
pnpm dev:fixture                      # API on :8080 with labelled fake model responses
pnpm --filter @muselaunch/web dev     # the web app shows a "Fixture mode" banner
```

Model calls (Muse Spark, Muse Spark Open, Muse Wonder, SAM, Voice, Glimmer) and the App Store lookup
are answered from `fixtures/` and `apps/api/src/fixture-routes/`; rendering, storage, jobs and billing
are real. Post copy and variant briefs run on (fixture) Muse Spark Open, so runs show which steps used
it; start with `FIXTURE_META_RATE_LIMIT=CompositionEdit` to see the visible fallback on AI edits.
Use the sample listing shown in the banner. Fixture mode refuses to start when `NODE_ENV` or
`APP_ENV` is `production`. To add fake responses for a new feature, add a file to
`apps/api/src/fixture-routes/` (the contract and an example are in `_types.ts`).

The end-to-end tests run against fixture mode. They start both servers if they aren't running and
do real HyperFrames renders, so allow 15–40 minutes:

```powershell
pnpm e2e            # both specs
pnpm e2e journey    # paste the sample listing → Go → Growth Autopilot runs → Needs you; founder clip + SAM, hooks, export (e2e-*.png)
pnpm e2e campaign   # "I'll do it myself": the hands-on campaign flow, post, mark as posted (e2e-campaign-*.png)
```

Growth Autopilot is the default: onboarding is one step (paste a link or describe the app → Go). The
workspace is created from your name with a guessed country (both editable in Settings), and the run
starts on its own once the app is imported. Posts, outreach and spending past a run's budget always
wait in "Needs you". "I'll do it myself" (onboarding) or Settings → Growth Autopilot turns it off.

Screenshots go to `docs/screenshots/`. The founder clip in the demo is the synthetic presenter
fixture (`fixtures/render/presenter/`); in fixture mode SAM answers "person"/"phone" with its
silhouettes (`fixtures/media/sam-presenter-*.json`).

It needs Playwright's Chromium (`npx playwright install chromium`); set `RENDER_CHROME_PATH` to a
chrome-headless-shell binary if the renderer can't find one.

### 4. Check the live APIs

```powershell
pnpm smoke:live            # all providers
pnpm smoke:live meta       # Meta text models (Spark, Wonder)
pnpm smoke:live meta media # + SAM 3.1 and Voice Transcribe
pnpm smoke:live baseten    # Muse Spark Open on Baseten (text, streamed JSON, image in)
```

`pnpm smoke:live youtube` checks `YOUTUBE_API_KEY` with one public channel (3 quota units;
`YOUTUBE_SMOKE_CHANNEL=@handle` picks it).

This makes a few tiny real calls and saves redacted parsed results to `fixtures/live/` so we can
match parsers to the real response shapes. Every raw HTTP exchange with Meta/Glimmer/Baseten (request and
response bodies, response headers; no API keys) is also written to `fixtures/live/raw/wire/`
(gitignored).

### 5. Full mode (Firebase)

After the steps in `docs/ACCESS.md` → *Google Cloud & Firebase*:

```
DB_DRIVER=firestore
FIREBASE_PROJECT_ID=your-project-id
GOOGLE_APPLICATION_CREDENTIALS=D:\keys\muselaunch-dev.json   # or: gcloud auth application-default login
JOB_DISPATCH=http
AUTH_MODE=firebase
NEXT_PUBLIC_AUTH_MODE=firebase
NEXT_PUBLIC_FIREBASE_API_KEY=...   (and the other NEXT_PUBLIC_FIREBASE_* values)
```

Deploy the security rules and indexes once:

```powershell
cd infra\firebase
npx firebase-tools login
npx firebase-tools deploy --only firestore:rules,firestore:indexes,storage --project your-project-id
cd ..\..
pnpm dev        # api :8080, worker :8081, web :3000
```

## Repository map

```
apps/web        Next.js app (Discover · Creator · Insights)
apps/api        Hono API (auth, tenancy, routes)
apps/worker     Background job worker (agents, media, render pools)
packages/contracts     Shared Zod schemas: the integration boundary
packages/db            Tenant-scoped repository (Firestore + in-memory)
packages/platform      Config, storage, jobs, credits, metering, auth, safe fetch
packages/providers     Meta / Muse Spark Open (Baseten) / OpenAI / Glimmer / publishing / analytics adapters, text-model router
packages/agents        Wonder + Spark agents, App DNA, research, campaigns, Glimmer memory
packages/compositions  Composition schema ops, templates, HyperFrames compiler
packages/render        HyperFrames render worker, exports
packages/media         SAM, Voice Transcribe, images, stock, TTS
packages/growth        Discover, publishing calendar, approvals, outreach
packages/analytics     Insights, experiments, recommendations, billing, quotas
infra/                 Firebase rules/indexes, Cloud Run deploy
```
