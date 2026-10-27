import { createHash } from "node:crypto";
import type { SourceRef } from "@muselaunch/contracts";

/** Deterministic JSON (sorted keys, no undefined) for hashing. */
export function stableJson(value: unknown): string {
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as object).sort()) {
        const x = (v as Record<string, unknown>)[k];
        if (x !== undefined) out[k] = norm(x);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(norm(value));
}

export const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

export const hashOf = (value: unknown) => `sha256:${sha256(stableJson(value))}`;

/** Lowercase, strip punctuation/diacritics, collapse whitespace. Used for dedupe keys. */
export function normText(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Comparable URL (no fragment, no trailing slash, no tracking params). */
export function normUrl(u: string): string {
  try {
    const url = new URL(u);
    url.hash = "";
    for (const k of [...url.searchParams.keys()]) if (/^utm_|^fbclid$|^gclid$/i.test(k)) url.searchParams.delete(k);
    return url.toString().replace(/\/$/, "").toLowerCase();
  } catch {
    return u.trim().toLowerCase();
  }
}

/**
 * Sources that can back an external fact: real URLs/assets/evidence. `model_inference` never counts
 * as evidence on its own (contract rule), and a source must point at something checkable.
 */
export function factualSources(sources: readonly SourceRef[]): SourceRef[] {
  const seen = new Set<string>();
  const out: SourceRef[] = [];
  for (const s of sources) {
    if (s.kind === "model_inference") continue;
    if (!s.url && !s.assetId && !s.evidenceId) continue;
    const key = s.url ? normUrl(s.url) : `${s.assetId ?? ""}:${s.evidenceId ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

export const latestIso = (xs: (string | undefined)[]) => xs.filter((x): x is string => Boolean(x)).sort().at(-1);

export const DAY_MS = 86_400_000;
