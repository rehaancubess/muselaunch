/**
 * Node-only helpers (`@muselaunch/compositions/node`): load GSAP, the bundled Inter variable font and
 * the display faces of BUNDLED_FONTS from node_modules and register them for `compileToHtml`.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { BUNDLED_FONTS } from "./fonts";
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

/** `@font-face` CSS (latin + latin-ext, variable weight axis) of one bundled display face. */
export function loadBundledFontCss(name: string): string | undefined {
  const f = BUNDLED_FONTS.find((x) => x.name === name);
  if (!f) return undefined;
  let dir: string;
  try {
    dir = dirname(require.resolve(`${f.pkg}/index.css`));
  } catch {
    return undefined;
  }
  const out: string[] = [];
  for (const subset of FONT_SUBSETS) {
    const file = `${f.file}-${subset}-wght-normal.woff2`;
    const css = readFileSync(join(dir, "index.css"), "utf8");
    const block = css.split("@font-face").find((b) => b.includes(`./files/${file}`));
    if (!block) continue;
    const data = readFileSync(join(dir, "files", file)).toString("base64");
    const range = /unicode-range:([^;]+);/.exec(block)?.[1]?.trim();
    out.push(`@font-face{font-family:'${f.cssFamily}';font-style:normal;font-display:block;font-weight:${f.weights[0]} ${f.weights[1]};src:url(data:font/woff2;base64,${data}) format('woff2');${range ? `unicode-range:${range};` : ""}}`);
  }
  return out.length ? out.join("\n") : undefined;
}

/** Idempotent: register inline GSAP + Inter + the bundled display faces for compileToHtml in this process. */
export function ensureNodeCompileRuntime(): void {
  if (loaded) return;
  const fonts: Record<string, string> = {};
  for (const f of BUNDLED_FONTS) {
    if (f.name === "Inter") continue;
    const css = loadBundledFontCss(f.name);
    if (css) fonts[f.name] = css;
  }
  registerCompileRuntime({ gsap: loadGsapSource(), fontCss: loadInterFontCss(), fonts });
  loaded = true;
}
