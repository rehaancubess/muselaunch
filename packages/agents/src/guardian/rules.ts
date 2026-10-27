import type { BrandFinding, BrandProfile, Channel, Claim, CompositionDoc, Layer, PatchOp, Scene, Theme } from "@muselaunch/contracts";
import { applyPatch, PatchError, totalDuration } from "@muselaunch/compositions";
import { CHANNEL_RULES } from "../copy";
import { unsupportedSpecifics } from "../claims";
import { clip, jaccard, normalizeText } from "../util";
import { colorDistance, contrastRatio, deltaE2000, isNeutral, isThemeToken, normHex, over, parseHex, resolveColor, toLab, type Rgba } from "./color";
import type { LoadedSubject, SubjectText } from "./subject";

/**
 * Deterministic Brand Guardian rules. Always run (with or without Muse Glimmer), never call a
 * model, and only report what they can verify from the brand kit, the claim library, the
 * composition document and the platform tables below. Suggested ops are validated with applyPatch.
 */

/** Finding before an id is assigned; `fingerprint` identifies "the same issue" across versions (learning). */
export type DraftFinding = Omit<BrandFinding, "id" | "evidence"> & { evidence: { preferenceIds: string[]; claimIds: string[]; guideline?: string }; fingerprint: string };

export interface BrandContext {
  appName: string;
  brand: BrandProfile | null;
  verifiedClaims: Claim[];
  /** Every claim referenced by the subject (any state). */
  claimsById: Map<string, Claim>;
  /** Verified claims + verified listing evidence: what figures/superlatives may rest on. */
  supportText: string;
  /** Remembered "Do not claim" constraints (brandPreferences). */
  constraints: { preferenceId: string; phrase: string }[];
}

export const fingerprintOf = (key: string, quote: string | undefined, fallback: string) => `${key}|${normalizeText(quote ?? fallback).slice(0, 160)}`;

/** Templates where on-screen media must be real product media. */
const PRODUCT_TEMPLATES = new Set(["device-demo", "feature-callout", "before-after", "product-in-hand", "object-spotlight"]);
const PROOF_TEMPLATES = new Set(["quote-proof", "stat-card"]);

/** Accepted aspect ratios and durations (seconds) per channel for short-form video. */
export const PLATFORM_VIDEO: Partial<Record<Channel, { aspects: CompositionDoc["aspectRatio"][]; maxSec: number; idealSec?: number; label: string }>> = {
  tiktok: { aspects: ["9:16"], maxSec: 600, idealSec: 60, label: "TikTok" },
  instagram: { aspects: ["9:16", "4:5", "1:1"], maxSec: 180, idealSec: 90, label: "Instagram Reels" },
  youtube: { aspects: ["9:16", "16:9"], maxSec: 43_200, label: "YouTube" },
  facebook: { aspects: ["9:16", "4:5", "1:1", "16:9"], maxSec: 240, idealSec: 90, label: "Facebook" },
  x: { aspects: ["16:9", "1:1", "9:16", "4:5"], maxSec: 140, label: "X" },
  threads: { aspects: ["9:16", "4:5", "1:1"], maxSec: 300, label: "Threads" },
  linkedin: { aspects: ["1:1", "4:5", "16:9", "9:16"], maxSec: 600, idealSec: 90, label: "LinkedIn" },
};

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const PHONE = /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?)?\d{3,4}[\s.-]\d{3,4}(?:[\s.-]\d{2,4})?/;

function draft(f: Omit<DraftFinding, "evidence" | "fingerprint"> & { evidence?: Partial<DraftFinding["evidence"]>; fingerprint?: string }): DraftFinding {
  return {
    ...f,
    message: clip(f.message, 600),
    suggestion: f.suggestion ? clip(f.suggestion, 600) : undefined,
    quote: f.quote ? clip(f.quote, 300) : undefined,
    evidence: { preferenceIds: f.evidence?.preferenceIds ?? [], claimIds: f.evidence?.claimIds ?? [], guideline: f.evidence?.guideline ? clip(f.evidence.guideline, 400) : undefined },
    fingerprint: f.fingerprint ?? fingerprintOf(f.rule ?? f.category, f.quote, f.message),
  };
}

