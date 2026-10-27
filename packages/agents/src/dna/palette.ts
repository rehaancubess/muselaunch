import sharp from "sharp";

export interface Swatch {
  hex: string;
  r: number;
  g: number;
  b: number;
  share: number;
  sat: number;
  lum: number;
}

type Role = "primary" | "secondary" | "accent" | "background" | "text" | "other";

const toHex = (r: number, g: number, b: number) => `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`.toUpperCase();

function hsl(r: number, g: number, b: number): { sat: number; lum: number } {
  const R = r / 255;
  const G = g / 255;
  const B = b / 255;
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const lum = (max + min) / 2;
  const d = max - min;
  const sat = d === 0 ? 0 : d / (1 - Math.abs(2 * lum - 1));
  return { sat, lum };
}

function relLum({ r, g, b }: { r: number; g: number; b: number }): number {
  const f = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

export function contrast(a: Swatch, b: Swatch): number {
  const [x, y] = [relLum(a), relLum(b)].sort((m, n) => n - m) as [number, number];
  return (x + 0.05) / (y + 0.05);
}

const dist = (a: Swatch, b: Swatch) => Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b);

/** Dominant colours of an image: 64px downsample, 4-bit-per-channel buckets, averaged. */
export async function dominantColors(buf: Buffer, max = 8): Promise<Swatch[]> {
  const { data, info } = await sharp(buf).resize(64, 64, { fit: "inside" }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const buckets = new Map<number, { n: number; r: number; g: number; b: number }>();
  let total = 0;
  for (let i = 0; i < data.length; i += info.channels) {
    const a = data[i + 3]!;
    if (a < 128) continue;
    const r = data[i]!;
    const g = data[i + 1]!;
    const b = data[i + 2]!;
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const s = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    s.n++;
    s.r += r;
    s.g += g;
    s.b += b;
    buckets.set(key, s);
    total++;
  }
  if (!total) return [];
  const raw = [...buckets.values()]
    .sort((x, y) => y.n - x.n)
    .map((s) => {
      const r = s.r / s.n;
      const g = s.g / s.n;
      const b = s.b / s.n;
      return { hex: toHex(r, g, b), r, g, b, share: s.n / total, ...hsl(r, g, b) };
    });
  // Merge perceptually close buckets.
  const merged: Swatch[] = [];
  for (const s of raw) {
    const near = merged.find((m) => dist(m, s) < 40);
    if (near) near.share += s.share;
    else merged.push({ ...s });
    if (merged.length >= max * 3) break;
  }
  return merged.sort((x, y) => y.share - x.share).slice(0, max);
}

const isVivid = (s: Swatch) => s.sat > 0.28 && s.lum > 0.12 && s.lum < 0.88;

/**
 * Deterministic brand palette from the real icon (brand colours) and real screenshots (UI
 * background/text/accent). Pure image statistics — no model involved.
 */
export function buildPalette(icon: Swatch[], screens: Swatch[]): { hex: string; role: Role }[] {
  const out: { hex: string; role: Role }[] = [];
  const used: Swatch[] = [];
  const push = (s: Swatch | undefined, role: Role) => {
    if (!s || used.some((u) => dist(u, s) < 48)) return;
    used.push(s);
    out.push({ hex: s.hex, role });
  };
  const iconVivid = icon.filter(isVivid);
  push(iconVivid[0] ?? icon[0], "primary");
  push(iconVivid[1], "secondary");
  const bg = screens[0];
  if (bg) {
    push(bg, "background");
    const text = screens.filter((s) => s !== bg && s.share > 0.005).sort((x, y) => contrast(y, bg) - contrast(x, bg))[0];
    if (text && contrast(text, bg) >= 3) push(text, "text");
  }
  const accent = [...screens.filter(isVivid)].sort((x, y) => y.sat * Math.sqrt(y.share) - x.sat * Math.sqrt(x.share))[0];
  push(accent, "accent");
  for (const s of [...iconVivid.slice(2), ...screens.filter(isVivid)]) {
    if (out.length >= 8) break;
    push(s, "other");
  }
  return out;
}

export async function paletteFromImages(iconBuf: Buffer | undefined, screenBufs: Buffer[]): Promise<{ hex: string; role: Role }[]> {
  const icon = iconBuf ? await dominantColors(iconBuf).catch(() => []) : [];
  const shares = new Map<string, Swatch>();
  for (const b of screenBufs.slice(0, 6)) {
    for (const s of await dominantColors(b).catch(() => [] as Swatch[])) {
      const near = [...shares.values()].find((m) => dist(m, s) < 40);
      if (near) near.share += s.share / screenBufs.length;
      else shares.set(s.hex, { ...s, share: s.share / screenBufs.length });
    }
  }
  const screens = [...shares.values()].sort((x, y) => y.share - x.share);
  return buildPalette(icon, screens);
}
