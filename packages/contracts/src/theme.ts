import { z } from "zod";
import { HexColor } from "./common";

/**
 * Per-app interface colour. MuseLaunch is monochrome until an app is added. After that, the
 * interface takes the app's own colour: App DNA picks it from the real app icon (`source: "icon"`),
 * or the person picks one on About your app (`source: "custom"`). `color: null` means monochrome.
 * Clients turn the colour into shades with `themeTokens`, which keeps text and buttons at WCAG AA.
 */
export const AppTheme = z.object({
  color: HexColor.nullable(),
  source: z.enum(["icon", "custom"]),
});
export type AppTheme = z.infer<typeof AppTheme>;

export interface ThemeTokens {
  /** The colour the shades were made from (null = monochrome). */
  color: string | null;
  /** Buttons, links, selected tabs. White text on it and it on white are ≥ 4.8:1. */
  accent: string;
  accentHover: string;
  /** Tinted background for selected items; `accent` on it is ≥ 4.5:1. */
  accentSoft: string;
  /** Text on `accentSoft`. */
  accentInk: string;
  /** Logo mark / app icon gradient. */
  gradient: string;
  /** Focus ring colour. */
  focus: string;
}

export const MONOCHROME_THEME: ThemeTokens = {
  color: null,
  accent: "#1d1d1f",
  accentHover: "#000000",
  accentSoft: "#f0f0f2",
  accentInk: "#1d1d1f",
  gradient: "linear-gradient(145deg, #5a5a60 0%, #1d1d1f 52%, #000000 100%)",
  focus: "rgb(29 29 31 / 0.22)",
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

/** Normalise to lower-case #rrggbb (drops alpha); null when it isn't a colour. */
export function normalizeHex(hex: string | null | undefined): string | null {
  const rgb = parseHex(hex);
  return rgb ? toHex(rgb) : null;
}

/**
 * The colour to theme an app with, from its App DNA palette (icon colours first). Null when the
 * icon has no usable hue (a black-and-white icon stays monochrome).
 */
export function pickThemeColor(palette: { hex: string; role: string }[] | undefined): string | null {
  const order = ["primary", "secondary", "accent", "other"];
  const ranked = [...(palette ?? [])].filter((p) => order.includes(p.role)).sort((a, b) => order.indexOf(a.role) - order.indexOf(b.role));
  const hit = ranked.find((p) => isThemeable(p.hex));
  return hit ? normalizeHex(hit.hex) : null;
}

/**
 * Interface shades for an app colour. Keeps the hue and darkens only as much as needed so white
 * button text, links on white and selected tabs on the tint all pass WCAG AA. Greys and missing
 * colours give the monochrome theme.
 */
export function themeTokens(color: string | null | undefined): ThemeTokens {
  const rgb = parseHex(color);
  if (!rgb || !isThemeable(color)) return MONOCHROME_THEME;
  const [h, s0, l0] = rgbToHsl(rgb);
  const s = Math.min(s0, 0.95);
  const accentSoft = hsl(h, Math.min(s, 0.85), 0.965);
  let l = l0;
  while (l > 0.04 && (contrastRatio(hsl(h, s, l), "#ffffff") < 4.8 || contrastRatio(hsl(h, s, l), accentSoft) < 4.5)) l -= 0.01;
  const accent = hsl(h, s, l);
  const [r, g, b] = parseHex(accent)!;
  return {
    color: toHex(rgb),
    accent,
    accentHover: hsl(h, s, Math.max(l - 0.07, 0.03)),
    accentSoft,
    accentInk: hsl(h, s, Math.max(l - 0.12, 0.03)),
    gradient: `linear-gradient(145deg, ${hsl(h, s, Math.min(l + 0.14, 0.78))} 0%, ${accent} 52%, ${hsl(h, s, Math.max(l - 0.1, 0.03))} 100%)`,
    focus: `rgb(${r} ${g} ${b} / 0.28)`,
  };
}
