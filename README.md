# MuseLaunch

**Build your app. MuseLaunch helps the world discover it.**

> **Built entirely during the Meta Global AI Developer Hackathon (submissions close 4 Nov 2026).** Every line of
> code, prompt, test and asset in this repository was written during the event; the first commit is
> `0bcc02c` on 27 Oct 2026, and the full history is public. The only outside pieces are open-source
> dependencies (listed in `package.json` files) and the models and APIs named below. The music and sound
> effects in videos are synthesized by our own code, not samples.

**Status:** Rehaan is testing MuseLaunch on his own apps first and will open it to other indie developers
soon; it isn't open for sign-ups yet. The test deployment runs on Google Cloud Run (web:
https://muselaunch-web-264489246542.us-central1.run.app · API health:
https://muselaunch-api-264489246542.us-central1.run.app/health). To try it yourself, run it locally (below):
the quick start needs no API keys.

An AI growth studio for indie app developers: connect your app, and MuseLaunch learns what it does,
researches your market, plans distinct campaigns, produces editable 30–60 s promo videos from your real
app footage (plus posts, carousels, thumbnails, App Store / Google Play screenshots and text posts),
prepares publishing and creator outreach with your approval, measures results, and proposes the next
experiment. Growth Autopilot runs the whole loop by default and asks you before anything is posted, sent
or spent beyond its budget.

## How the Meta models work together

| Model | Runs on | Used for |
|---|---|---|
| Muse Wonder | Meta Model API | Research planning with live web search (every finding cited), growth strategy, Growth Autopilot decisions: audience, hypothesis, which concepts to test (tool use), and **creative director** of every Autopilot video: hook approach, pacing, visual motif, signature shots and score, which Muse Spark storyboards to (shown on each concept and in the run log) |
| Muse Spark 1.3 | Meta Model API | App DNA from the listing, screenshots and the founder's PDFs (pitch deck, spec, press kit: read natively into cited evidence); labels every shot of a walkthrough recording by feature and flags personal or secret details (names, emails, API keys) on recordings and screenshots so they are blurred; concepts and 30–60 s storyboards that point at the exact UI to zoom into, with a headline typeface per video; slide plans for posts, carousels, thumbnails and store screenshots; scene-scoped edits; claim checks; **watches the rendered MP4** and fixes the scenes it finds problems in (automatically after a new video's first preview, at most two rounds); insights |
| SAM 3.1 | Meta Model API | Cuts the real app screen out of designed App Store images (no phone-inside-a-phone); locates UI elements for focus zooms and tracks them through screen recordings, so close-ups and privacy blurs follow the content as it scrolls; tracks the founder and their phone in footage for object-aware effects |
| Muse Voice Transcribe | Meta Model API | Founder recordings and narration, captions, spoken edits, and checking that an AI voiceover says exactly what the script says |
| Muse Glimmer (open weights) | Self-hosted on our RTX 5090 (Ollama) | Brand memory and the Brand Guardian, which reviews every video against the brand kit, verified claims and grounded features before it renders |
| Muse Spark Open (open weights) | Baseten Model APIs | Post copy and hook/audience variant briefs (`SPARK_OPEN_TASKS`); a visible fallback when the Meta Model API is unavailable |
| Muse Image | — | Not used: Meta's geographic policy restricts it in India, where this was built. Images come from OpenAI, labelled. |

Outside Meta: OpenAI for labelled images and the optional labelled AI voice (Meta has no text-to-speech
model), Pexels / Pixabay / Openverse for licensed stock, HyperFrames + FFmpeg for rendering.

Every agent run shows which model did each step, and usage is metered under the provider that ran it.

- Three tabs: **Home** (what's ready to review, what's coming up, what needs you), **Create** (make a
  video, post, carousel, thumbnail, store screenshots or text post; Discover's research feeds its suggested
  ideas, and every finding is under Discover → See everything) and **Results** (measured numbers, with the
  full Insights under Results → Details)
- Every research claim cites a real source; every number names its source; nothing is simulated
- Approval gates before publishing, outreach or spend; workspace isolation; metered credits

