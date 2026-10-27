import type { ColorValue, Theme } from "@muselaunch/contracts";

/**
 * Colour maths for the deterministic Brand Guardian rules: theme-token resolution, WCAG 2.x
 * contrast and perceptual distance (CIEDE2000 in CIELAB, D65).
 */
export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

export function parseHex(hex: string): Rgba | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(hex.trim());
  if (!m) return null;
  let h = m[1]!;
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
  return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 };
}

export function toHex(c: Pick<Rgba, "r" | "g" | "b">): string {
  const x = (v: number) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0");
  return `#${x(c.r)}${x(c.g)}${x(c.b)}`.toUpperCase();
}

/** Normalised #RRGGBB (alpha dropped), or null. */
export function normHex(hex: string): string | null {
  const c = parseHex(hex);
  return c ? toHex(c) : null;
}

const TOKENS = { "theme.background": "background", "theme.surface": "surface", "theme.text": "text", "theme.textMuted": "textMuted", "theme.accent": "accent", "theme.accent2": "accent2" } as const;

/** Resolve a hex or theme token against the composition theme. */
export function resolveColor(value: ColorValue | undefined, theme: Theme, fallback: keyof typeof TOKENS = "theme.text"): string {
  const v = value ?? fallback;
  if (v in TOKENS) {
    const key = TOKENS[v as keyof typeof TOKENS];
    return (theme[key] as string | undefined) ?? theme.accent;
  }
  return v;
}

export const isThemeToken = (v: string): v is keyof typeof TOKENS => v in TOKENS;

/** Alpha-composite `top` over an opaque `bottom`. */
export function over(top: Rgba, bottom: Rgba): Rgba {
  const a = top.a;
  return { r: top.r * a + bottom.r * (1 - a), g: top.g * a + bottom.g * (1 - a), b: top.b * a + bottom.b * (1 - a), a: 1 };
}

const lin = (v: number) => {
  const s = v / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};

/** WCAG relative luminance. */
export function luminance(c: Pick<Rgba, "r" | "g" | "b">): number {
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

/** WCAG 2.x contrast ratio (1..21). */
export function contrastRatio(a: Pick<Rgba, "r" | "g" | "b">, b: Pick<Rgba, "r" | "g" | "b">): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export interface Lab {
  L: number;
  a: number;
  b: number;
}

export function toLab(c: Pick<Rgba, "r" | "g" | "b">): Lab {
  const R = lin(c.r);
  const G = lin(c.g);
  const B = lin(c.b);
  // sRGB D65 → XYZ, normalised by the D65 white point.
  const X = (0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / 0.95047;
  const Y = 0.2126729 * R + 0.7151522 * G + 0.072175 * B;
  const Z = (0.0193339 * R + 0.119192 * G + 0.9503041 * B) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const fx = f(X);
  const fy = f(Y);
  const fz = f(Z);
  return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

/** CIEDE2000 colour difference (≈1 just noticeable, >10 clearly different, >25 different colour). */
export function deltaE2000(x: Lab, y: Lab): number {
  const C1 = Math.hypot(x.a, x.b);
  const C2 = Math.hypot(y.a, y.b);
  const Cm = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cm ** 7 / (Cm ** 7 + 25 ** 7)));
  const a1 = (1 + G) * x.a;
  const a2 = (1 + G) * y.a;
  const C1p = Math.hypot(a1, x.b);
  const C2p = Math.hypot(a2, y.b);
  const h = (b: number, a: number) => {
    if (a === 0 && b === 0) return 0;
    const v = deg(Math.atan2(b, a));
    return v >= 0 ? v : v + 360;
  };
  const h1 = h(x.b, a1);
  const h2 = h(y.b, a2);
  const dL = y.L - x.L;
  const dC = C2p - C1p;
  let dh = 0;
  if (C1p * C2p !== 0) {
    dh = h2 - h1;
    if (dh > 180) dh -= 360;
    else if (dh < -180) dh += 360;
  }
  const dH = 2 * Math.sqrt(C1p * C2p) * Math.sin(rad(dh / 2));
  const Lm = (x.L + y.L) / 2;
  const Cmp = (C1p + C2p) / 2;
  let hm = h1 + h2;
  if (C1p * C2p !== 0) {
    if (Math.abs(h1 - h2) > 180) hm = h1 + h2 < 360 ? (h1 + h2 + 360) / 2 : (h1 + h2 - 360) / 2;
    else hm = (h1 + h2) / 2;
  }
  const T = 1 - 0.17 * Math.cos(rad(hm - 30)) + 0.24 * Math.cos(rad(2 * hm)) + 0.32 * Math.cos(rad(3 * hm + 6)) - 0.2 * Math.cos(rad(4 * hm - 63));
  const dTheta = 30 * Math.exp(-(((hm - 275) / 25) ** 2));
  const Rc = 2 * Math.sqrt(Cmp ** 7 / (Cmp ** 7 + 25 ** 7));
  const Sl = 1 + (0.015 * (Lm - 50) ** 2) / Math.sqrt(20 + (Lm - 50) ** 2);
  const Sc = 1 + 0.045 * Cmp;
  const Sh = 1 + 0.015 * Cmp * T;
  const Rt = -Math.sin(rad(2 * dTheta)) * Rc;
  return Math.sqrt((dL / Sl) ** 2 + (dC / Sc) ** 2 + (dH / Sh) ** 2 + Rt * (dC / Sc) * (dH / Sh));
}

export function colorDistance(a: string, b: string): number {
  const x = parseHex(a);
  const y = parseHex(b);
  if (!x || !y) return Number.POSITIVE_INFINITY;
  return deltaE2000(toLab(x), toLab(y));
}

/** Low-chroma colours (whites, greys, near-black) are neutral and always on-brand. */
export function isNeutral(hex: string): boolean {
  const c = parseHex(hex);
  if (!c) return false;
  const lab = toLab(c);
  return Math.hypot(lab.a, lab.b) < 8;
}
