# Getting access (owner checklist)

Put every key in `D:\muselaunch\.env` (never in chat, never committed). Run `pnpm run doctor` after each
step: it tells you what is connected.

## 1. Meta Model API (required) — ~5 min

1. Go to https://dev.meta.ai and **Login** with the same account you used for the hackathon application.
2. Open **Dashboard** → **API keys** → create a key → copy it into `.env` as `META_API_KEY=`.
3. Check billing/credits on the dashboard: selected hackathon participants receive **$150 in Meta
   Model API credits**. If you see no credit, ask in the hackathon Discord (office hours) before
   adding a card.
4. Run `pnpm smoke:live meta`. You should see the model list, a Spark answer with citations, a
   Wonder reply and a Wonder tool-call round trip. SAM 3.1 and Voice Transcribe are in
   `pnpm smoke:live media`. Raw (redacted) request/response bodies for every call are written to
   `fixtures/live/raw/wire/` (gitignored); check them before sharing.

Models used: `muse-wonder-1.0`, `muse-spark-1.3`, `sam-3.1`, `muse-voice-transcribe-1.0` (all
Standard mode — customer data never uses Contributor mode). Muse Spark Open runs on Baseten instead
(section 5).

## 2. Muse Image — ask the organisers (do not enable yet)

Meta's Geographic Use Policy (updated 12 Oct 2026, §2.2) says Muse Image may not be accessed from
India or offered to end users in India, and §2.1 forbids working around geographic controls.
MuseLaunch therefore keeps `MUSE_IMAGE_ENABLED=false` and uses OpenAI Images. Post this in the
hackathon Discord:

> Hi! Indie track, building from India. The Model API geographic policy restricts Muse Image access
> from India. Is there an approved path for India-based participants, or should we use a separate
> licensed image provider and hide Muse Image for India users? Want to stay compliant.

Only if they confirm an approved path in writing do we revisit this.

## 3. OpenAI (images + optional narration) — ~5 min

1. https://platform.openai.com → **API keys** → create a key → `OPENAI_API_KEY=`.
2. **Settings → Limits**: set a monthly budget (e.g. $10).
3. Image models may require **organisation verification** (Settings → Organization → Verify). Do it now;
   it can take a little while.

## 4. Muse Glimmer on your RTX 5090 — ~20 min (mostly download)

Easiest path: double-click **`setup-glimmer.cmd`** in the repo folder. It:

1. pulls `muse-glimmer` with Ollama (Q4_K_M, about 18-19 GB, one time);
2. creates `muse-glimmer-muselaunch` from `scripts/windows/glimmer.Modelfile` with a 32k context
   window, because Ollama's default context is small and silently truncates long prompts;
3. loads it on the GPU (`ollama ps` should say 100% GPU);
4. sets these lines in `.env`:

   ```
   GLIMMER_BASE_URL=http://localhost:11434/v1
   GLIMMER_API_KEY=ollama
   GLIMMER_MODEL=muse-glimmer-muselaunch
   GLIMMER_LABEL=RTX 5090 (self-hosted)
   ```

5. runs `pnpm smoke:live glimmer`, a real Brand Guardian-style review on your GPU.

The smoke test costs nothing because it runs on your own GPU. Fixture mode (`start-demo.cmd`) still
answers Glimmer from fixtures; the real Glimmer is used when the API runs in live mode.

Alternative (more control, 128K context): llama.cpp `llama serve` with the 17 GB Q4_K_M GGUF —
see https://dev.meta.ai/docs/muse-glimmer/deploy#llama-cpp.

For the public beta we'll deploy Glimmer on partner GPU credits (below) so it doesn't depend on your
PC being on; your 5090 stays the development/demo machine.

## 5. Muse Spark Open on Baseten (hackathon credits) — ~5 min

Muse Spark Open is Meta's open-weights Spark model, served by Baseten's Model APIs (OpenAI-compatible
Chat Completions at `https://inference.baseten.co/v1`). MuseLaunch uses it for high-volume steps (post
copy, hook/audience variant briefs) and as a visible fallback when the Meta Model API is rate-limited,
unavailable, times out or runs out of credits. Your hackathon key comes with **$100 in credits and
2M tokens per minute**.

1. Create an API key in your Baseten account settings and put it in `.env`:

   ```
   BASETEN_API_KEY=...
   SPARK_OPEN_MODEL=meta-models/muse-spark-open-1026
   ```

   Use exactly `meta-models/muse-spark-open-1026`: the hackathon key only works with that model.
   Baseten's docs show `meta-models/muse-spark-open`, which this key can't call.
