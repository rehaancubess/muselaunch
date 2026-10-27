import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { redactForTrace } from "@muselaunch/platform";

/** Save a redacted live response for parser development (fixtures/live/<name>.json). */
export function saveLive(name: string, data: unknown) {
  const dir = fileURLToPath(new URL("../../fixtures/live/", import.meta.url));
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}${name}.json`, JSON.stringify({ capturedAt: new Date().toISOString(), live: true, data: redactForTrace(data) }, null, 2));
}
