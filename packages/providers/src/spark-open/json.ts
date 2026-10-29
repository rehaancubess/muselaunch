import type { z } from "zod";

/**
 * JSON from a model with no JSON mode (Muse Spark Open): the answer may wrap the JSON in prose or a
 * code fence. Candidates are tried in order: fenced blocks, the whole answer, then each balanced
 * top-level `{…}` / `[…]` (string-aware scan). Only the ANSWER is ever parsed, never reasoning.
 */
export function jsonCandidates(text: string, max = 12): string[] {
  const t = text.trim();
  const out: string[] = [];
  for (const m of t.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) out.push(m[1]!.trim());
  out.push(t);
  for (let i = 0; i < t.length && out.length < max; i++) {
    const ch = t[i];
    if (ch !== "{" && ch !== "[") continue;
    const end = matchingClose(t, i);
    if (end > i) {
      out.push(t.slice(i, end + 1));
      i = end;
    }
  }
  return [...new Set(out)].filter(Boolean);
}

function matchingClose(s: string, start: number): number {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{" || c === "[") stack.push(c === "{" ? "}" : "]");
    else if (c === "}" || c === "]") {
      if (stack.pop() !== c) return -1;
      if (!stack.length) return i;
    }
  }
  return -1;
}

/**
 * Extract and validate. Also accepts the common `{"<SchemaName>": {...}}` wrapper. Returns the first
 * schema error (for the repair prompt) when JSON was found but didn't validate.
 */
export function parseJsonAnswer<S extends z.ZodTypeAny>(text: string, schema: S, schemaName?: string): { ok: true; data: z.infer<S> } | { ok: false; error: string } {
  if (!text.trim()) return { ok: false, error: "Empty answer" };
  let schemaError: string | undefined;
  let syntaxError: string | undefined;
  for (const candidate of jsonCandidates(text)) {
    let raw: unknown;
    try {
      raw = JSON.parse(candidate);
    } catch (e) {
      syntaxError ??= (e as Error).message;
      continue;
    }
    const attempts = [raw];
    if (schemaName && raw && typeof raw === "object" && !Array.isArray(raw)) {
      const keys = Object.keys(raw);
      if (keys.length === 1 && keys[0] === schemaName) attempts.push((raw as Record<string, unknown>)[schemaName]);
    }
    for (const a of attempts) {
      const r = schema.safeParse(a);
      if (r.success) return { ok: true, data: r.data };
      schemaError ??= r.error.issues
        .slice(0, 12)
        .map((i: z.core.$ZodIssue) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("\n");
    }
  }
  if (schemaError) return { ok: false, error: schemaError };
  return { ok: false, error: `No valid JSON found in the answer${syntaxError ? ` (${syntaxError})` : ""}` };
}
