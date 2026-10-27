// Copies the HyperFrames player runtime into public/vendor so previews never depend on a CDN.
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, "..", "package.json"));
const coreDir = dirname(require.resolve("@hyperframes/core/package.json"));
const out = join(here, "..", "public", "vendor");
mkdirSync(out, { recursive: true });
copyFileSync(join(coreDir, "dist", "hyperframe.runtime.iife.js"), join(out, "hyperframe.runtime.iife.js"));
console.log("vendored hyperframe.runtime.iife.js");
