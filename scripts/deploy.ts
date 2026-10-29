/**
 * One-command deploy to Google Cloud Run (idempotent; safe to re-run).
 *
 *   pnpm deploy:gcp              # full deploy
 *   pnpm deploy:gcp --dry-run    # print the gcloud commands only
 *   pnpm deploy:gcp --skip-build # redeploy services with the last images
 *
 * Needs: gcloud CLI logged in (`gcloud auth login`), FIREBASE_PROJECT_ID + STORAGE_BUCKET and provider
 * keys in .env. Creates: Artifact Registry repo, service accounts with least-privilege roles, Secret
 * Manager secrets, Cloud Tasks queues, bucket CORS, and 4 Cloud Run services (web, api, worker, render).
 */
import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const root = fileURLToPath(new URL("..", import.meta.url));
const envFile = join(root, ".env");
loadDotenv({ path: envFile, quiet: true });
const env = process.env;
const args = new Set(process.argv.slice(2));
const DRY = args.has("--dry-run");

const PROJECT = env.FIREBASE_PROJECT_ID;
const REGION = env.DEPLOY_REGION ?? "us-central1";
const BUCKET = env.STORAGE_BUCKET;
if (!PROJECT || !BUCKET) {
  console.error("Set FIREBASE_PROJECT_ID and STORAGE_BUCKET in .env first (see docs/ACCESS.md).");
  process.exit(1);
}

// Every command and its output also goes to .data/logs/deploy.log (secrets are passed on stdin or as
// Secret Manager references, never on a command line), so a failed run can be diagnosed afterwards.
const LOG = join(root, ".data", "logs", "deploy.log");
if (!DRY) {
  mkdirSync(dirname(LOG), { recursive: true });
  writeFileSync(LOG, `deploy started ${new Date().toISOString()}\n`);
}
const logLine = (s: string) => {
  if (!DRY) appendFileSync(LOG, `${s}\n`);
};