/** Keep only ops that apply cleanly to the reviewed document (atomic: one bad op drops the fix). */
export function validOps(doc: CompositionDoc | undefined, ops: PatchOp[]): PatchOp[] | undefined {
  if (!doc || !ops.length) return undefined;
  try {
    applyPatch(doc, ops);
    return ops;
  } catch (err) {
    if (err instanceof PatchError) return undefined;
    throw err;
  }
}

const wordRe = (w: string) => new RegExp(`(^|[^\\p{L}\\p{N}])${w.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+")}(?=$|[^\\p{L}\\p{N}])`, "iu");

// ---------------------------------------------------------------------------
// Copy rules (every subject)
// ---------------------------------------------------------------------------

function copyRules(s: LoadedSubject, b: BrandContext, out: DraftFinding[]) {
  const prohibited = (b.brand?.prohibitedClaims ?? []).map((x) => x.trim()).filter(Boolean);
  const avoid = (b.brand?.tone.vocabularyAvoid ?? []).map((x) => x.trim()).filter(Boolean);
  for (const t of s.texts) {
    const norm = normalizeText(t.text);
    for (const pc of prohibited) {
      if (!normalizeText(pc) || !norm.includes(normalizeText(pc))) continue;
      out.push(draft({ severity: "block", category: "prohibited", rule: "prohibited.claim", message: `Uses a prohibited claim from your brand kit: "${pc}".`, quote: pc, location: t.where, suggestion: "Remove or rephrase this claim; your brand kit says it must never be used.", source: "rules", evidence: { guideline: "Brand kit · prohibited claims" } }));
    }
    for (const c of b.constraints) {
      if (!normalizeText(c.phrase) || !norm.includes(normalizeText(c.phrase))) continue;
      if (prohibited.some((pc) => normalizeText(pc) === normalizeText(c.phrase))) continue;
      out.push(draft({ severity: "block", category: "prohibited", rule: "prohibited.remembered", message: `Your team decided not to claim "${c.phrase}".`, quote: c.phrase, location: t.where, suggestion: "Remove this claim or ask the team to lift the constraint in App DNA → Memory.", source: "rules", evidence: { preferenceIds: [c.preferenceId] } }));
    }
    for (const w of avoid) {
      if (!wordRe(w).test(t.text)) continue;
      out.push(draft({ severity: "warn", category: "tone", rule: "tone.avoided_word", message: `"${w}" is on your brand's avoid list.`, quote: w, location: t.where, suggestion: `Rephrase without "${w}"${b.brand?.tone.voice.length ? ` and keep the ${b.brand.tone.voice.join(", ")} voice` : ""}.`, source: "rules", evidence: { guideline: "Brand kit · vocabulary to avoid" } }));
    }
    // Figures and superlatives must literally appear in verified claims / verified listing evidence.
    const linked = t.claimIds.map((id) => b.claimsById.get(id)).filter((c): c is Claim => c?.state === "verified");
    for (const issue of unsupportedSpecifics(t.text, `${b.supportText}\n${linked.map((c) => c.text).join("\n")}`)) {
      const m = /^"(.+?)" is a (specific figure|superlative)/.exec(issue);
      const quote = m?.[1];
      const figure = m?.[2] === "specific figure";
      out.push(
        draft({
          severity: figure ? "block" : "warn",
          category: "claim",
          rule: figure ? "claim.unverified_figure" : "claim.unverified_superlative",
          message: figure ? `"${quote}" is a specific figure that no verified claim supports.` : `"${quote}" is a superlative that no verified claim supports.`,
          quote,
          location: t.where,
          suggestion: figure ? "Remove the number, or add and verify a claim with its source in App DNA." : "Use a concrete, verified benefit instead of a superlative.",
          source: "rules",
        }),
      );
    }
    for (const id of t.claimIds) {
      const c = b.claimsById.get(id);
      if (c?.state === "verified") continue;
      out.push(
        draft({
          severity: "block",
          category: "claim",
          rule: "claim.unverified_link",
          message: c ? `Linked claim "${clip(c.text, 80)}" is ${c.state.replace("_", " ")}, not verified.` : `Linked claim ${id} doesn't exist in this app's claim library.`,
          quote: c?.text,
          location: t.where,
          suggestion: "Verify the claim in App DNA or remove it from this text.",
          source: "rules",
          evidence: { claimIds: c ? [c.id] : [] },
          fingerprint: `claim.unverified_link|${id}`,
        }),
      );
    }
    if (s.ref.entity !== "outreachDrafts") {
      const email = EMAIL.exec(t.text)?.[0];
      const phone = email ? undefined : PHONE.exec(t.text)?.[0];
      const pii = email ?? (phone && phone.replace(/\D/g, "").length >= 9 ? phone : undefined);
      if (pii) out.push(draft({ severity: "warn", category: "privacy", rule: "privacy.contact_details", message: `Public copy contains contact details ("${pii}").`, quote: pii, location: t.where, suggestion: "Use a link or [APP_LINK] instead of personal contact details in public posts.", source: "rules" }));
    }
  }
  // Channel length limits (publishing copy only; on-screen text has its own reading-time rule).
  for (const ch of s.copyPack || s.post ? s.channels : []) {
    const rules = CHANNEL_RULES[ch];
    if (!rules) continue;
    for (const t of s.texts) {
      const kind = s.post ? (t.kind === "caption" ? "caption" : t.kind === "title" ? "title" : t.kind === "hashtags" ? "hashtags" : undefined) : t.kind;
      const max = kind ? rules.limits[kind as keyof typeof rules.limits] : undefined;
      if (max && t.text.length > max)
        out.push(draft({ severity: "warn", category: "platform_fit", rule: "platform.length", message: `${t.kind} is ${t.text.length} characters; ${ch} allows ${max}.`, location: t.where, suggestion: `Shorten to ≤ ${max} characters.`, source: "rules", fingerprint: `platform.length|${ch}|${t.kind}` }));
    }
  }
  // CTA consistency on CTA copy items.
  const preferred = b.brand?.preferredCtas ?? [];
  if (preferred.length) {
    for (const t of s.texts.filter((x) => x.kind === "cta")) {
      if (ctaMatches(t.text, preferred)) continue;
      out.push(draft({ severity: "info", category: "cta", rule: "cta.off_preferred", message: `CTA "${clip(t.text, 80)}" differs from your preferred CTAs.`, quote: t.text, location: t.where, suggestion: `Consider "${closestCta(t.text, preferred)}".`, source: "rules", evidence: { guideline: `Preferred CTAs: ${preferred.join(" | ")}` } }));
    }
  }
}

