// Writes apps/web/.env.local for a local run of the web app from the root .env, and prints the
// sign-in mode ("firebase" or "dev") so start-live.cmd can run the API in the same mode.
//
//   node scripts/windows/web-env.mjs          → real sign-in (Firebase) when the web config is in .env
//   node scripts/windows/web-env.mjs dev      → local test sign-in (any email, never in production)
//
// Only public values are written (the Firebase web config is public by design; no secrets).
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "dotenv";

const root = fileURLToPath(new URL("../../", import.meta.url));
let env = {};
try {
  env = parse(readFileSync(`${root}.env`, "utf8"));
} catch {
  /* no .env yet: dev sign-in */
}
const get = (k) => (env[k] ?? "").trim();
const firebaseReady = Boolean(get("NEXT_PUBLIC_FIREBASE_API_KEY") && get("NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN") && get("NEXT_PUBLIC_FIREBASE_PROJECT_ID") && get("FIREBASE_PROJECT_ID"));
const mode = process.argv[2] === "dev" || !firebaseReady ? "dev" : "firebase";

const lines = [
  "# Written by scripts/windows/web-env.mjs from the root .env on each start. Edit .env instead.",
  "NEXT_PUBLIC_API_URL=http://localhost:8080",
  `NEXT_PUBLIC_AUTH_MODE=${mode}`,
];
for (const k of ["NEXT_PUBLIC_FIREBASE_API_KEY", "NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN", "NEXT_PUBLIC_FIREBASE_PROJECT_ID", "NEXT_PUBLIC_FIREBASE_APP_ID", "NEXT_PUBLIC_CONTACT_EMAIL", "NEXT_PUBLIC_OPERATOR_NAME"]) {
  if (get(k)) lines.push(`${k}=${get(k)}`);
}
writeFileSync(`${root}apps/web/.env.local`, `${lines.join("\n")}\n`);
process.stdout.write(mode);