function sh(cmd: string, opts: { input?: string; allowFail?: boolean; quiet?: boolean } = {}): string {
  if (DRY) {
    console.log(`$ ${cmd}`);
    return "";
  }
  if (!opts.quiet) console.log(`\n$ ${cmd}`);
  logLine(`\n$ ${cmd}`);
  try {
    const out = execSync(cmd, { cwd: root, input: opts.input, encoding: "utf8", stdio: opts.input !== undefined ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"], shell: process.platform === "win32" ? "cmd.exe" : "/bin/sh" }).trim();
    logLine(out.slice(-4000));
    return out;
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string };
    logLine(`FAILED${opts.allowFail ? " (allowed)" : ""}: ${String(e.stderr || e.stdout || err).slice(-4000)}`);
    if (opts.allowFail) return "";
    console.error(e.stderr || e.stdout || err);
    console.error(`\nThe full log is in ${LOG}`);
    process.exit(1);
  }
}

// ---- stable secrets (generated once, written back to .env) ----
function ensureLocalSecret(name: string, gen: () => string) {
  if (env[name] && !env[name]!.startsWith("change-me")) return;
  const v = gen();
  env[name] = v;
  if (!DRY) appendFileSync(envFile, `\n${name}=${v}\n`);
  console.log(DRY ? `Would generate ${name}` : `Generated ${name} and saved it to .env`);
}
ensureLocalSecret("TOKEN_ENCRYPTION_KEY", () => randomBytes(32).toString("base64"));
ensureLocalSecret("WORKER_SHARED_SECRET", () => randomBytes(24).toString("base64url"));
ensureLocalSecret("STORAGE_SIGNING_SECRET", () => randomBytes(24).toString("base64url"));

const projectNumber = DRY ? "PROJECT_NUMBER" : sh(`gcloud projects describe ${PROJECT} --format="value(projectNumber)"`, { quiet: true });
const url = (svc: string) => `https://${svc}-${projectNumber}.${REGION}.run.app`;
const SVC = { web: "muselaunch-web", api: "muselaunch-api", worker: "muselaunch-worker", render: "muselaunch-render" };
const WEB_URL = env.PUBLIC_WEB_URL_PROD ?? url(SVC.web);
const API_URL = env.API_PUBLIC_URL_PROD ?? url(SVC.api);
const REPO = `${REGION}-docker.pkg.dev/${PROJECT}/muselaunch`;
const TAG = DRY ? "TAG" : `${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 12)}-${sh("git rev-parse --short HEAD", { quiet: true, allowFail: true }) || "local"}`;
const RUN_SA = `muselaunch-run@${PROJECT}.iam.gserviceaccount.com`;
const TASKS_SA = `muselaunch-tasks@${PROJECT}.iam.gserviceaccount.com`;

console.log(`Deploying MuseLaunch to ${PROJECT} (${REGION})\n  web ${WEB_URL}\n  api ${API_URL}`);

// ---- 1. APIs, registry, service accounts, IAM ----
sh(`gcloud services enable cloudscheduler.googleapis.com run.googleapis.com cloudtasks.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com cloudbuild.googleapis.com firestore.googleapis.com storage.googleapis.com iamcredentials.googleapis.com --project ${PROJECT}`);
sh(`gcloud artifacts repositories create muselaunch --repository-format=docker --location=${REGION} --project ${PROJECT}`, { allowFail: true });
sh(`gcloud iam service-accounts create muselaunch-run --display-name="MuseLaunch runtime" --project ${PROJECT}`, { allowFail: true });
sh(`gcloud iam service-accounts create muselaunch-tasks --display-name="MuseLaunch Cloud Tasks invoker" --project ${PROJECT}`, { allowFail: true });
for (const role of ["roles/datastore.user", "roles/cloudtasks.enqueuer", "roles/secretmanager.secretAccessor", "roles/logging.logWriter"]) {
  sh(`gcloud projects add-iam-policy-binding ${PROJECT} --member=serviceAccount:${RUN_SA} --role=${role} --condition=None --quiet`, { quiet: true });
}
sh(`gcloud storage buckets add-iam-policy-binding gs://${BUCKET} --member=serviceAccount:${RUN_SA} --role=roles/storage.objectAdmin --quiet`, { quiet: true });
// signBlob for v4 signed URLs without a key file; actAs the tasks SA to attach OIDC tokens to tasks
sh(`gcloud iam service-accounts add-iam-policy-binding ${RUN_SA} --member=serviceAccount:${RUN_SA} --role=roles/iam.serviceAccountTokenCreator --project ${PROJECT} --quiet`, { quiet: true });
sh(`gcloud iam service-accounts add-iam-policy-binding ${TASKS_SA} --member=serviceAccount:${RUN_SA} --role=roles/iam.serviceAccountUser --project ${PROJECT} --quiet`, { quiet: true });

// ---- 1b. Firestore composite indexes (infra/firebase/firestore.indexes.json) via the Firestore Admin
// API, with gcloud's access token: no firebase-tools login needed. Existing indexes are skipped (409).
if (!args.has("--skip-indexes") && !DRY) {
  const token = sh("gcloud auth print-access-token", { quiet: true });
  const spec = JSON.parse(readFileSync(join(root, "infra", "firebase", "firestore.indexes.json"), "utf8")) as {
    indexes: { collectionGroup: string; queryScope: string; fields: { fieldPath: string; order?: string; arrayConfig?: string }[] }[];
  };
  let created = 0;
  let existing = 0;
  const failed: string[] = [];
  for (const ix of spec.indexes) {
    const url = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/collectionGroups/${ix.collectionGroup}/indexes`;
    const res = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-goog-user-project": PROJECT },
      body: JSON.stringify({ queryScope: ix.queryScope, fields: ix.fields }),
    });
    if (res.ok) created++;
    else if (res.status === 409) existing++;
    else failed.push(`${ix.collectionGroup} (${res.status} ${(await res.text()).slice(0, 200)})`);
  }
  const summary = `Firestore indexes: ${created} requested, ${existing} already there${failed.length ? `, ${failed.length} failed: ${failed.join("; ")}` : ""}`;
  console.log(`\n${summary}`);
  logLine(summary);
  if (created) console.log("  New indexes take a few minutes to build; queries that need them fail until they're ready.");
}

// ---- 2. Secrets ----
const SECRETS = ["META_API_KEY", "BASETEN_API_KEY", "OPENAI_API_KEY", "GLIMMER_API_KEY", "TOKEN_ENCRYPTION_KEY", "WORKER_SHARED_SECRET", "STORAGE_SIGNING_SECRET"].filter((k) => env[k]);
for (const name of SECRETS) {
  sh(`gcloud secrets create ${name} --replication-policy=automatic --project ${PROJECT}`, { allowFail: true, quiet: true });
  sh(`gcloud secrets versions add ${name} --data-file=- --project ${PROJECT}`, { input: env[name]!, quiet: true });
  console.log(`  secret ${name} updated`);
}
const secretFlags = SECRETS.length ? `--set-secrets=${SECRETS.map((s) => `${s}=${s}:latest`).join(",")}` : "";

// ---- 3. Queues + bucket CORS ----
for (const [q, conc] of [["muselaunch-agents", 20], ["muselaunch-media", 8], ["muselaunch-render", 3]] as const) {
  sh(`gcloud tasks queues create ${q} --location=${REGION} --project ${PROJECT}`, { allowFail: true, quiet: true });
  sh(`gcloud tasks queues update ${q} --location=${REGION} --max-attempts=5 --min-backoff=5s --max-backoff=300s --max-concurrent-dispatches=${conc} --project ${PROJECT}`, { quiet: true });
}
const corsFile = join(mkdtempSync(join(tmpdir(), "ml-")), "cors.json");
writeFileSync(corsFile, JSON.stringify([{ origin: [WEB_URL, "http://localhost:3000"], method: ["GET", "PUT", "HEAD"], responseHeader: ["Content-Type", "Content-Range", "x-goog-content-length-range", "x-goog-if-generation-match"], maxAgeSeconds: 3600 }]));
sh(`gcloud storage buckets update gs://${BUCKET} --cors-file="${corsFile}"`);

// ---- 4. Build images ----
if (!args.has("--skip-build")) {
  const subs = [
    `_REPO=${REPO}`,
    `_TAG=${TAG}`,
    `_API_URL=${API_URL}`,
    `_FB_API_KEY=${env.NEXT_PUBLIC_FIREBASE_API_KEY ?? ""}`,
    `_FB_AUTH_DOMAIN=${env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN ?? `${PROJECT}.firebaseapp.com`}`,
    `_FB_APP_ID=${env.NEXT_PUBLIC_FIREBASE_APP_ID ?? ""}`,
    `_CONTACT_EMAIL=${env.NEXT_PUBLIC_CONTACT_EMAIL ?? ""}`,
    `_OPERATOR_NAME=${(env.NEXT_PUBLIC_OPERATOR_NAME ?? "").replace(/[,"]/g, " ")}`,
  ].join(",");
  sh(`gcloud builds submit --config infra/cloudbuild.yaml "--substitutions=${subs}" --project ${PROJECT} .`);
}
const tag = args.has("--skip-build") ? "latest" : TAG;

// ---- 5. Deploy services ----
const glimmerProd = env.GLIMMER_BASE_URL_PROD && !/localhost|127\.0\.0\.1/.test(env.GLIMMER_BASE_URL_PROD) ? env.GLIMMER_BASE_URL_PROD : undefined;
if (!glimmerProd && env.GLIMMER_BASE_URL) console.log("Note: Muse Glimmer runs on this PC only (GLIMMER_BASE_URL is local); the live site's Brand Guardian uses its rules until GLIMMER_BASE_URL_PROD is set.");
const common = [
  "NODE_ENV=production",
  "APP_ENV=production",
  `FIREBASE_PROJECT_ID=${PROJECT}`,
  "DB_DRIVER=firestore",
  "STORAGE_DRIVER=gcs",
  `STORAGE_BUCKET=${BUCKET}`,
  "AUTH_MODE=firebase",
  `PUBLIC_WEB_URL=${WEB_URL}`,
  `API_PUBLIC_URL=${API_URL}`,
  `OPERATOR_COUNTRY=${env.OPERATOR_COUNTRY ?? "IN"}`,
  "MUSE_IMAGE_ENABLED=false",
  `IMAGE_PROVIDER=${env.IMAGE_PROVIDER ?? "openai"}`,
  `OPENAI_IMAGE_MODEL=${env.OPENAI_IMAGE_MODEL ?? "gpt-image-2.5-flare"}`,
  `GLOBAL_DAILY_SPEND_CEILING_USD=${env.GLOBAL_DAILY_SPEND_CEILING_USD ?? "40"}`,
  `WORKSPACE_MONTHLY_SPEND_CEILING_USD=${env.WORKSPACE_MONTHLY_SPEND_CEILING_USD ?? "25"}`,
  `SIGNUP_CREDITS=${env.SIGNUP_CREDITS ?? "300"}`,
  "TRACE_MODEL_IO=true",
  ...(env.ADMIN_UIDS ? [`ADMIN_UIDS=${env.ADMIN_UIDS.replace(/,/g, ";")}`] : []),
  // Glimmer in production only via GLIMMER_BASE_URL_PROD: the local GLIMMER_BASE_URL (Ollama on this PC,
  // http://localhost:11434) means nothing inside Cloud Run. Without it, Brand Guardian uses its rules.
  ...(glimmerProd ? [`GLIMMER_BASE_URL=${glimmerProd}`, `GLIMMER_MODEL=${env.GLIMMER_MODEL_PROD ?? env.GLIMMER_MODEL ?? "muse-glimmer"}`, `GLIMMER_LABEL=${env.GLIMMER_LABEL_PROD ?? "self-hosted"}`] : []),
  // Temporary OpenAI stand-in for the Meta Model API (only while no META_API_KEY is set; labelled in the app).
  ...(env.META_STAND_IN === "openai" && !env.META_API_KEY && env.OPENAI_API_KEY
    ? ["META_STAND_IN=openai", `STAND_IN_MODEL_WONDER=${env.STAND_IN_MODEL_WONDER || "gpt-6.1-sol"}`, `STAND_IN_MODEL_SPARK=${env.STAND_IN_MODEL_SPARK || "gpt-6.1-terra"}`]
    : []),
  // Muse Spark Open (open weights on Baseten): key is a secret above; routing and fallback as in .env.
  ...(env.BASETEN_API_KEY
    ? [
        `SPARK_OPEN_MODEL=${env.SPARK_OPEN_MODEL || "meta-models/muse-spark-open-1026"}`,
        ...(env.SPARK_OPEN_TASKS !== undefined ? [`SPARK_OPEN_TASKS=${env.SPARK_OPEN_TASKS}`] : []),
        `SPARK_OPEN_FALLBACK=${env.SPARK_OPEN_FALLBACK ?? "1"}`,
        ...(env.BASETEN_BASE_URL ? [`BASETEN_BASE_URL=${env.BASETEN_BASE_URL}`] : []),
      ]
    : []),
  `TASKS_LOCATION=${REGION}`,
  `TASKS_INVOKER_SA=${TASKS_SA}`,
  "JOB_DISPATCH=cloudtasks",
  `WORKER_URL=${url(SVC.worker)}`,
  `WORKER_URL_AGENTS=${url(SVC.worker)}`,
  `WORKER_URL_MEDIA=${url(SVC.worker)}`,
  `WORKER_URL_RENDER=${url(SVC.render)}`,
];
const envFlag = (extra: string[] = []) => `--set-env-vars="^@^${[...common, ...extra].join("@")}"`;
const deploy = (svc: string, image: string, flags: string) =>
  sh(`gcloud run deploy ${svc} --image=${REPO}/${image}:${tag} --region=${REGION} --project=${PROJECT} --service-account=${RUN_SA} ${flags} --quiet`);

deploy(SVC.worker, "worker", `--no-allow-unauthenticated --cpu=2 --memory=2Gi --timeout=900 --concurrency=8 --min-instances=0 --max-instances=5 ${envFlag(["WORKER_POOLS=agents,media", "WORKER_TRUST_IAM=1"])} ${secretFlags}`);
deploy(SVC.render, "render", `--no-allow-unauthenticated --cpu=4 --memory=8Gi --timeout=1800 --concurrency=1 --min-instances=0 --max-instances=3 --execution-environment=gen2 ${envFlag(["WORKER_POOLS=render", "WORKER_TRUST_IAM=1"])} ${secretFlags}`);
for (const svc of [SVC.worker, SVC.render]) {
  sh(`gcloud run services add-iam-policy-binding ${svc} --region=${REGION} --member=serviceAccount:${TASKS_SA} --role=roles/run.invoker --project=${PROJECT} --quiet`, { quiet: true });
}
// Crons: publish approved posts whose scheduled time has arrived (every minute); wake Growth
// Autopilot loops whose measurement window ended and repair missed job-completion resumes (every 5 min).
for (const [name, schedule] of [
  ["publish-due", "* * * * *"],
  ["autopilot-wake", "*/5 * * * *"],
] as const) {
  const cronUri = `${url(SVC.worker)}/tasks/cron/${name}`;
  const cronFlags = `--schedule="${schedule}" --uri=${cronUri} --http-method=POST --oidc-service-account-email=${TASKS_SA} --oidc-token-audience=${url(SVC.worker)} --location=${REGION} --project=${PROJECT}`;
  if (!sh(`gcloud scheduler jobs update http muselaunch-${name} ${cronFlags}`, { allowFail: true, quiet: true }) && !DRY) {
    sh(`gcloud scheduler jobs create http muselaunch-${name} ${cronFlags}`, { allowFail: true });
  }
}
deploy(SVC.api, "api", `--allow-unauthenticated --cpu=1 --memory=1Gi --timeout=3600 --concurrency=80 --min-instances=0 --max-instances=10 ${envFlag()} ${secretFlags}`);
deploy(SVC.web, "web", `--allow-unauthenticated --cpu=1 --memory=1Gi --concurrency=80 --min-instances=0 --max-instances=10`);

console.log(`\nDone.\n  Web: ${WEB_URL}\n  API: ${API_URL}/health\n
Remaining manual step (once): Firebase console → Authentication → Settings → Authorized domains → add
  ${new URL(WEB_URL).host}`);