function ctaMatches(text: string, preferred: string[]): boolean {
  const n = normalizeText(text);
  return preferred.some((p) => {
    const q = normalizeText(p);
    return !!q && (n === q || n.includes(q) || q.includes(n) || jaccard(text, p) >= 0.5);
  });
}

const closestCta = (text: string, preferred: string[]) => [...preferred].sort((a, b) => jaccard(text, b) - jaccard(text, a))[0]!;

// ---------------------------------------------------------------------------
// Composition rules
// ---------------------------------------------------------------------------

type TextLayer = Extract<Layer, { type: "text" }>;

function chromaticDistance(a: string, b: string): number {
  const x = parseHex(a);
  const y = parseHex(b);
  if (!x || !y) return Number.POSITIVE_INFINITY;
  const lx = toLab(x);
  const ly = toLab(y);
  const L = (lx.L + ly.L) / 2;
  // Tints and shades of a brand hue are on-brand: compare hue + chroma at equal lightness.
  return deltaE2000({ ...lx, L }, { ...ly, L });
}

function nearestBrandColor(hex: string, palette: string[]): string {
  return [...palette].sort((a, b) => colorDistance(hex, a) - colorDistance(hex, b))[0]!;
}

const OFF_BRAND = 18;

function paletteRules(doc: CompositionDoc, b: BrandContext, out: DraftFinding[]) {
  const palette = (b.brand?.visual.palette ?? []).map((p) => ({ hex: normHex(p.hex), role: p.role })).filter((p): p is { hex: string; role: (typeof p)["role"] } => !!p.hex);
  if (!palette.length) return;
  const hexes = palette.map((p) => p.hex);
  const offBrand = (hex: string) => {
    const h = normHex(hex);
    if (!h || isNeutral(h)) return false;
    return Math.min(...hexes.map((p) => chromaticDistance(h, p))) > OFF_BRAND;
  };
  const guideline = `Brand palette: ${palette.map((p) => `${p.hex} (${p.role})`).join(", ")}`;
  const theme = doc.theme;
  const keys: (keyof Theme)[] = ["background", "surface", "text", "textMuted", "accent"];
  // accent2 is derived from the accent by design unless the brand defines a secondary colour.
  if (palette.some((p) => p.role === "secondary")) keys.push("accent2");
  for (const key of keys) {
    const v = theme[key];
    if (typeof v !== "string" || !offBrand(v)) continue;
    const to = nearestBrandColor(v, hexes);
    out.push(
      draft({
        severity: "warn",
        category: "palette",
        rule: "palette.theme_off_brand",
        message: `Theme ${key} ${normHex(v)} isn't in your brand palette.`,
        quote: normHex(v)!,
        suggestion: `Use the brand colour ${to}.`,
        suggestedOps: validOps(doc, [{ op: "update_theme", set: { [key]: to } as Partial<Theme> }]),
        source: "rules",
        evidence: { guideline },
      }),
    );
  }
  const themeHexes = new Set(Object.values(theme).filter((x): x is string => typeof x === "string" && x.startsWith("#")).map((x) => normHex(x)));
  const literal = (v: string | undefined) => (v && !isThemeToken(v) && !themeHexes.has(normHex(v)) && offBrand(v) ? normHex(v)! : undefined);
  for (const scene of doc.scenes) {
    const bg = scene.background;
    for (const c of [bg.color, ...(bg.colors ?? [])]) {
      const hex = literal(c);
      if (!hex) continue;
      const to = nearestBrandColor(hex, hexes);
      const set = bg.color && normHex(bg.color) === hex ? { background: { ...bg, color: to } } : { background: { ...bg, colors: (bg.colors ?? []).map((x) => (normHex(x) === hex ? to : x)) } };
      out.push(draft({ severity: "warn", category: "palette", rule: "palette.off_brand", message: `Scene background uses ${hex}, which isn't a brand colour.`, quote: hex, location: { sceneId: scene.id }, suggestion: `Use ${to} from your palette.`, suggestedOps: validOps(doc, [{ op: "update_scene", sceneId: scene.id, set }]), source: "rules", evidence: { guideline } }));
    }
    for (const l of scene.layers) {
      if (l.hidden) continue;
      const checks: { value?: string; set: (to: string) => Record<string, unknown>; what: string }[] = [];
      if (l.type === "text") {
        checks.push({ value: l.style.color, set: (to) => ({ style: { color: to } }), what: "Text colour" });
        if (l.style.background) checks.push({ value: l.style.background.color, set: (to) => ({ style: { background: { ...l.style.background!, color: to } } }), what: "Text background" });
        if (l.style.highlight) checks.push({ value: l.style.highlight.color, set: (to) => ({ style: { highlight: { ...l.style.highlight!, color: to } } }), what: "Highlight colour" });
      }
      if (l.type === "shape") {
        checks.push({ value: l.fill, set: (to) => ({ fill: to }), what: "Shape fill" });
        if (l.gradientTo) checks.push({ value: l.gradientTo, set: (to) => ({ gradientTo: to }), what: "Shape gradient" });
      }
      if (l.type === "effect" && l.color) checks.push({ value: l.color, set: (to) => ({ color: to }), what: "Effect colour" });
      for (const ch of checks) {
        const hex = literal(ch.value);
        if (!hex) continue;
        const to = nearestBrandColor(hex, hexes);
        out.push(
          draft({
            severity: "warn",
            category: "palette",
            rule: "palette.off_brand",
            message: `${ch.what} ${hex} isn't a brand colour.`,
            quote: hex,
            location: { sceneId: scene.id, layerId: l.id },
            suggestion: `Use ${to} from your palette.`,
            suggestedOps: l.locked ? undefined : validOps(doc, [{ op: "update_layer", sceneId: scene.id, layerId: l.id, set: ch.set(to) }]),
            source: "rules",
            evidence: { guideline },
          }),
        );
      }
    }
  }
}

