// Creates (once) the API key MuseLaunch uses for public YouTube data, restricted to the YouTube Data
// API v3, and saves it in .env as YOUTUBE_API_KEY. The key goes straight from gcloud into .env: it is
// never printed. Needs the Google Cloud CLI, signed in (deploy.cmd / setup-youtube.cmd do that).
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "dotenv";

const root = fileURLToPath(new URL("../../", import.meta.url));
const envPath = `${root}.env`;
const raw = readFileSync(envPath, "utf8");
const env = parse(raw);
const project = (env.FIREBASE_PROJECT_ID ?? "").trim();
if (!project) {
  console.error("FIREBASE_PROJECT_ID is not set in .env");
  process.exit(1);
}
if ((env.YOUTUBE_API_KEY ?? "").trim()) {
  console.log("YOUTUBE_API_KEY is already set in .env: nothing to do.");
  process.exit(0);
}

const shell = process.platform === "win32" ? "cmd.exe" : "/bin/sh";
const gcloud = (args, opts = {}) => execSync(`gcloud ${args}`, { encoding: "utf8", shell, stdio: ["ignore", "pipe", opts.quietErr ? "pipe" : "inherit"] }).trim();
const NAME = "MuseLaunch-YouTube-public-data";

console.log(`Enabling the API Keys and YouTube Data APIs on ${project}...`);
gcloud(`services enable apikeys.googleapis.com youtube.googleapis.com --project ${project}`);

let keyName = gcloud(`services api-keys list --project ${project} --filter="displayName=${NAME}" --format="value(name)"`).split(/\r?\n/)[0];
if (!keyName) {
  console.log("Creating the API key (restricted to YouTube Data API v3)...");
  gcloud(`services api-keys create --project ${project} --display-name=${NAME} --api-target=service=youtube.googleapis.com`, { quietErr: true });
  keyName = gcloud(`services api-keys list --project ${project} --filter="displayName=${NAME}" --format="value(name)"`).split(/\r?\n/)[0];
}
if (!keyName) {
  console.error("Couldn't find the new API key. See https://console.cloud.google.com/apis/credentials");
  process.exit(1);
}
const keyString = gcloud(`services api-keys get-key-string ${keyName} --format="value(keyString)"`, { quietErr: true });
if (!keyString) {
  console.error("Couldn't read the API key.");
  process.exit(1);
}

// Write YOUTUBE_API_KEY into .env, keeping its line endings.
const eol = raw.includes("\r\n") ? "\r\n" : "\n";
const lines = raw.split(/\r?\n/);
const i = lines.findIndex((l) => l.startsWith("YOUTUBE_API_KEY="));
if (i >= 0) lines[i] = `YOUTUBE_API_KEY=${keyString}`;
else {
  const after = lines.findIndex((l) => l.startsWith("YOUTUBE_CLIENT_SECRET="));
  lines.splice(after >= 0 ? after + 1 : lines.length, 0, `YOUTUBE_API_KEY=${keyString}`);
}
writeFileSync(envPath, lines.join(eol));
console.log("Saved YOUTUBE_API_KEY in .env (restricted to YouTube Data API v3).");
