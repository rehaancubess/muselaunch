/**
 * Number grounding for model-written interpretation: every figure the model writes must match a
 * number that is in the data it was given (stats, video numbers, titles, App DNA, claims). Text that
 * cites any other number is dropped, so an invented statistic can never reach the screen.
 */

const NUMBER_RE = /(?<![\w.])(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?\s*(k\b|m\b|%|percent\b|x\b|×|times\b)?/gi;
/** Dates and clock times are formatting, not statistics (e.g. "2026-10-29", "17:00"). */
const STRIP_RE = /\b\d{4}-\d{2}-\d{2}(?:[T ][\d:.]+Z?)?\b|\b\d{1,2}:\d{2}(?::\d{2})?\b/g;
const ALWAYS_OK = Array.from({ length: 11 }, (_, i) => i);

export interface FoundNumber {
  raw: string;
  value: number;
  kind: "plain" | "percent" | "thousand" | "million" | "ratio";
}

export function numbersIn(text: string): FoundNumber[] {
  const out: FoundNumber[] = [];
  for (const m of text.replace(STRIP_RE, " ").matchAll(NUMBER_RE)) {
    const base = Number(`${m[1]!.replace(/,/g, "")}${m[2] ? `.${m[2]}` : ""}`);
    if (!Number.isFinite(base)) continue;
    const suffix = (m[3] ?? "").toLowerCase();
    const kind: FoundNumber["kind"] = suffix === "k" ? "thousand" : suffix === "m" ? "million" : suffix === "%" || suffix === "percent" ? "percent" : suffix === "x" || suffix === "×" || suffix === "times" ? "ratio" : "plain";
    out.push({ raw: m[0].trim(), value: kind === "thousand" ? base * 1000 : kind === "million" ? base * 1_000_000 : base, kind });
  }
  return out;
}

/** Collect every finite number in a JSON-like value (recursively). */
export function collectNumbers(value: unknown, out: number[] = [], depth = 0): number[] {
  if (depth > 8) return out;
  if (typeof value === "number" && Number.isFinite(value)) out.push(value);
  else if (Array.isArray(value)) for (const v of value) collectNumbers(v, out, depth + 1);
  else if (value && typeof value === "object") for (const v of Object.values(value)) collectNumbers(v, out, depth + 1);
  return out;
}

export class KnownNumbers {
  private readonly plain: number[];
  private readonly ratios: number[];
  constructor(values: number[], ratios: number[], texts: string[] = []) {
    const fromTexts = texts.flatMap((t) => numbersIn(t).map((n) => n.value));
    const all = [...values, ...fromTexts, ...ALWAYS_OK];
    // Rates are stored as fractions (0.0421) and written as percentages (4.2%).
    this.plain = [...new Set([...all, ...values.filter((v) => v > 0 && v < 1).map((v) => v * 100)])];
    // "3x" must match a ratio that was actually computed (video vs median, group vs group).
    this.ratios = [...new Set(ratios.filter((r) => Number.isFinite(r) && r > 0))];
  }

  supports(n: FoundNumber): boolean {
    const close = (pool: number[], v: number, rel: number, abs: number) => pool.some((k) => Math.abs(v - k) <= Math.max(rel * Math.abs(k), abs));
    switch (n.kind) {
      case "thousand":
        return close(this.plain, n.value, 0.05, 500);
      case "million":
        return close(this.plain, n.value, 0.05, 50_000);
      case "percent":
        return close(this.plain, n.value, 0.03, 0.6);
      case "ratio":
        return close(this.ratios, n.value, 0.05, 0.15);
      default: {
        const integer = Number.isInteger(n.value);
        return close(this.plain, n.value, n.value >= 1000 ? 0.01 : 0, integer ? 0.5 : 0.051);
      }
    }
  }

  unsupported(text: string): string[] {
    return numbersIn(text)
      .filter((n) => !this.supports(n))
      .map((n) => n.raw);
  }
}

export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z0-9“"(])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Keep only sentences whose numbers are all supported. */
export function groundText(text: string, known: KnownNumbers): { text: string; dropped: number; unsupported: string[] } {
  const kept: string[] = [];
  const unsupported: string[] = [];
  let dropped = 0;
  for (const s of splitSentences(text)) {
    const bad = known.unsupported(s);
    if (bad.length) {
      dropped++;
      unsupported.push(...bad);
    } else kept.push(s);
  }
  return { text: kept.join(" "), dropped, unsupported };
}
