/**
 * Link codes (Settings → Phone app on the web): 8 characters from an alphabet without 0/O or 1/I/L,
 * shown as "ABCD-EFGH". Same rules as packages/contracts/src/devices.ts (normalizeLinkCode); the API
 * checks them again.
 */

export const LINK_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const LINK_CODE_LENGTH = 8;

/** What a person typed ("abcd efgh", "ABCD-EFGH") → the 8 code characters, or null. */
export function normalizeCode(input: string): string | null {
  const s = input.toUpperCase().replace(/[\s-]+/g, "");
  if (s.length !== LINK_CODE_LENGTH) return null;
  for (const ch of s) if (!LINK_ALPHABET.includes(ch)) return null;
  return s;
}

/** As the person types: upper case, only code characters, a dash after the fourth. */
export function formatAsTyped(input: string): string {
  const s = input
    .toUpperCase()
    .split("")
    .filter((ch) => LINK_ALPHABET.includes(ch))
    .join("")
    .slice(0, LINK_CODE_LENGTH);
  return s.length > 4 ? `${s.slice(0, 4)}-${s.slice(4)}` : s;
}

export interface ScannedLink {
  code: string;
  /** The API the code belongs to, when the QR says (a local test server, say). */
  api: string | null;
}

/**
 * The QR code's text: `muselaunch://link?code=ABCDEFGH&api=https%3A%2F%2F…`. Also accepts a bare
 * code. Anything else (another app's QR, a web page) → null.
 */
export function parseScanned(text: string): ScannedLink | null {
  const t = text.trim();
  const bare = normalizeCode(t);
  if (bare) return { code: bare, api: null };
  const m = /^muselaunch:\/\/\/?link\/?\?(.*)$/i.exec(t);
  if (!m) return null;
  const params = parseQuery(m[1] ?? "");
  const code = normalizeCode(params.code ?? "");
  if (!code) return null;
  const api = params.api;
  return { code, api: api && isHttpUrl(api) ? api.replace(/\/+$/, "") : null };
}

/** "a=1&b=x%20y" → { a: "1", b: "x y" } (first value wins; no URLSearchParams needed). */
export function parseQuery(q: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of q.replace(/^\?/, "").split("&")) {
    if (!part) continue;
    const i = part.indexOf("=");
    const k = decode(i < 0 ? part : part.slice(0, i));
    if (k && !(k in out)) out[k] = decode(i < 0 ? "" : part.slice(i + 1));
  }
  return out;
}

function decode(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, " "));
  } catch {
    return s;
  }
}

export function isHttpUrl(s: string): boolean {
  return /^https?:\/\/[^\s/?#]+(:\d+)?(\/[^\s]*)?$/i.test(s.trim());
}

/** "muselaunch-api-….run.app" for a confirm line. */
export function hostOf(url: string): string {
  const m = /^https?:\/\/([^/?#]+)/i.exec(url.trim());
  return m?.[1] ?? url;
}
