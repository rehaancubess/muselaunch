/**
 * `pnpm doctor` — checks the local machine and .env, and which providers are reachable.
 * Prints keys as set/unset only (never their values).
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const envPath = fileURLToPath(new URL("../.env", import.meta.url));
const hasEnv = existsSync(envPath);
loadDotenv({ path: envPath });
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
  ["OPENAI_API_KEY", "OpenAI Images / TTS"],
  ["GLIMMER_BASE_URL", "Muse Glimmer endpoint"],
  ["TOKEN_ENCRYPTION_KEY", "OAuth token encryption (required in production)"],
];
for (const [k, label] of keys) (env[k] ? ok : warn)(`${label}: ${env[k] ? "set" : "not set"}`);

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
