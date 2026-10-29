/**
 * Live smoke test: makes 1–2 minimal REAL calls per provider using your .env keys and prints
 * a summary. Redacted responses are saved under fixtures/live/ so the team can build exact
 * parsers. Run on a machine with network access:  pnpm smoke:live [area...]
 */
import { readdirSync } from "node:fs";
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
const only = process.argv.slice(2);
const files = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.startsWith("_") && (!only.length || only.some((o) => f.includes(o))));
let failed = 0;
for (const f of files) {
  const started = Date.now();
  try {
    // Imported inside the try: a module that fails to load fails only its own smoke.
    const mod = (await import(pathToFileURL(dir + f).href)) as { run: (p: unknown) => Promise<string> };
    const summary = await mod.run(p);
    console.log(`✅ ${f.replace(".ts", "")} (${Date.now() - started} ms): ${summary}`);
  } catch (err) {
    failed++;
    const e = err as { code?: string; message?: string; opts?: { details?: unknown } };
    // details carry the documented error fields (status, type, code, param, retryAfter).
    console.log(`❌ ${f.replace(".ts", "")}: ${e.code ?? ""} ${e.message ?? err}${e.opts?.details ? ` ${JSON.stringify(e.opts.details)}` : ""}`);
  }
}
const saved = await flushWire();
console.log(`wire: ${saved} raw exchange(s) saved under ${WIRE_DIR}`);
process.exit(failed ? 1 : 0);
