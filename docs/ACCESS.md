# Getting access (owner checklist)

Put every key in `D:\muselaunch\.env` (never in chat, never committed). Run `pnpm doctor` after each
step: it tells you what is connected.

## 1. Meta Model API (required) — ~5 min

1. Go to https://dev.meta.ai and **Login** with the same account you used for the hackathon application.
2. Open **Dashboard** → **API keys** → create a key → copy it into `.env` as `META_API_KEY=`.
3. Check billing/credits on the dashboard: selected hackathon participants receive **$150 in Meta
   Model API credits**. If you see no credit, ask in the hackathon Discord (office hours) before
   adding a card.
4. Run `pnpm smoke:live meta`. You should see the model list, a Spark answer with citations and a
   Wonder reply.

Models used: `muse-wonder-1.0`, `muse-spark-1.3`, `sam-3.1`, `muse-voice-transcribe-1.0` (all
Standard mode — customer data never uses Contributor mode).

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

Easiest path (Ollama, already installed on your PC):

```powershell
ollama --version          # needs 0.32.7 or newer; update from https://ollama.com/download if older
ollama pull muse-glimmer
ollama run muse-glimmer "Reply with: ready"
```

Then in `.env`:

```
GLIMMER_BASE_URL=http://localhost:11434/v1
GLIMMER_API_KEY=ollama
GLIMMER_MODEL=muse-glimmer
GLIMMER_LABEL=RTX 5090 (self-hosted)
```

Alternative (more control, 128K context): llama.cpp `llama serve` with the 17 GB Q4_K_M GGUF —
see https://dev.meta.ai/docs/muse-glimmer/deploy#llama-cpp.

For the public beta we'll deploy Glimmer on partner GPU credits (below) so it doesn't depend on your
PC being on; your 5090 stays the development/demo machine.

## 5. Partner GPU credits (for hosting Glimmer publicly)

The event page lists Baseten ($100 + 2M TPM), Modal ($100) and Fireworks ($25) credits for **select**
participants, for Meta's open-weight models. Check your acceptance email and the Discord for claim
links. Claim **Modal** first (scale-to-zero GPU endpoints suit a beta). Tell me when it's active and
I'll add the deploy script.

## 6. Google Cloud & Firebase — ~20 min

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

## 7. Optional, later

| Integration | What you need | Until then |
|---|---|---|
| RevenueCat | Secret API key (v2) + project id, entered in Insights → Connect | CSV import (labelled "Imported") |
| YouTube publishing | Google OAuth client (YouTube Data API v3), app verification for public use | Export package + manual posting |
| Instagram / Facebook / TikTok / LinkedIn / X | Developer apps + app review (days–weeks) | Export package + manual posting |
| Payments | Not needed for the beta (credits only) | "Upgrade request" form |
