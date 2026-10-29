/**
 * `pnpm run doctor` — checks the local machine and .env, and which providers are reachable.
 * Prints keys as set/unset only (never their values).
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const envPath = fileURLToPath(new URL("../.env", import.meta.url));
const hasEnv = existsSync(envPath);
loadDotenv({ path: envPath, quiet: true });
const env = process.env;

const ok = (m: string) => console.log(`  ✅ ${m}`);
const warn = (m: string) => console.log(`  ⚠️  ${m}`);
const bad = (m: string) => console.log(`  ❌ ${m}`);

console.log("\nMachine");
const major = Number(process.versions.node.split(".")[0]);
major >= 22 ? ok(`Node ${process.versions.node}`) : bad(`Node ${process.versions.node} — need 22+`);
try {
  const v = execFileSync(env.FFMPEG_PATH ?? "ffmpeg", ["-version"], { encoding: "utf8" }).split("\n")[0];
  ok(v ?? "ffmpeg found");
} catch {
  warn("FFmpeg not found on PATH (winget install Gyan.FFmpeg) — needed for media processing and rendering");
}
hasEnv ? ok(".env found") : bad(".env missing — copy .env.example to .env");

console.log("\nConfiguration");
const mode = `${env.DB_DRIVER ?? "(auto)"} db · ${env.JOB_DISPATCH ?? "http"} jobs · ${env.AUTH_MODE ?? "firebase"} auth · ${env.STORAGE_DRIVER ?? "local"} storage`;
ok(mode);
if (env.DB_DRIVER === "memory" && env.JOB_DISPATCH !== "inline") bad("DB_DRIVER=memory requires JOB_DISPATCH=inline (separate worker can't see in-memory data)");
if (env.DB_DRIVER === "firestore" && !env.FIREBASE_PROJECT_ID) bad("DB_DRIVER=firestore needs FIREBASE_PROJECT_ID");
if ((env.NEXT_PUBLIC_AUTH_MODE ?? "firebase") === "firebase" && !env.NEXT_PUBLIC_FIREBASE_API_KEY) warn("Web uses Firebase auth but NEXT_PUBLIC_FIREBASE_* is empty (use NEXT_PUBLIC_AUTH_MODE=dev for local mode)");
if (env.MUSE_IMAGE_ENABLED === "true" && (env.OPERATOR_COUNTRY ?? "IN") === "IN") bad("MUSE_IMAGE_ENABLED=true while OPERATOR_COUNTRY=IN — Muse Image may not be accessed from India; it stays off");

console.log("\nProvider keys");
const keys: [string, string][] = [
  ["META_API_KEY", "Meta Model API (Wonder, Spark, SAM, Voice)"],
  ["BASETEN_API_KEY", "Baseten Model APIs (Muse Spark Open, open weights)"],
  ["OPENAI_API_KEY", "OpenAI (images, TTS, and the Meta stand-in when META_STAND_IN=openai)"],
  ["GLIMMER_BASE_URL", "Muse Glimmer endpoint"],
  ["TOKEN_ENCRYPTION_KEY", "OAuth token encryption (required in production)"],
];
for (const [k, label] of keys) (env[k] ? ok : warn)(`${label}: ${env[k] ? "set" : "not set"}`);

console.log("\nMeta Model API stand-in");
{
  const standIn = env.META_STAND_IN?.trim() === "openai";
  if (env.META_API_KEY) ok(standIn ? "META_API_KEY is set, so Meta is used and the OpenAI stand-in is off" : "Not needed: META_API_KEY is set");
  else if (standIn && env.OPENAI_API_KEY)
    warn(`ON: OpenAI ${env.STAND_IN_MODEL_WONDER || "gpt-6.1-sol"} / ${env.STAND_IN_MODEL_SPARK || "gpt-6.1-terra"} answer Muse Wonder / Muse Spark calls (labelled). SAM 3.1, Muse Voice Transcribe and Muse Image stay off until META_API_KEY is set.`);
  else if (standIn) bad("META_STAND_IN=openai but OPENAI_API_KEY is not set: nothing answers Muse Wonder / Muse Spark");
  else warn("Off (set META_STAND_IN=openai and OPENAI_API_KEY to run Wonder/Spark steps on OpenAI until a Meta key works)");
}

console.log("\nMuse Spark Open (Baseten)");
{
  const { TEXT_ROUTES } = await import("@muselaunch/providers");
  const EXPECTED_MODEL = "meta-models/muse-spark-open-1026";
  const model = env.SPARK_OPEN_MODEL || EXPECTED_MODEL;
  const tasks = env.SPARK_OPEN_TASKS === undefined ? ["copy.generate", "composition.variant_briefs"] : env.SPARK_OPEN_TASKS.split(",").map((s) => s.trim()).filter(Boolean);
  const fallback = !["0", "false", "no", "off"].includes((env.SPARK_OPEN_FALLBACK ?? "1").toLowerCase());
  if (!env.BASETEN_API_KEY) {
    warn("Not connected (BASETEN_API_KEY not set): every route stays on Muse Spark and there is no fallback");
  } else {
    ok(`Key set · base URL ${env.BASETEN_BASE_URL || "https://inference.baseten.co/v1"}`);
    (model === EXPECTED_MODEL ? ok : bad)(`Model ${model}${model === EXPECTED_MODEL ? "" : ` — the hackathon key only works with ${EXPECTED_MODEL}`}`);
    const unknown = tasks.filter((t) => !(t in TEXT_ROUTES));
    const known = tasks.filter((t) => t in TEXT_ROUTES);
    ok(`Runs on Spark Open: ${known.join(", ") || "nothing (fallback only)"}`);
    if (unknown.length) warn(`Unknown SPARK_OPEN_TASKS entries (ignored): ${unknown.join(", ")}. Known: ${Object.keys(TEXT_ROUTES).join(", ")}`);
    (fallback ? ok : warn)(`Fallback when the Meta Model API is limited: ${fallback ? "on" : "off"}`);
    console.log("  ℹ️  Live check (three tiny calls, raw exchanges saved): pnpm smoke:live baseten");
  }
}

console.log("\nReachability");
async function probe(label: string, url: string, headers: Record<string, string> = {}) {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
    if (res.ok) ok(`${label}: HTTP ${res.status}`);
    else if (res.status === 401 || res.status === 403) bad(`${label}: HTTP ${res.status} (key rejected)`);
    else warn(`${label}: HTTP ${res.status}`);
  } catch (err) {
    bad(`${label}: unreachable (${(err as Error).message})`);
  }
}
if (env.META_API_KEY) await probe("Meta /v1/models", `${env.META_BASE_URL ?? "https://api.meta.ai/v1"}/models`, { authorization: `Bearer ${env.META_API_KEY}` });
if (env.OPENAI_API_KEY) await probe("OpenAI /v1/models", "https://api.openai.com/v1/models", { authorization: `Bearer ${env.OPENAI_API_KEY}` });
if (env.GLIMMER_BASE_URL) await probe("Glimmer /models", `${env.GLIMMER_BASE_URL.replace(/\/$/, "")}/models`, env.GLIMMER_API_KEY ? { authorization: `Bearer ${env.GLIMMER_API_KEY}` } : {});
await probe("iTunes lookup (app import)", "https://itunes.apple.com/lookup?id=284882215");
console.log("");