const covers = (outer: Layer["box"], inner: Layer["box"]) => {
  const cx = inner.x + inner.w / 2;
  const cy = inner.y + inner.h / 2;
  return cx >= outer.x && cx <= outer.x + outer.w && cy >= outer.y && cy <= outer.y + outer.h;
};

/** Background colours behind a text layer (several for gradients), or "media" when it sits on footage/images. */
function backgroundsBehind(doc: CompositionDoc, scene: Scene, layer: TextLayer): Rgba[] | "media" {
  const theme = doc.theme;
  const base = (): Rgba[] | "media" => {
    const bg = scene.background;
    if (bg.kind === "solid" || bg.kind === "gradient") {
      const cols = bg.kind === "solid" ? [bg.color ?? "theme.background"] : (bg.colors ?? [bg.color ?? "theme.background"]);
      const black = { r: 0, g: 0, b: 0, a: bg.dim };
      return cols.map((c) => parseHex(resolveColor(c, theme, "theme.background"))).filter((c): c is Rgba => !!c).map((c) => over(black, { ...c, a: 1 }));
    }
    return "media";
  };
  const idx = scene.layers.findIndex((l) => l.id === layer.id);
  const below = scene.layers
    .map((l, i) => ({ l, i }))
    .filter(({ l, i }) => l.id !== layer.id && !l.hidden && (l.box.z < layer.box.z || (l.box.z === layer.box.z && i < idx)) && covers(l.box, layer.box))
    .sort((a, b) => b.l.box.z - a.l.box.z || b.i - a.i);
  for (const { l } of below) {
    if (l.type === "shape") {
      if (l.box.opacity < 0.85 || l.blurPx > 24) continue;
      const fills = [l.fill, ...(l.gradientTo ? [l.gradientTo] : [])].map((c) => parseHex(resolveColor(c, theme, "theme.accent"))).filter((c): c is Rgba => !!c);
      const under = base();
      const ground = under === "media" ? null : under[0]!;
      return fills.map((f) => (f.a < 1 && ground ? over(f, ground) : { ...f, a: 1 }));
    }
    if (l.type === "image" || l.type === "video" || l.type === "device" || l.type === "effect" || l.type === "block") return "media";
  }
  return base();
}

