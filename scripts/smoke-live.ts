/**
 * Live smoke test: makes 1–2 minimal REAL calls per provider using your .env keys and prints
 * a summary. Redacted responses are saved under fixtures/live/ so the team can build exact
 * parsers. Run on a machine with network access:  pnpm smoke:live [area...]
 */
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { config as loadDotenv } from "dotenv";

loadDotenv({ path: fileURLToPath(new URL("../.env", import.meta.url)), quiet: true });
// Smoke calls only need somewhere to meter usage: always an in-memory DB, whatever .env says
// (a .env copied from .env.example has DB_DRIVER=firestore, which needs a Google Cloud project).
// Set SMOKE_KEEP_DB=1 to meter into the configured database instead.
if (process.env.SMOKE_KEEP_DB !== "1") process.env.DB_DRIVER = "memory";
if (process.env.SMOKE_KEEP_DB !== "1") process.env.AUTH_MODE = "dev";
process.env.JOB_DISPATCH = "inline";
process.env.STORAGE_DRIVER = "local";

const { createPlatform } = await import("@muselaunch/platform");
const { flushWire, installWireCapture, WIRE_DIR } = await import("./smoke/_wire");
const p = createPlatform();
// Raw (redacted) HTTP exchanges with Meta/Glimmer/Baseten → fixtures/live/raw/wire/ (gitignored).
installWireCapture(p);
const dir = fileURLToPath(new URL("./smoke/", import.meta.url));
// "keys" = the quick check for every key that's set (what check-keys.cmd runs by default).
const args = process.argv.slice(2);
const only = args.flatMap((a) => (a === "keys" ? configuredKeyChecks() : [a]));
const files = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.startsWith("_") && (!args.length || only.some((o) => f.includes(o))));

// Every result line also goes to fixtures/live/last-run.log, so a run started by double-clicking a
// .cmd file can be read back afterwards (keys are never printed; errors are redacted by the clients).
const logLines: string[] = [`${new Date().toISOString()} smoke:live ${args.join(" ") || "(all)"}`];
const log = (line: string) => {
  console.log(line);
  logLines.push(line);
};
if (args.includes("keys") && !files.length) log("No keys are set in .env yet (META_API_KEY, BASETEN_API_KEY or GLIMMER_BASE_URL).");

let failed = 0;
for (const f of files) {
  const started = Date.now();
  try {
    // Imported inside the try: a module that fails to load fails only its own smoke.
    const mod = (await import(pathToFileURL(dir + f).href)) as { run: (p: unknown) => Promise<string> };
    const summary = await mod.run(p);
    log(`✅ ${f.replace(".ts", "")} (${Date.now() - started} ms): ${summary}`);
  } catch (err) {
    failed++;
    const e = err as { code?: string; message?: string; opts?: { details?: unknown } };
    // details carry the documented error fields (status, type, code, param, retryAfter).
    log(`❌ ${f.replace(".ts", "")}: ${e.code ?? ""} ${e.message ?? err}${e.opts?.details ? ` ${JSON.stringify(e.opts.details)}` : ""}`);
  }
}
const saved = await flushWire();
log(`wire: ${saved} raw exchange(s) saved under ${WIRE_DIR}`);
const liveDir = fileURLToPath(new URL("../fixtures/live/", import.meta.url));
mkdirSync(liveDir, { recursive: true });
writeFileSync(`${liveDir}last-run.log`, `${logLines.join("\n")}\n`);
process.exit(failed ? 1 : 0);

function configuredKeyChecks(): string[] {
  const set = (k: string) => Boolean(process.env[k]?.trim());
  return [set("META_API_KEY") && "meta-text", set("BASETEN_API_KEY") && "baseten", set("GLIMMER_BASE_URL") && "glimmer"].filter((x): x is string => Boolean(x));
}
