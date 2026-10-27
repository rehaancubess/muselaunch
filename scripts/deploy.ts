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
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

function sh(cmd: string, opts: { input?: string; allowFail?: boolean; quiet?: boolean } = {}): string {
  if (DRY) {
    console.log(`$ ${cmd}`);
    return "";
  }
  if (!opts.quiet) console.log(`\n$ ${cmd}`);
  try {
    return execSync(cmd, { cwd: root, input: opts.input, encoding: "utf8", stdio: opts.input !== undefined ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"], shell: process.platform === "win32" ? "cmd.exe" : "/bin/sh" }).trim();
  } catch (err) {
    if (opts.allowFail) return "";
    const e = err as { stderr?: string; stdout?: string };
    console.error(e.stderr || e.stdout || err);
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
sh(`gcloud services enable run.googleapis.com cloudtasks.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com cloudbuild.googleapis.com firestore.googleapis.com storage.googleapis.com iamcredentials.googleapis.com --project ${PROJECT}`);
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

// ---- 2. Secrets ----
const SECRETS = ["META_API_KEY", "OPENAI_API_KEY", "GLIMMER_API_KEY", "TOKEN_ENCRYPTION_KEY", "WORKER_SHARED_SECRET", "STORAGE_SIGNING_SECRET"].filter((k) => env[k]);
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
writeFileSync(corsFile, JSON.stringify([{ origin: [WEB_URL, "http://localhost:3000"], method: ["GET", "PUT", "HEAD"], responseHeader: ["Content-Type", "Content-Range", "x-goog-content-length-range"], maxAgeSeconds: 3600 }]));
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
  ].join(",");
  sh(`gcloud builds submit --config infra/cloudbuild.yaml --substitutions=${subs} --project ${PROJECT} .`);
}
const tag = args.has("--skip-build") ? "latest" : TAG;

// ---- 5. Deploy services ----
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
  ...(env.GLIMMER_BASE_URL_PROD ?? env.GLIMMER_BASE_URL ? [`GLIMMER_BASE_URL=${env.GLIMMER_BASE_URL_PROD ?? env.GLIMMER_BASE_URL}`, `GLIMMER_MODEL=${env.GLIMMER_MODEL ?? "muse-glimmer"}`, `GLIMMER_LABEL=${env.GLIMMER_LABEL_PROD ?? "self-hosted"}`] : []),
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
deploy(SVC.api, "api", `--allow-unauthenticated --cpu=1 --memory=1Gi --timeout=3600 --concurrency=80 --min-instances=0 --max-instances=10 ${envFlag()} ${secretFlags}`);
deploy(SVC.web, "web", `--allow-unauthenticated --cpu=1 --memory=1Gi --concurrency=80 --min-instances=0 --max-instances=10`);

console.log(`\nDone.\n  Web: ${WEB_URL}\n  API: ${API_URL}/health\n
Remaining manual step (once): Firebase console → Authentication → Settings → Authorized domains → add
  ${new URL(WEB_URL).host}`);
