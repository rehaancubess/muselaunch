import { createHash } from "node:crypto";
import type { SourceRef } from "@muselaunch/contracts";
import type { JobContext } from "@muselaunch/platform";
import type { CallContext } from "@muselaunch/providers";

/** Deterministic, Firestore-safe id from a key (idempotent creates across job retries). */
export function hashId(prefix: string, ...parts: (string | number | undefined)[]): string {
  return `${prefix}_${createHash("sha256").update(parts.map((p) => String(p ?? "")).join("␟")).digest("hex").slice(0, 24)}`;
}

export function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Lowercase, strip punctuation and collapse whitespace (dedup keys, fuzzy matching). */
export function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9%#$€£₹.\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const STOP = new Set("a an and are as at be by for from has have in into is it its of on or that the this to was were will with your you our we us my me i".split(" "));

export function tokens(s: string): Set<string> {
  return new Set(
    normalizeText(s)
      .split(" ")
      .filter((t) => t.length > 1 && !STOP.has(t)),
  );
}

export function jaccard(a: string, b: string): number {
  const A = tokens(a);
  const B = tokens(b);
  if (!A.size && !B.size) return 1;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

export const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
export const clip = (s: string | undefined, max: number) => (s && s.length > max ? `${s.slice(0, max - 1)}…` : (s ?? ""));
export const uniq = <T>(xs: readonly T[]) => [...new Set(xs)];

/** Canonical form for comparing URLs (drop fragment and trailing slash, lowercase host). */
export function canonicalUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    u.hostname = u.hostname.toLowerCase();
    let s = u.toString();
    if (s.endsWith("/") && u.pathname !== "/") s = s.slice(0, -1);
    return s;
  } catch {
    return null;
  }
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** Valid http(s) URL that fits the contract's HttpUrl (≤2048). */
export function isHttpUrl(s: string | undefined): s is string {
  if (!s || s.length > 2048) return false;
  return /^https?:\/\//i.test(s) && canonicalUrl(s) !== null;
}

/** Provider call context for a job (metering attribution + cancellation). */
export function callCtx(ctx: JobContext, task: string, agentRunId?: string): CallContext {
  return { workspaceId: ctx.workspaceId, task, appId: ctx.appId, jobId: ctx.job.id, agentRunId, actor: ctx.actor, signal: ctx.signal };
}

export function sourceKey(s: SourceRef): string {
  return canonicalUrl(s.url ?? "") ?? `${s.kind}:${s.evidenceId ?? s.assetId ?? s.title ?? ""}`;
}

/** Merge SourceRefs by URL/evidence key, keeping the first occurrence. */
export function mergeSources(a: SourceRef[], b: SourceRef[], max = 30): SourceRef[] {
  const out: SourceRef[] = [];
  const seen = new Set<string>();
  for (const s of [...a, ...b]) {
    const k = sourceKey(s);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** Short JSON for step summaries (trimmed, never secrets: callers pass already-redacted data). */
export function brief(value: unknown, max = 1500): string {
  let s: string;
  try {
    s = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    s = String(value);
  }
  return clip(s, max);
}