function contrastRules(doc: CompositionDoc, out: DraftFinding[]) {
  const theme = doc.theme;
  for (const scene of doc.scenes) {
    for (const l of scene.layers) {
      if (l.type !== "text" || l.hidden) continue;
      const fg = parseHex(resolveColor(l.style.color, theme));
      if (!fg) continue;
      let bgs: Rgba[] | "media";
      if (l.style.background) {
        const bc = parseHex(resolveColor(l.style.background.color, theme, "theme.surface"));
        const under = backgroundsBehind(doc, scene, l);
        bgs = bc ? [bc.a < 1 && under !== "media" ? over(bc, under[0]!) : { ...bc, a: 1 }] : under;
      } else bgs = backgroundsBehind(doc, scene, l);
      if (bgs === "media") {
        if (!l.style.shadow && !l.style.background)
          out.push(draft({ severity: "info", category: "accessibility", rule: "accessibility.over_media", message: "Text sits on footage or an image, so its contrast can't be checked.", location: { sceneId: scene.id, layerId: l.id }, suggestion: "Add a text shadow or a background pill so it stays legible on every frame.", suggestedOps: l.locked ? undefined : validOps(doc, [{ op: "update_layer", sceneId: scene.id, layerId: l.id, set: { style: { shadow: true } } }]), source: "rules", fingerprint: `accessibility.over_media|${l.id}` }));
        continue;
      }
      if (!bgs.length) continue;
      const fgOpaque = fg.a < 1 ? over(fg, bgs[0]!) : fg;
      const ratio = Math.min(...bgs.map((bg) => contrastRatio(fgOpaque, bg)));
      const large = l.style.sizePx >= 48 || (l.style.sizePx >= 40 && l.style.weight >= 700);
      const need = large ? 3 : 4.5;
      if (ratio >= need) continue;
      // Best fix: a theme token (or black/white) that passes against every background.
      const candidates: { value: string; hex: string }[] = [
        { value: "theme.text", hex: theme.text },
        { value: "theme.background", hex: theme.background },
        { value: "theme.surface", hex: theme.surface },
        { value: "#FFFFFF", hex: "#FFFFFF" },
        { value: "#111111", hex: "#111111" },
      ];
      const scored = candidates.map((c) => ({ ...c, ratio: Math.min(...bgs.map((bg) => contrastRatio(parseHex(c.hex)!, bg))) }));
      // Prefer theme tokens (in order); fall back to the highest-contrast option.
      const fix = scored.find((c) => c.ratio >= Math.max(need, 4.5)) ?? [...scored].sort((a, b) => b.ratio - a.ratio)[0]!;
      const fgHex = normHex(resolveColor(l.style.color, theme))!;
      out.push(
        draft({
          severity: ratio < 1.6 ? "block" : "warn",
          category: "accessibility",
          rule: "accessibility.contrast",
          message: `Text contrast is ${ratio.toFixed(2)}:1 (needs ${need}:1${large ? " for large text" : ""}).${ratio < 1.6 ? " It is effectively invisible." : ""}`,
          quote: fgHex,
          location: { sceneId: scene.id, layerId: l.id },
          suggestion: `Use ${fix.value} (${fix.ratio.toFixed(1)}:1).`,
          suggestedOps: l.locked || fix.ratio < need ? undefined : validOps(doc, [{ op: "update_layer", sceneId: scene.id, layerId: l.id, set: { style: { color: fix.value } } }]),
          source: "rules",
          evidence: { guideline: "WCAG 2.2 contrast minimum (1.4.3)" },
          fingerprint: `accessibility.contrast|${l.id}|${fgHex}`,
        }),
      );
    }
  }
}