2. `pnpm run doctor` → the **Muse Spark Open (Baseten)** section shows the key, the model, which steps run
   on it and whether the fallback is on.
3. `pnpm smoke:live baseten` makes three tiny calls (well under $0.05): plain text, streamed JSON and
   one small image. It prints where the model's reasoning arrived, token usage (reasoning tokens are
   billed as output), the echoed model and rate-limit headers. Redacted raw exchanges go to
   `fixtures/live/raw/wire/` (no key; reasoning text replaced by its length). Send me that output.
4. Optional: set a monthly budget in Baseten's billing settings. MuseLaunch's own spend ceilings apply
   to Baseten calls too.

What runs where (`.env`):

- `SPARK_OPEN_TASKS=copy.generate,composition.variant_briefs` (default): post copy and variant briefs.
  Add `composition.edit.scoped` to also send scene-scoped edits (hook rewrites, Brand Guardian fixes)
  once the smoke test and a few real edits look good; a repair after a failed edit still goes to Muse
  Spark. An empty value means fallback only.
- `SPARK_OPEN_FALLBACK=1` (default): a Muse Spark call that hits a rate limit, an outage, a timeout or a
  credits error is retried once on Spark Open. The agent run shows "Muse Spark was rate-limited; used
  Muse Spark Open (open weights) instead", and usage is billed to Baseten, never to Meta.
- Without `BASETEN_API_KEY`, Integrations shows Muse Spark Open as **Not connected** and everything
  stays on Muse Spark.

Price (https://www.baseten.co/pricing/, Oct 2026): $1.25 input / $0.15 cached input / $4.25 output per
1M tokens, the same as Muse Spark 1.3 on the Meta Model API.

Production: `pnpm deploy:gcp` stores `BASETEN_API_KEY` in Secret Manager and passes the
`SPARK_OPEN_*` settings to the services.

## 6. Partner GPU credits (for hosting Glimmer publicly)

The event page lists Baseten ($100 + 2M TPM), Modal ($100) and Fireworks ($25) credits for **select**
participants, for Meta's open-weight models. The Baseten credits are a Model APIs key for Muse Spark
Open (section 5), not GPU hosting. For Glimmer, claim **Modal** first (scale-to-zero GPU endpoints suit
a beta). Tell me when it's active and I'll add the deploy script.

## 7. Google Cloud & Firebase — ~20 min

1. https://console.cloud.google.com → **New project** (e.g. `muselaunch-prod`). Note the **project ID**.
2. **Billing** → link a billing account. Then **Billing → Budgets & alerts** → create a budget (e.g.
   ₹2,000/month) with email alerts.
3. https://console.firebase.google.com → **Add project** → select the same Google Cloud project.
4. Firebase console:
   - **Authentication** → Get started → enable **Google** and **Email/Password** (with *Email link*).
     Under **Settings → Authorized domains** add `localhost` (and later your Cloud Run/web domain).
   - **Firestore Database** → Create database → **Native mode** → location. Choose carefully: it can't be
     changed later. `asia-south1` (Mumbai) keeps data near you and Indian users; `us-central1` is
     closer to most judges and to Cloud Run's widest feature set. Tell me which you pick.
   - **Storage** → Get started (same location).
   - **Project settings → Your apps → Web app** (`</>`) → register → copy the config values into the
     `NEXT_PUBLIC_FIREBASE_*` lines of `.env`.
5. Install the Google Cloud CLI: `winget install Google.CloudSDK`, then:

```powershell
gcloud auth login
gcloud config set project YOUR_PROJECT_ID
gcloud services enable run.googleapis.com cloudtasks.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com cloudbuild.googleapis.com firestore.googleapis.com storage.googleapis.com iamcredentials.googleapis.com
gcloud auth application-default login     # lets your local API use Firestore/Storage
```

6. Put `FIREBASE_PROJECT_ID=` and `STORAGE_BUCKET=` (shown in Firebase Storage, e.g.
   `your-project.firebasestorage.app`) in `.env`.

## 8. Optional, later

| Integration | What you need | Until then |
|---|---|---|
| RevenueCat | Secret API key (v2) + project id, entered in Insights → Connect | CSV import (labelled "Imported") |
| YouTube publishing | Google OAuth client (YouTube Data API v3), app verification for public use | Export package + manual posting |
| Instagram / Facebook / TikTok / LinkedIn / X | Developer apps + app review (days–weeks) | Export package + manual posting |
| Payments | Not needed for the beta (credits only) | "Upgrade request" form |
