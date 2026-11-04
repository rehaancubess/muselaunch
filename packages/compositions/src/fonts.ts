/**
 * The typefaces MuseLaunch bundles for rendering (all SIL Open Font License, from @fontsource-variable;
 * embedded as data URLs, never fetched). Inter is the default for body text and UI; the display faces
 * are for headlines. Muse Spark picks one per video from this list (storyboard `typeface`); a brand
 * kit's own heading font wins when it is one of them.
 *
 * `widthFactor` is the face's average glyph width relative to Inter at headline weights (measured in
 * Chromium on mixed-case English), so text fitting keeps a display face inside its box.
 */

export interface BundledFont {
  /** Name as stored in Theme.headingFont / brand kits. */
  name: string;
  /** CSS family registered by the @font-face rules. */
  cssFamily: string;
  /** @fontsource-variable package (Node loader) and file prefix. */
  pkg: string;
  file: string;
  /** Supported weight range (variable axis). */
  weights: [number, number];
  widthFactor: number;
  /** What it suits (shown to Muse Spark). */
  mood: string;
}

export const BUNDLED_FONTS: readonly BundledFont[] = [
  { name: "Inter", cssFamily: "Inter Variable", pkg: "@fontsource-variable/inter", file: "inter", weights: [100, 900], widthFactor: 1, mood: "neutral, precise, Apple-like (the default)" },
  { name: "Plus Jakarta Sans", cssFamily: "Plus Jakarta Sans Variable", pkg: "@fontsource-variable/plus-jakarta-sans", file: "plus-jakarta-sans", weights: [200, 800], widthFactor: 1.04, mood: "modern, friendly SaaS and productivity" },
  { name: "Space Grotesk", cssFamily: "Space Grotesk Variable", pkg: "@fontsource-variable/space-grotesk", file: "space-grotesk", weights: [300, 700], widthFactor: 1.05, mood: "technical, developer tools, crypto, data" },
  { name: "Bricolage Grotesque", cssFamily: "Bricolage Grotesque Variable", pkg: "@fontsource-variable/bricolage-grotesque", file: "bricolage-grotesque", weights: [200, 800], widthFactor: 1.07, mood: "expressive, playful, creator and lifestyle apps" },
  { name: "Sora", cssFamily: "Sora Variable", pkg: "@fontsource-variable/sora", file: "sora", weights: [100, 800], widthFactor: 1.11, mood: "geometric, futuristic, AI and fintech" },
  { name: "Fraunces", cssFamily: "Fraunces Variable", pkg: "@fontsource-variable/fraunces", file: "fraunces", weights: [100, 900], widthFactor: 1.08, mood: "editorial serif, warm and premium: journaling, reading, food, wellness" },
  { name: "Manrope", cssFamily: "Manrope Variable", pkg: "@fontsource-variable/manrope", file: "manrope", weights: [200, 800], widthFactor: 1.04, mood: "rounded, calm, health and family apps" },
];

export const TYPEFACE_NAMES = BUNDLED_FONTS.map((f) => f.name) as [string, ...string[]];

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+variable$/, "");

/** The bundled font for a theme/brand font name (case-insensitive), or undefined when we don't ship it. */
export function bundledFont(name: string | undefined): BundledFont | undefined {
  if (!name) return undefined;
  const k = norm(name);
  return BUNDLED_FONTS.find((f) => norm(f.name) === k || norm(f.cssFamily) === k);
}

/** Width factor for text fitting (1 = Inter; unknown fonts render as Inter). */
export function fontWidthFactor(name: string | undefined): number {
  return bundledFont(name)?.widthFactor ?? 1;
}

/** Clamp a weight into the face's variable range. */
export function fontWeight(name: string | undefined, weight: number): number {
  const f = bundledFont(name);
  return f ? Math.max(f.weights[0], Math.min(f.weights[1], weight)) : weight;
}