function layoutRules(doc: CompositionDoc, out: DraftFinding[]) {
  const sz = doc.safeZone;
  for (const scene of doc.scenes) {
    let words = 0;
    for (const l of scene.layers) {
      if (l.type !== "text" || l.hidden) continue;
      words += l.text.split(/\s+/).filter(Boolean).length;
      const b = l.box;
      const outside = b.x < sz.left - 0.005 || b.x + b.w > 1 - sz.right + 0.005 || b.y < sz.top - 0.005 || b.y + b.h > 1 - sz.bottom + 0.005;
      if (!outside || l.animation.keyframes?.length || l.anchor) continue;
      const w = Math.min(b.w, 1 - sz.left - sz.right);
      const h = Math.min(b.h, 1 - sz.top - sz.bottom);
      const x = Math.min(Math.max(b.x, sz.left), 1 - sz.right - w);
      const y = Math.min(Math.max(b.y, sz.top), 1 - sz.bottom - h);
      const r = (n: number) => Math.round(n * 1000) / 1000;
      out.push(
        draft({
          severity: "warn",
          category: "platform_fit",
          rule: "layout.safe_zone",
          message: `"${clip(l.text, 50)}" extends into the area covered by platform UI.`,
          location: { sceneId: scene.id, layerId: l.id },
          suggestion: "Move it inside the safe zone.",
          suggestedOps: l.locked ? undefined : validOps(doc, [{ op: "update_layer", sceneId: scene.id, layerId: l.id, set: { box: { x: r(x), y: r(y), w: r(w), h: r(h) } } }]),
          source: "rules",
          fingerprint: `layout.safe_zone|${l.id}`,
        }),
      );
    }
    if (doc.kind === "video" && words / Math.max(0.5, scene.durationSec) > 3.5) {
      const need = Math.min(60, Math.ceil((words / 3) * 2) / 2);
      out.push(
        draft({
          severity: "warn",
          category: "accessibility",
          rule: "layout.reading_time",
          message: `${words} words in ${scene.durationSec}s is too fast to read.`,
          location: { sceneId: scene.id },
          suggestion: need > scene.durationSec ? `Shorten the text or hold the scene for ${need}s.` : "Shorten the text.",
          suggestedOps: need > scene.durationSec ? validOps(doc, [{ op: "update_scene", sceneId: scene.id, set: { durationSec: need } }]) : undefined,
          source: "rules",
          fingerprint: `layout.reading_time|${scene.id}`,
        }),
      );
    }
  }
}

