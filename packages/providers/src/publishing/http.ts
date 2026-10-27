import { AppError } from "@muselaunch/platform";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HttpRequest {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  headers?: Record<string, string>;
  /** JSON body (sets content-type). */
  json?: unknown;
  /** application/x-www-form-urlencoded body. */
  form?: Record<string, string | undefined>;
  /** Raw body (bytes) or multipart FormData. */
  body?: Buffer | Uint8Array | FormData | string;
  query?: Record<string, string | number | boolean | undefined>;
  bearer?: string;
  /** Status codes treated as success (default 2xx). */
  expect?: number[];
  signal?: AbortSignal;
  /** Label for errors and logs. */
  op: string;
}

export interface HttpResponse {
  status: number;
  headers: Headers;
  text: string;
  json<T = Record<string, unknown>>(): T;
}

/**
 * Thin fetch wrapper for provider REST APIs. Maps failures onto AppError so job retry policy is
 * consistent: 429 → RATE_LIMITED (retryable), 5xx/network → PROVIDER_UNAVAILABLE (retryable),
 * 401 → PROVIDER_ERROR with `reconnect` (not retryable), other 4xx → PROVIDER_ERROR (not retryable).
 * Error messages carry the provider's own error text but never request headers/tokens.
 */
export class HttpClient {
  constructor(
    private readonly fetchImpl: FetchLike,
    readonly provider: string,
  ) {}

  async request(url: string, req: HttpRequest): Promise<HttpResponse> {
    const u = new URL(url);
    for (const [k, v] of Object.entries(req.query ?? {})) if (v !== undefined) u.searchParams.set(k, String(v));
    const headers: Record<string, string> = { accept: "application/json", ...req.headers };
    if (req.bearer) headers.authorization = `Bearer ${req.bearer}`;
    let body: RequestInit["body"] | undefined;
    if (req.json !== undefined) {
      headers["content-type"] ??= "application/json; charset=UTF-8";
      body = JSON.stringify(req.json);
    } else if (req.form) {
      headers["content-type"] = "application/x-www-form-urlencoded";
      const f = new URLSearchParams();
      for (const [k, v] of Object.entries(req.form)) if (v !== undefined) f.set(k, v);
      body = f.toString();
    } else if (req.body !== undefined) {
      body = req.body as RequestInit["body"];
    }
    let res: Response;
    try {
      res = await this.fetchImpl(u.toString(), { method: req.method ?? (body ? "POST" : "GET"), headers, body, signal: req.signal, redirect: "manual" });
    } catch (err) {
      if ((err as Error).name === "AbortError") throw new AppError("CANCELLED", `${this.provider} ${req.op} cancelled`);
      throw new AppError("PROVIDER_UNAVAILABLE", `${this.provider} ${req.op}: network error (${(err as Error).message})`, { retryable: true, details: { provider: this.provider, op: req.op } });
    }
    const text = await res.text().catch(() => "");
    const out: HttpResponse = {
      status: res.status,
      headers: res.headers,
      text,
      json<T>() {
        try {
          return JSON.parse(text) as T;
        } catch {
          throw new AppError("PROVIDER_ERROR", `${req.op}: expected JSON, got ${text.slice(0, 120)}`, { retryable: false });
        }
      },
    };
    const ok = req.expect ? req.expect.includes(res.status) : res.status >= 200 && res.status < 300;
    if (ok) return out;
    throw httpError(this.provider, req.op, res.status, text, res.headers.get("retry-after"));
  }
}

/** Extract a provider error message from common envelopes (Google, Meta Graph, TikTok, LinkedIn, X). */
export function providerMessage(text: string): string {
  try {
    const j = JSON.parse(text) as Record<string, any>;
    const e = j.error;
    if (typeof e === "string") return [e, j.error_description].filter(Boolean).join(": ");
    if (e && typeof e === "object") return [e.code, e.message, e.status, e.error_user_msg].filter((x) => x !== undefined && x !== "").join(" ");
    if (j.message) return String(j.message);
    if (Array.isArray(j.errors)) return j.errors.map((x: any) => x.message ?? x.detail ?? JSON.stringify(x)).join("; ");
    if (j.detail) return String(j.detail);
    if (j.title) return String(j.title);
  } catch {
    /* not JSON */
  }
  return text.slice(0, 300);
}

export function httpError(provider: string, op: string, status: number, text: string, retryAfter?: string | null): AppError {
  const msg = `${provider} ${op} failed (${status}): ${providerMessage(text)}`.slice(0, 1500);
  const details = { provider, op, status };
  if (status === 429) return new AppError("RATE_LIMITED", msg, { retryable: true, details: { ...details, retryAfter } });
  if (status >= 500) return new AppError("PROVIDER_UNAVAILABLE", msg, { retryable: true, details });
  if (status === 401) return new AppError("PROVIDER_ERROR", msg, { retryable: false, details: { ...details, reconnect: true }, userMessage: `${provider} rejected the saved connection. Please reconnect the account.` });
  if (status === 403) return new AppError("PROVIDER_ERROR", msg, { retryable: false, details, userMessage: `${provider} refused this action for the connected account (permissions or app review).` });
  return new AppError("PROVIDER_ERROR", msg, { retryable: false, details });
}

/** Seconds→ms expiry helper. */
export const expiresIn = (sec: unknown, now = Date.now()): number | undefined => (typeof sec === "number" && sec > 0 ? now + sec * 1000 : typeof sec === "string" && Number(sec) > 0 ? now + Number(sec) * 1000 : undefined);

/** A publish step completed remotely but we cannot prove its result: never retry blindly (duplicate post risk). */
export function uncertainOutcome(provider: string, step: string): AppError {
  return new AppError("PROVIDER_ERROR", `${provider}: a previous attempt reached "${step}" but its result was not recorded`, {
    retryable: false,
    details: { provider, uncertain: true, step },
    userMessage: `We can't confirm whether ${provider} published this post. Check your ${provider} profile: if it's there, use "Mark as posted" with its link; otherwise reset the post and publish again.`,
  });
}
