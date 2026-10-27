/**
 * Live smoke test: makes 1–2 minimal REAL calls per provider using your .env keys and prints
 * a summary. Redacted responses are saved under fixtures/live/ so the team can build exact
 * parsers. Run on a machine with network access:  pnpm smoke:live [area...]
 */
import { readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { config as loadDotenv } from "dotenv";

loadDotenv({ path: fileURLToPath(new URL("../.env", import.meta.url)) });
process.env.DB_DRIVER ??= "memory";
process.env.JOB_DISPATCH = "inline";
process.env.STORAGE_DRIVER = "local";

const { createPlatform } = await import("@muselaunch/platform");
const p = createPlatform();
const dir = fileURLToPath(new URL("./smoke/", import.meta.url));
const only = process.argv.slice(2);
const files = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.startsWith("_") && (!only.length || only.some((o) => f.includes(o))));
let failed = 0;
for (const f of files) {
  const mod = (await import(pathToFileURL(dir + f).href)) as { run: (p: unknown) => Promise<string> };
  const started = Date.now();
  try {
    const summary = await mod.run(p);
    console.log(`✅ ${f.replace(".ts", "")} (${Date.now() - started} ms): ${summary}`);
  } catch (err) {
    failed++;
    const e = err as { code?: string; message?: string };
    console.log(`❌ ${f.replace(".ts", "")}: ${e.code ?? ""} ${e.message ?? err}`);
  }
}
process.exit(failed ? 1 : 0);
