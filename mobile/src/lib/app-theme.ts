/**
 * The interface colour follows the app: an app's `theme.color` (picked from its icon by App DNA, or
 * set by the person on About your app on the web) drives the accents. No colour, or a grey one →
 * monochrome (graphite). The phone only reads it.
 *
 * The colour maths is copied from packages/contracts/src/theme.ts (`themeTokens`), because the phone
 * app is built on its own (EAS uploads only mobile/). Keep the two in step. The one difference: the
 * web's gradient is a CSS string; here it's its three stops (light → base → dark).
 */
import type { App } from "../api/types";

export interface Accent {
  /** The colour the shades were made from (null = monochrome). */
  color: string | null;
  /** Buttons, links, selected tabs. White text on it and it on white are ≥ 4.8:1. */
  accent: string;
  accentHover: string;
  /** Tinted background for selected items; `accent` on it is ≥ 4.5:1. */
  accentSoft: string;
  /** Text on `accentSoft`. */
  accentInk: string;
  /** The logo's gradient (light → base → dark). */
  gradient: readonly [string, string, string];
}

export const MONOCHROME: Accent = {
  color: null,
  accent: "#1d1d1f",
  accentHover: "#000000",
  accentSoft: "#f0f0f2",
  accentInk: "#1d1d1f",
  gradient: ["#5a5a60", "#1d1d1f", "#000000"],
};

type Rgb = [number, number, number];

function parseHex(hex: string | null | undefined): Rgb | null {
  if (!hex) return null;
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(hex.trim());
  if (!m) return null;
  const h = m[1]!.length === 3 ? [...m[1]!].map((c) => c + c).join("") : m[1]!;
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as Rgb;
}

const toHex = ([r, g, b]: Rgb) => "#" + [r, g, b].map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0")).join("");

function rgbToHsl([r, g, b]: Rgb): [number, number, number] {
  const [R, G, B] = [r / 255, g / 255, b / 255];
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === R ? (G - B) / d + (G < B ? 6 : 0) : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  return [h * 60, s, l];
}

function hslToRgb(h: number, s: number, l: number): Rgb {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}

const hsl = (h: number, s: number, l: number) => toHex(hslToRgb(h, s, Math.min(1, Math.max(0, l))));

function luminance([r, g, b]: Rgb): number {
  const c = (v: number) => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * c(r) + 0.7152 * c(g) + 0.0722 * c(b);
}

/** WCAG contrast ratio between two hex colours. */
export function contrastRatio(a: string, b: string): number {
  const [x, y] = [parseHex(a), parseHex(b)];
  if (!x || !y) return 1;
  const [l1, l2] = [luminance(x), luminance(y)].sort((p, q) => q - p) as [number, number];
  return (l1 + 0.05) / (l2 + 0.05);
}

/** True for a colour with enough hue to theme with (not grey, near-black or near-white). */
export function isThemeable(hex: string | null | undefined): boolean {
  const rgb = parseHex(hex);
  if (!rgb) return false;
  const [, s, l] = rgbToHsl(rgb);
  return s >= 0.18 && l > 0.06 && l < 0.97;
}

/** Interface shades for an app colour (same rules as the web: keep the hue, darken only as needed for WCAG AA). */
export function themeTokens(color: string | null | undefined): Accent {
  const rgb = parseHex(color);
  if (!rgb || !isThemeable(color)) return MONOCHROME;
  const [h, s0, l0] = rgbToHsl(rgb);
  const s = Math.min(s0, 0.95);
  const accentSoft = hsl(h, Math.min(s, 0.85), 0.965);
  let l = l0;
  while (l > 0.04 && (contrastRatio(hsl(h, s, l), "#ffffff") < 4.8 || contrastRatio(hsl(h, s, l), accentSoft) < 4.5)) l -= 0.01;
  const accent = hsl(h, s, l);
  return {
    color: toHex(rgb),
    accent,
    accentHover: hsl(h, s, Math.max(l - 0.07, 0.03)),
    accentSoft,
    accentInk: hsl(h, s, Math.max(l - 0.12, 0.03)),
    gradient: [hsl(h, s, Math.min(l + 0.14, 0.78)), accent, hsl(h, s, Math.max(l - 0.1, 0.03))],
  };
}

const cache = new Map<string, Accent>();

/** The open app's accent: its colour's shades, or monochrome (no app, no colour, or a grey one). */
export function themeFor(app: Pick<App, "theme"> | null | undefined): Accent {
  const c = app?.theme?.color;
  if (!c) return MONOCHROME;
  let t = cache.get(c);
  if (!t) {
    t = themeTokens(c);
    cache.set(c, t);
  }
  return t;
}