function ctaRules(doc: CompositionDoc, b: BrandContext, out: DraftFinding[]) {
  if (doc.kind !== "video") return;
  const preferred = b.brand?.preferredCtas ?? [];
  const ctaLayers = doc.scenes.flatMap((s) => s.layers.filter((l): l is TextLayer => l.type === "text" && !l.hidden && l.role === "cta").map((l) => ({ s, l })));
  const hasEndcard = doc.scenes.some((s) => s.template === "cta-endcard" || s.purpose === "cta");
  if (!ctaLayers.length && !hasEndcard) {
    const last = doc.scenes[doc.scenes.length - 1]!;
    const sz = doc.safeZone;
    const ops: PatchOp[] | undefined = preferred.length
      ? validOps(doc, [
          {
            op: "add_layer",
            sceneId: last.id,
            layer: {
              id: `${last.id}_guardian_cta`.slice(0, 120),
              type: "text",
              name: "CTA (Brand Guardian)",
              role: "cta",
              text: preferred[0]!.slice(0, 400),
              box: { x: 0.1, y: Math.max(sz.top, 1 - sz.bottom - 0.1), w: 0.8, h: 0.08, rotation: 0, opacity: 1, z: 20 },
              timing: { start: 0 },
              animation: { enter: { preset: "fade", durationSec: 0.4, delaySec: 0, easing: "smooth" }, loop: "none" },
              locked: false,
              hidden: false,
              style: { font: "heading", sizePx: 56, weight: 700, color: "theme.text", align: "center", lineHeight: 1.1, letterSpacing: -0.01, italic: false, uppercase: false, shadow: true },
              claimIds: [],
            },
          },
        ])
      : undefined;
    out.push(draft({ severity: "warn", category: "cta", rule: "cta.missing", message: "The video never tells viewers what to do next.", location: { sceneId: last.id }, suggestion: preferred.length ? `End with your preferred CTA: "${preferred[0]}".` : "Add an end card with a clear call to action.", suggestedOps: ops, source: "rules", fingerprint: "cta.missing" }));
    return;
  }
  if (!preferred.length) return;
  for (const { s, l } of ctaLayers) {
    if (ctaMatches(l.text, preferred)) continue;
    const to = closestCta(l.text, preferred);
    out.push(
      draft({
        severity: "info",
        category: "cta",
        rule: "cta.off_preferred",
        message: `CTA "${clip(l.text, 80)}" differs from your preferred CTAs.`,
        quote: l.text,
        location: { sceneId: s.id, layerId: l.id },
        suggestion: `Use "${to}".`,
        suggestedOps: l.locked ? undefined : validOps(doc, [{ op: "update_layer", sceneId: s.id, layerId: l.id, set: { text: to.slice(0, 400) } }]),
        source: "rules",
        evidence: { guideline: `Preferred CTAs: ${preferred.join(" | ")}` },
      }),
    );
  }
}

function productTruthRules(s: LoadedSubject, doc: CompositionDoc, out: DraftFinding[]) {
  const bad = (id: string | undefined) => {
    if (!id) return undefined;
    const a = s.assets.get(id);
    if (!a) return undefined; // missing media is reported by lint
    if (a.origin === "generated" || a.generation) return "AI-generated";
    if (!a.isProductTruth) return a.origin === "stock" ? "stock" : "not marked as a real screenshot/recording";
    return undefined;
  };
  for (const scene of doc.scenes) {
    for (const l of scene.layers) {
      if (l.hidden) continue;
      let why: string | undefined;
      if (l.type === "device") why = bad(l.screenAssetId);
      else if (l.type === "effect" && l.effect === "screen-insert") why = bad(l.assetId);
      else if (l.type === "image" && PRODUCT_TEMPLATES.has(scene.template)) {
        const a = s.assets.get(l.assetId);
        if (a && (a.role === "screenshot" || a.role === "app_recording" || a.origin === "generated" || a.generation)) why = bad(l.assetId);
      }
      if (why)
        out.push(
          draft({
            severity: "block",
            category: "claim",
            rule: "product_truth.media",
            message: `Shows ${why} media where viewers will read it as your real app.`,
            location: { sceneId: scene.id, layerId: l.id },
            suggestion: "Use a real screenshot or screen recording of the app here.",
            source: "rules",
            fingerprint: `product_truth.media|${l.id}`,
          }),
        );
    }
    if (PROOF_TEMPLATES.has(scene.template) && !scene.layers.some((l) => l.type === "text" && l.claimIds.length > 0))
      out.push(draft({ severity: "warn", category: "claim", rule: "claim.proof_without_source", message: `"${scene.name}" presents proof without linking a verified claim.`, location: { sceneId: scene.id }, suggestion: "Link the stat/quote text to a verified claim with its source.", source: "rules", fingerprint: `claim.proof_without_source|${scene.id}` }));
  }
}