See `docs/PLAN.md` for architecture decisions and module ownership, `docs/ACCESS.md` for getting
API access, `docs/INTERFACES.md` for module contracts, and `docs/CONVENTIONS.md` before contributing.

## Run it

Three ways, from least to most setup:

| | Keys | Data | Start (Windows) | Start (macOS / Linux) |
|---|---|---|---|---|
| [Quick start (fixture mode)](#1-quick-start-no-api-keys-fixture-mode) | none | in memory | `start-demo.cmd` | `pnpm dev:fixture` + `pnpm --filter @muselaunch/web dev` |
| [Local run with real models](#2-local-run-with-real-meta-models) | `META_API_KEY` (others optional) | in memory | `start-live.cmd` | the same two commands with a few env settings |
| [Full mode (Firebase)](#3-full-mode-firebase) | as above + Firebase | Firestore | `pnpm dev` | `pnpm dev` |

Web app: http://localhost:3000 · API: http://localhost:8080 (`/health`) · worker (full mode only): :8081.

### Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Node.js | 22 (`.nvmrc`; `engines` says 22 or newer) | `nvm install` / `nvm use` read `.nvmrc` |
| pnpm | 10.28.0 (`packageManager` in `package.json`) | `corepack enable` provides it |
| FFmpeg | any recent build, on `PATH` (or set `FFMPEG_PATH`) | media processing and rendering; `pnpm run doctor` checks it. The renderer falls back to the bundled `ffmpeg-static` binary when none is on `PATH` |
| Chrome for HyperFrames | — | HyperFrames finds a Chrome by itself (its managed copy or Puppeteer's cache, which Puppeteer's install step normally fills during `pnpm install`). If videos don't render, set `RENDER_CHROME_PATH` to a chrome-headless-shell binary (`npx playwright install chromium` provides one) |
| Git | — | |

**Windows** (PowerShell), or double-click `setup-tools.cmd` for FFmpeg and the Google Cloud CLI:

```powershell
winget install OpenJS.NodeJS.LTS     # Node 22+
winget install Git.Git
winget install Gyan.FFmpeg           # FFmpeg for media + rendering
corepack enable                      # provides pnpm
```

Close and reopen PowerShell, then check: `node -v` (22 or newer), `pnpm -v`, `ffmpeg -version`.

**macOS / Linux:** install Node 22 (e.g. `nvm install` in the repo folder) and FFmpeg (e.g.
`brew install ffmpeg` or `sudo apt install ffmpeg`), then `corepack enable`.

Then, from the repo folder:

```bash
pnpm install
cp .env.example .env     # Windows: copy .env.example .env  (fixture mode doesn't read it)
pnpm run doctor          # checks Node, FFmpeg, your .env and which providers you can reach
```

### 1. Quick start: no API keys (fixture mode)

The whole product with **no keys**: labelled test answers stand in for the AI models (Muse Spark, Muse
Spark Open, Muse Wonder, SAM, Voice, Glimmer) and the App Store lookup; rendering, storage, jobs, credits and
billing are real. The web app shows a persistent **Fixture mode** banner, so nothing can be mistaken for
live AI output. It needs no keys and ignores `.env`.

**Windows:** double-click `start-demo.cmd`. It installs dependencies, then opens two server windows (API
and web). Open http://localhost:3000 after about a minute; close the two windows to stop.

**macOS / Linux:**

```bash
node scripts/windows/web-env.mjs dev   # writes apps/web/.env.local: local test sign-in, API on :8080
pnpm dev:fixture                       # terminal 1: API on :8080 with labelled fixture answers
pnpm --filter @muselaunch/web dev      # terminal 2: web on :3000
```

Sign in with any email (the local test sign-in), then paste the sample listing shown in the banner:
`https://apps.apple.com/us/app/tidy-timer-focus-pomodoro/id1234567890`. A website-only sample with no
screenshots (Autopilot then asks for a screen recording) is `https://tidytimer-web.example.com`.

Fixture-mode options: `FIXTURE_META_DELAY_MS=1500` slows each text-model answer so a run can be watched
step by step; `FIXTURE_META_RATE_LIMIT=CompositionEdit` (schema names, or `all`) makes the fake Meta answer
those calls with its documented 429, to show the visible fallback to Muse Spark Open. Fixture mode refuses
to start when `NODE_ENV` or `APP_ENV` is `production`. To add fake responses for a new feature, add a file to
`apps/api/src/fixture-routes/` (the contract and an example are in `_types.ts`).

Paste a link, get videos: onboarding is one step (paste an App Store / Google Play / website link, or
describe the app → Go) with no other choice. The workspace is created from your name with a guessed
country (both editable in Settings), Autopilot starts with sensible defaults (2 videos, length chosen
per idea, 9:16, original music, the labelled AI voice when OPENAI_API_KEY is set) and you land on the
run's progress screen: plain steps driven by the real jobs, each with its real result, then the first
video to play, download and post. Posts, outreach and spending past a run's budget always wait in
"Needs you". The hands-on tools stay under Creator → Make; Settings → Autopilot turns the automatic
start off.

### 2. Local run with real Meta models

Real model calls, with data kept in memory (it resets when the API stops). Real calls spend real credits,
capped by the spend ceilings in `.env`.

Fill in `.env` (copied from `.env.example` above) with what you have. Anything without a key shows
**Not connected**; nothing is faked.

| Setting in `.env` | Needed? | What it turns on |
|---|---|---|
| `META_API_KEY` | **Required** for real AI | Muse Wonder, Muse Spark 1.3, SAM 3.1 and Muse Voice Transcribe (dev.meta.ai → Dashboard → API keys; see `docs/ACCESS.md`) |
| `BASETEN_API_KEY` | Optional | Muse Spark Open on Baseten: the steps in `SPARK_OPEN_TASKS` and the visible fallback (`SPARK_OPEN_FALLBACK=1`) |
| `OPENAI_API_KEY` | Optional | Labelled generated images and the optional labelled AI voiceover |
| `GLIMMER_BASE_URL`, `GLIMMER_API_KEY`, `GLIMMER_MODEL` | Optional | Self-hosted Muse Glimmer: brand memory and the Brand Guardian ([setup](#4-muse-glimmer-optional-self-hosted)). Without it the Brand Guardian runs a clearly labelled rules-only review |
| `PEXELS_API_KEY`, `PIXABAY_API_KEY` | Optional | Licensed stock footage and images |
| `YOUTUBE_API_KEY` | Optional | YouTube channel analysis in Insights (`setup-youtube.cmd` creates it) |
| `NEXT_PUBLIC_FIREBASE_*`, `FIREBASE_PROJECT_ID` | Optional | Real Google / email-link sign-in instead of the local test sign-in |
| `GLOBAL_DAILY_SPEND_CEILING_USD`, `WORKSPACE_MONTHLY_SPEND_CEILING_USD` | Defaults 40 / 25 | Spend ceilings for real calls |
| `META_STAND_IN=openai` | Optional | Only while no Meta key can be created: runs Muse Wonder / Muse Spark calls on OpenAI (with `OPENAI_API_KEY`), labelled OpenAI everywhere; SAM 3.1 and Voice Transcribe stay off. Ignored once `META_API_KEY` is set |

Check the keys before starting (a few tiny real calls; keys are never printed, results also go to
`fixtures/live/last-run.log`):

| Windows | macOS / Linux | Checks |
|---|---|---|
| `check-keys.cmd` | `pnpm run doctor && pnpm smoke:live keys` | Every key that's set (Meta, Baseten, Glimmer, YouTube) |
| `check-keys.cmd meta` | `pnpm smoke:live meta` | Meta text models (Spark, Wonder) |
| `check-keys.cmd meta media` | `pnpm smoke:live meta media` | + SAM 3.1 and Voice Transcribe |
| `check-keys.cmd baseten` | `pnpm smoke:live baseten` | Muse Spark Open (text, streamed JSON, image in) |
| `check-keys.cmd media agents autopilot` | `pnpm smoke:live media agents autopilot` | The deeper checks |
| `check-keys.cmd pipeline` | `pnpm smoke:live pipeline` | The whole product on a real App Store app (default Magic Pocket) end to end; leaves the MP4s in `fixtures/live/pipeline/` |

`pnpm smoke:live youtube` checks `YOUTUBE_API_KEY` with one public channel (3 quota units;
`YOUTUBE_SMOKE_CHANNEL=@handle` picks it). The smoke checks save redacted parsed results to
`fixtures/live/`, and every raw HTTP exchange with Meta/Glimmer/Baseten (request and response bodies,
response headers; no API keys) to `fixtures/live/raw/wire/` (gitignored).

**Windows:** double-click `start-live.cmd`. It runs `pnpm run doctor`, then starts the API and web with
local single-machine settings that override `.env`. Sign-in is real (Google or email link, through
Firebase) when the Firebase web config is in `.env`; `start-live.cmd dev` forces the local test sign-in.
Open http://localhost:3000; close the two server windows to stop.

**macOS / Linux:** the same settings `start-live.cmd` uses. Either put them in `.env` (replacing the
`.env.example` values for these lines) or pass them on the command line as below; values already in the
environment win over `.env`.

```bash
node scripts/windows/web-env.mjs dev   # the web app reads apps/web/.env.local, not the root .env

# terminal 1: API on :8080
NODE_ENV=development APP_ENV=local DB_DRIVER=memory JOB_DISPATCH=inline STORAGE_DRIVER=local \
AUTH_MODE=dev AUTH_DEV_TOKENS=1 PUBLIC_WEB_URL=http://localhost:3000 API_PUBLIC_URL=http://localhost:8080 \
pnpm --filter @muselaunch/api dev

# terminal 2: web on :3000
pnpm --filter @muselaunch/web dev
```

For real sign-in, put the Firebase web config (`NEXT_PUBLIC_FIREBASE_API_KEY`, `_AUTH_DOMAIN`,
`_PROJECT_ID`, `_APP_ID`) and `FIREBASE_PROJECT_ID` in `.env`, run `node scripts/windows/web-env.mjs`
without `dev` (it prints `firebase` when the config is complete) and start the API with
`AUTH_MODE=firebase` instead of `AUTH_MODE=dev`.

### 3. Full mode (Firebase)

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

On macOS / Linux the commands are the same with `/` paths (`cd infra/firebase`, `cd ../..`). `pnpm dev`
runs the API, the background worker and the web app together; `pnpm dev:backend` runs only the API and
worker. As above, the web app takes its settings from `apps/web/.env.local` (`node scripts/windows/web-env.mjs`
writes it from `.env`).

### 4. Muse Glimmer (optional, self-hosted)

Muse Glimmer runs on your own GPU through Ollama (one-time download of about 18–19 GB). Fixture mode
still answers Glimmer from fixtures; the real Glimmer is used when the API runs with real models.

**Windows:** install Ollama (https://ollama.com/download), then double-click `setup-glimmer.cmd`. It pulls
`muse-glimmer`, creates `muse-glimmer-muselaunch` with a 32k context window from
`scripts/windows/glimmer.Modelfile` (Ollama's default context silently truncates long prompts), loads it on
the GPU, writes the Glimmer lines into `.env` and runs a live Brand Guardian-style check.

**macOS / Linux:** the same steps by hand:

```bash
ollama pull muse-glimmer
ollama create muse-glimmer-muselaunch -f scripts/windows/glimmer.Modelfile
ollama run muse-glimmer-muselaunch "Reply with exactly one word: ready"
```

Add to `.env`:

```
GLIMMER_BASE_URL=http://localhost:11434/v1
GLIMMER_API_KEY=ollama
GLIMMER_MODEL=muse-glimmer-muselaunch
```

Then `pnpm smoke:live glimmer` runs a real Brand Guardian-style review on your GPU (free: it runs
locally). `GLIMMER_LABEL` (default `RTX 5090 (self-hosted)`) is the label the app shows for it.
llama.cpp works too (any OpenAI-compatible endpoint; see `docs/ACCESS.md` §4).

### 5. Phone app

`mobile/` is an Expo app (iPhone + Android) with Home, Create and Results, push notifications and a share
sheet. It is **outside the pnpm workspace** (its own `package.json` and `package-lock.json`); `mobile/README.md`
has the details.

- **Link it:** on the web, Settings → More settings → Phone app → Link your phone shows a QR code and an
  8-character code; scan it or type it in the app.
- **Server:** the app talks to the deployed API by default. For a local server, tap the MuseLaunch logo on
  the Link screen five times and enter the server address (e.g. `http://192.168.1.20:8080` on your Wi-Fi).
- **Build (Windows):** `build-phone-android.cmd` builds an APK on Expo's servers (EAS Build) with a link to
  install it; `build-phone-ios.cmd` builds for iPhone and sends it to TestFlight. Both ask you to log in to
  Expo (and, for iOS, to your Apple Developer account). Android push needs Firebase's `google-services.json`
  (steps in `mobile/README.md`).
- **Build (macOS / Linux):** the scripts run, in `mobile/`: `npm install`, `node scripts/prepare-build.mjs
  android` (or `ios`), then with `EAS_NO_VCS=1` and `EAS_PROJECT_ROOT` set to the `mobile/` folder,
  `npx eas-cli@latest build --platform android --profile preview` (iOS: `--platform ios --profile production`,
  then `npx eas-cli@latest submit --platform ios --profile production --latest`).
- **Develop:** `cd mobile && npm install && npx expo start` (use a development build; Expo Go lacks some
  modules).

### 6. Tests

```bash
pnpm typecheck     # every workspace package (the web app runs next typegen first)
pnpm test          # vitest: every package, the API, the worker and the web helpers; no API keys needed
```

The real HyperFrames render tests are opt-in (they render MP4s and stills and save sample frames to
`fixtures/render/samples/`):

```bash
RUN_RENDER_TESTS=1 RENDER_CHROME_PATH=/path/to/chrome-headless-shell npx vitest run packages/render/src/render.render.test.ts
```

(`stills.render.test.ts` and `sound.render.test.ts` in the same folder work the same way. In PowerShell, set
the variables first: `$env:RUN_RENDER_TESTS="1"`.)

The end-to-end tests (Playwright) run against fixture mode. They start both servers if they aren't
running and do real HyperFrames renders, so allow 15–40 minutes. They need Playwright's Chromium
(`npx playwright install chromium`); set `RENDER_CHROME_PATH` to a chrome-headless-shell binary if the
renderer can't find one.

```bash
pnpm e2e                 # every spec
pnpm e2e journey         # paste the sample listing → Go → the run's progress screen → first videos → Needs you; founder clip + SAM, hooks, export (e2e-*.png)
pnpm e2e campaign        # Autopilot's automatic start off (workspace setting): the hands-on campaign flow, post, mark as posted (e2e-campaign-*.png)
pnpm e2e carousel        # Create → a carousel (slide plans, one image per slide, the slide gallery and Studio) and a text post
pnpm e2e stills-layout   # layout review of the stills and text-post views
```

Screenshots go to `docs/screenshots/`. The founder clip in the demo is the synthetic presenter
fixture (`fixtures/render/presenter/`); in fixture mode SAM answers "person"/"phone" with its
silhouettes (`fixtures/media/sam-presenter-*.json`).

Phone app: `cd mobile && npm install && npx tsc --noEmit && npm test`.

### 7. Deploy

`deploy.cmd` (Windows) or `pnpm deploy:gcp` puts MuseLaunch on Google Cloud Run: it needs the Google Cloud
CLI signed in (`gcloud auth login`), `FIREBASE_PROJECT_ID`, `STORAGE_BUCKET` and the provider keys in
`.env` (region: `DEPLOY_REGION`, default `us-central1`). It creates the Firestore indexes, secrets, queues
and four services (web, api, worker, render), and logs every step to `.data/logs/deploy.log`.
`pnpm deploy:gcp --dry-run` prints the gcloud commands only; `--skip-build` redeploys the last images.
Browser notifications need the Web Push key pair once (`setup-web-push.cmd` or `pnpm setup:web-push`).
The phone app is built separately (above).

### Windows scripts at a glance

Install Node.js once (`winget install OpenJS.NodeJS.LTS` in PowerShell), then double-click:

| Script | What it does |
|---|---|
| `start-demo.cmd` | The whole product with **no keys**: labelled test answers stand in for the AI; rendering, storage, jobs and credits are real. |
| `start-live.cmd` | The whole product with **real AI**, using the keys in `.env`. Data is in memory. Real calls spend real credits, capped by the spend ceilings in `.env`. Uses real sign-in (Google or email link, through Firebase) when the Firebase web config is in `.env`; `start-live.cmd dev` uses the local test sign-in. |
| `check-keys.cmd` | Checks your setup and makes a few tiny live calls with every key that's set in `.env` (Meta, Baseten, Glimmer). `check-keys.cmd media agents autopilot` runs the deeper checks; `check-keys.cmd pipeline` runs the whole product on a real App Store app (default Magic Pocket) end to end and leaves the MP4s in `fixtures/live/pipeline/`. Results also go to `fixtures/live/last-run.log`. |
| `setup-tools.cmd` | One-time install of FFmpeg (video) and the Google Cloud CLI (deploy) with winget. |
| `setup-youtube.cmd` | Creates the YouTube public-data API key (restricted to YouTube Data API v3) and saves it in `.env` without showing it. |
| `setup-web-push.cmd` | Makes the key pair for **browser notifications** (they reach a computer or Android browser even with MuseLaunch closed) and saves it in `.env` without showing the private key. Run it once; `deploy.cmd` sends the private key to Secret Manager (and makes the pair itself if it's missing). Without keys, local runs use a temporary pair and production has browser notifications off. |
| `deploy.cmd` | Puts MuseLaunch online on Google Cloud Run (project and region from `.env`). Needs the Google Cloud CLI once (`winget install Google.CloudSDK`); signs you in if needed. Creates the Firestore indexes, secrets, queues and four services. Log: `.data/logs/deploy.log`. |
| `setup-glimmer.cmd` | Downloads Muse Glimmer (about 18 GB) into Ollama on your GPU, connects MuseLaunch to it and runs a live Brand Guardian check. |
| `build-phone-android.cmd` | Builds the **phone app** (`mobile/`, Expo) for Android on Expo's servers: an APK to install from a link. Asks you to log in to Expo. |
| `build-phone-ios.cmd` | Builds the phone app for iPhone and sends it to **TestFlight**. Asks you to log in to Expo and to your Apple Developer account. Push setup and details: `mobile/README.md`. |

Both start scripts serve the site at http://localhost:3000 (API on :8080). Close their two server windows
to stop.

## Repository map

```
apps/web        Next.js app (Home · Create · Results, plus Discover and Insights details)
apps/api        Hono API (auth, tenancy, routes)
apps/worker     Background job worker (agents, media, render pools)
packages/contracts     Shared Zod schemas: the integration boundary
packages/db            Tenant-scoped repository (Firestore + in-memory)
packages/platform      Config, storage, jobs, credits, metering, auth, safe fetch, push
packages/providers     Meta / Muse Spark Open (Baseten) / OpenAI / Glimmer / publishing / analytics adapters, text-model router
packages/agents        Wonder + Spark agents, App DNA, research, campaigns, slide plans, video review, Glimmer memory
packages/autopilot     Growth Autopilot and the server-side Create runs
packages/compositions  Composition schema ops, templates, HyperFrames compiler
packages/render        HyperFrames render worker, exports
packages/media         SAM, Voice Transcribe, images, stock, TTS, music and sound
packages/growth        Discover, publishing calendar, approvals, outreach
packages/analytics     Insights, experiments, recommendations, billing, quotas
packages/ui            Shared React components for the web app
mobile/                Phone app (Expo; outside the pnpm workspace)
e2e/                   Playwright end-to-end tests (fixture mode)
fixtures/              Labelled fixtures for fixture mode and tests
scripts/               doctor, smoke checks, deploy, Windows helpers
infra/                 Firebase rules/indexes, Dockerfiles, Cloud Build
```
