# MuseLaunch

**Build your app. MuseLaunch helps the world discover it.**

An AI growth studio for indie app developers: connect your app, and MuseLaunch learns what it does,
researches your market, plans distinct campaigns, produces editable promo videos from your real app
footage, prepares publishing and creator outreach with your approval, measures results, and proposes
the next experiment. Built on Meta's models (Muse Wonder, Muse Spark 1.3, SAM 3.1, Muse Voice
Transcribe, self-hosted Muse Glimmer) with HyperFrames for rendering.

- Three tabs: **Discover**, **Creator** (default), **Insights**
- Every research claim cites a real source; every number names its source; nothing is simulated
- Approval gates before publishing, outreach or spend; workspace isolation; metered credits

See `docs/PLAN.md` for architecture decisions and module ownership, `docs/ACCESS.md` for getting
API access, and `docs/CONVENTIONS.md` before contributing.

## Run it on Windows

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
pnpm doctor          # checks Node, FFmpeg, your .env and which providers you can reach
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

Add `META_API_KEY` (and `OPENAI_API_KEY`, `GLIMMER_BASE_URL`) to `.env` to turn on the real AI
features. Anything without a key shows **Not connected**; nothing is faked.

#### Fixture mode (development and tests only)

To click through the whole product without keys, run the API in fixture mode instead:

```powershell
pnpm dev:fixture                      # API on :8080 with labelled fake model responses
pnpm --filter @muselaunch/web dev     # the web app shows a "Fixture mode" banner
```

Model calls (Muse Spark, Muse Wonder, SAM, Voice, Glimmer) and the App Store lookup are answered
from `fixtures/` and `apps/api/src/fixture-routes/`; rendering, storage, jobs and billing are real.
Use the sample listing shown in the banner. Fixture mode refuses to start when `NODE_ENV` or
`APP_ENV` is `production`. To add fake responses for a new feature, add a file to
`apps/api/src/fixture-routes/` (the contract and an example are in `_types.ts`).

The end-to-end journey test runs against fixture mode (it starts both servers if they aren't
running, and does a real HyperFrames render, so allow about 10–20 minutes):

```powershell
pnpm e2e        # screenshots go to docs/screenshots/e2e-*.png
```

It needs Playwright's Chromium (`npx playwright install chromium`); set `RENDER_CHROME_PATH` to a
chrome-headless-shell binary if the renderer can't find one.

### 4. Check the live APIs

```powershell
pnpm smoke:live            # all providers
pnpm smoke:live meta       # just Meta
```

This makes a few tiny real calls and saves redacted responses to `fixtures/live/` so we can match
parsers to the real response shapes.

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
packages/providers     Meta / OpenAI / Glimmer / publishing / analytics adapters
packages/agents        Wonder + Spark agents, App DNA, research, campaigns, Glimmer memory
packages/compositions  Composition schema ops, templates, HyperFrames compiler
packages/render        HyperFrames render worker, exports
packages/media         SAM, Voice Transcribe, images, stock, TTS
packages/growth        Discover, publishing calendar, approvals, outreach
packages/analytics     Insights, experiments, recommendations, billing, quotas
infra/                 Firebase rules/indexes, Cloud Run deploy
```