function platformVideoRules(s: LoadedSubject, doc: CompositionDoc, out: DraftFinding[]) {
  if (doc.kind !== "video") return;
  const dur = totalDuration(doc);
  for (const ch of s.channels) {
    const spec = PLATFORM_VIDEO[ch];
    if (!spec) continue;
    if (!spec.aspects.includes(doc.aspectRatio))
      out.push(draft({ severity: "warn", category: "platform_fit", rule: "platform.aspect", message: `${doc.aspectRatio} isn't a native format for ${spec.label} (${spec.aspects.join(", ")}).`, quote: doc.aspectRatio, suggestion: `Make a ${spec.aspects[0]} variant for ${spec.label}.`, source: "rules", fingerprint: `platform.aspect|${ch}|${doc.aspectRatio}` }));
    if (dur > spec.maxSec)
      out.push(draft({ severity: "warn", category: "platform_fit", rule: "platform.duration", message: `${Math.round(dur)}s is longer than ${spec.label} allows (${spec.maxSec}s).`, suggestion: "Cut scenes or make a shorter variant.", source: "rules", fingerprint: `platform.duration|${ch}` }));
    else if (spec.idealSec && dur > spec.idealSec)
      out.push(draft({ severity: "info", category: "platform_fit", rule: "platform.duration_long", message: `${Math.round(dur)}s is long for ${spec.label}; short videos (≤ ${spec.idealSec}s) usually hold attention better.`, source: "rules", fingerprint: `platform.duration_long|${ch}` }));
  }
}

function typographyRules(doc: CompositionDoc, b: BrandContext, out: DraftFinding[]) {
  const v = b.brand?.visual;
  if (!v) return;
  const pairs: [string | undefined, string, "headingFont" | "bodyFont"][] = [
    [v.headingFont, doc.theme.headingFont, "headingFont"],
    [v.bodyFont, doc.theme.bodyFont, "bodyFont"],
  ];
  for (const [want, have, key] of pairs) {
    if (!want || normalizeText(want) === normalizeText(have)) continue;
    out.push(draft({ severity: "info", category: "typography", rule: "typography.font", message: `${key === "headingFont" ? "Heading" : "Body"} font is ${have}; your brand uses ${want}.`, quote: have, suggestion: `Switch to ${want} if it is available to the renderer.`, suggestedOps: /^[A-Za-z0-9 -]{1,60}$/.test(want) ? validOps(doc, [{ op: "update_theme", set: { [key]: want } as Partial<Theme> }]) : undefined, source: "rules", evidence: { guideline: `Brand fonts: ${[v.headingFont, v.bodyFont].filter(Boolean).join(" / ")}` } }));
  }
}

function postRules(s: LoadedSubject, out: DraftFinding[]) {
  const post = s.post;
  if (!post) return;
  const synthetic = [...s.assets.values()].filter((a) => a.origin === "generated" || a.generation);
  if (synthetic.length && !post.containsSyntheticMedia)
    out.push(draft({ severity: "warn", category: "platform_fit", rule: "platform.synthetic_disclosure", message: `This post includes AI-generated media (${synthetic.length}) but isn't labelled as synthetic.`, location: { field: "containsSyntheticMedia" }, suggestion: "Turn on the synthetic-media disclosure for this post.", source: "rules", fingerprint: "platform.synthetic_disclosure" }));
}

/** Run every deterministic rule for the subject. Pure (no I/O). */
export function runRules(s: LoadedSubject, b: BrandContext): DraftFinding[] {
  const out: DraftFinding[] = [];
  copyRules(s, b, out);
  const doc = s.composition?.doc;
  if (doc) {
    paletteRules(doc, b, out);
    contrastRules(doc, out);
    layoutRules(doc, out);
    ctaRules(doc, b, out);
    productTruthRules(s, doc, out);
    platformVideoRules(s, doc, out);
    typographyRules(doc, b, out);
  }
  postRules(s, out);
  return out;
}

export type { SubjectText };
