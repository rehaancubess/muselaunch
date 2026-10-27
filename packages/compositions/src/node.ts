/**
 * Node-only helpers (`@muselaunch/compositions/node`): load GSAP and the bundled Inter
 * variable font from node_modules and register them for `compileToHtml`.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { registerCompileRuntime } from "./runtime";

const require = createRequire(import.meta.url);
let loaded = false;

/** Subsets we embed (Inter covers Latin, Cyrillic, Greek, Vietnamese). */
const FONT_SUBSETS = ["latin", "latin-ext"] as const;

export function loadGsapSource(): string {
  return readFileSync(require.resolve("gsap/dist/gsap.min.js"), "utf8");
}

export function loadInterFontCss(): string {
  const dir = dirname(require.resolve("@fontsource-variable/inter/opsz.css"));
  const css = readFileSync(join(dir, "opsz.css"), "utf8");
  const blocks = css.split("@font-face").slice(1);
  const out: string[] = [];
  for (const b of blocks) {
    const file = /url\(\.\/files\/([^)]+)\)/.exec(b)?.[1];
    if (!file || !FONT_SUBSETS.some((s) => file === `inter-${s}-opsz-normal.woff2`)) continue;
    const data = readFileSync(join(dir, "files", file)).toString("base64");
    const range = /unicode-range:([^;]+);/.exec(b)?.[1]?.trim();
    out.push(
      `@font-face{font-family:'Inter Variable';font-style:normal;font-display:block;font-weight:100 900;src:url(data:font/woff2;base64,${data}) format('woff2');${range ? `unicode-range:${range};` : ""}}`,
    );
  }
  return out.join("\n");
}

/** Idempotent: register inline GSAP + Inter for compileToHtml in this process. */
export function ensureNodeCompileRuntime(): void {
  if (loaded) return;
  registerCompileRuntime({ gsap: loadGsapSource(), fontCss: loadInterFontCss() });
  loaded = true;
}
