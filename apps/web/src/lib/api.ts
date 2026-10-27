import type { ApiErrorBody } from "@muselaunch/contracts";
import { env } from "./env";

/**
 * Typed fetch client for the MuseLaunch API.
 * - Adds `Authorization: Bearer <token>` from the auth provider.
 * - Adds `Idempotency-Key` to POSTs that create jobs (pass `idempotencyKey`, or `idempotent: true` to generate one).
 * - Parses `ApiErrorBody` into `ApiError` with a safe `userMessage` the UI can show.
 */

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly userMessage: string;
  readonly retryable: boolean;
  readonly requestId?: string;
  readonly details?: Record<string, unknown>;

  constructor(init: { status: number; code: string; message: string; userMessage?: string; retryable?: boolean; requestId?: string; details?: Record<string, unknown> }) {
    super(init.message);
    this.name = "ApiError";
    this.status = init.status;
    this.code = init.code;
    this.userMessage = init.userMessage ?? defaultUserMessage(init.status, init.code);
    this.retryable = init.retryable ?? (init.status >= 500 || init.status === 429 || init.status === 0);
    this.requestId = init.requestId;
    this.details = init.details;
  }
}

function defaultUserMessage(status: number, code: string): string {
  if (status === 0) return "Can't reach MuseLaunch. Check your connection and try again.";
  switch (code) {
    case "UNAUTHENTICATED":
      return "Your session ended. Sign in again to continue.";
    case "FORBIDDEN":
      return "You don't have permission to do that in this workspace.";
    case "NOT_FOUND":
      return "We couldn't find that. It may have been removed.";
    case "RATE_LIMITED":
      return "Too many requests. Wait a moment and try again.";
    case "QUOTA_EXCEEDED":
      return "Your plan's limit has been reached.";
    case "INSUFFICIENT_CREDITS":
      return "Not enough credits for this action.";
    case "PROVIDER_NOT_CONFIGURED":
      return "This AI provider isn't connected yet, so nothing was generated.";
    case "PROVIDER_ERROR":
      return "The AI provider returned an error. Try again.";
    case "VALIDATION_FAILED":
    case "BAD_REQUEST":
      return "Some details need fixing.";
    case "CONFLICT":
      return "This changed since you loaded it. Refresh and try again.";
    default:
      return status >= 500 ? "Something went wrong on our side. Try again." : "That didn't work. Try again.";
  }
}

/**
 * True when the API has no handler for this route yet (another module's endpoint that hasn't
 * merged). Screens show an honest "not available in this build" state instead of an error.
 */
export function isRouteMissing(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404 && /^Route [A-Z]+ /.test(err.message);
}

/** Human-readable message for any thrown value. */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.userMessage;
  if (err instanceof Error) return err.message;
  return "Something went wrong.";
}

export type Query = Record<string, string | number | boolean | undefined | null>;

export interface RequestOptions {
  query?: Query;
  body?: unknown;
  /** Stable key to dedupe retries/double-submits of job-creating POSTs. */
  idempotencyKey?: string;
  /** Generate an idempotency key automatically. */
  idempotent?: boolean;
  signal?: AbortSignal;
  /** Raw body (e.g. a Blob for signed uploads); skips JSON encoding. */
  headers?: Record<string, string>;
}

export type TokenGetter = () => Promise<string | null>;

let tokenGetter: TokenGetter = async () => null;
let onUnauthenticated: (() => void) | null = null;

/** Wired by the AuthProvider. */
export function setTokenGetter(fn: TokenGetter) {
  tokenGetter = fn;
}
export function setUnauthenticatedHandler(fn: (() => void) | null) {
  onUnauthenticated = fn;
}
export function getToken() {
  return tokenGetter();
}

export function newIdempotencyKey(prefix = "web"): string {
  const rnd = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${rnd}`.replace(/[^A-Za-z0-9:_-]/g, "").slice(0, 120);
}

export function buildUrl(path: string, query?: Query): string {
  const url = new URL(path.startsWith("http") ? path : `${env.apiUrl}${path.startsWith("/") ? "" : "/"}${path}`);
  if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  return url.toString();
}

export async function request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
  const token = await tokenGetter();
  const headers: Record<string, string> = { accept: "application/json", ...opts.headers };
  if (token) headers.authorization = `Bearer ${token}`;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const idem = opts.idempotencyKey ?? (opts.idempotent ? newIdempotencyKey() : undefined);
  if (idem) headers["idempotency-key"] = idem;

  let res: Response;
  try {
    res = await fetch(buildUrl(path, opts.query), {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: opts.signal,
      credentials: "omit",
    });
  } catch (err) {
    if ((err as Error)?.name === "AbortError") throw err;
    throw new ApiError({ status: 0, code: "NETWORK", message: (err as Error)?.message ?? "Network error" });
  }

  const requestId = res.headers.get("x-request-id") ?? undefined;
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let json: unknown = undefined;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
  }
  if (!res.ok) {
    const info = (json as ApiErrorBody | undefined)?.error;
    if (res.status === 401) onUnauthenticated?.();
    throw new ApiError({
      status: res.status,
      code: info?.code ?? `HTTP_${res.status}`,
      message: info?.message ?? (res.statusText || "Request failed"),
      userMessage: info?.userMessage,
      retryable: info?.retryable,
      requestId,
      details: info?.details,
    });
  }
  return json as T;
}

export const api = {
  get: <T>(path: string, opts?: Omit<RequestOptions, "body">) => request<T>("GET", path, opts),
  post: <T>(path: string, body?: unknown, opts?: Omit<RequestOptions, "body">) => request<T>("POST", path, { ...opts, body: body ?? {} }),
  patch: <T>(path: string, body?: unknown, opts?: Omit<RequestOptions, "body">) => request<T>("PATCH", path, { ...opts, body: body ?? {} }),
  put: <T>(path: string, body?: unknown, opts?: Omit<RequestOptions, "body">) => request<T>("PUT", path, { ...opts, body }),
  del: <T>(path: string, opts?: Omit<RequestOptions, "body">) => request<T>("DELETE", path, opts),
};

/** Workspace-scoped path helper: `wsPath(wid, "/apps")` → `/v1/workspaces/:wid/apps`. */
export function wsPath(workspaceId: string, path = ""): string {
  return `/v1/workspaces/${encodeURIComponent(workspaceId)}${path && !path.startsWith("/") ? "/" : ""}${path}`;
}

/**
 * Upload a file to a signed URL with progress (XHR: fetch has no upload progress).
 * Returns when the storage provider accepted the bytes.
 */
export function uploadToSignedUrl(
  upload: { url: string; method: "PUT" | "POST"; headers: Record<string, string> },
  file: Blob,
  onProgress?: (pct: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const url = upload.url.startsWith("http") ? upload.url : `${env.apiUrl}${upload.url}`;
    xhr.open(upload.method, url);
    for (const [k, v] of Object.entries(upload.headers ?? {})) xhr.setRequestHeader(k, v);
    if (!Object.keys(upload.headers ?? {}).some((h) => h.toLowerCase() === "content-type") && file.type) xhr.setRequestHeader("content-type", file.type);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new ApiError({ status: xhr.status, code: "UPLOAD_FAILED", message: `Upload failed (${xhr.status})`, userMessage: "The upload didn't finish. Try again." })));
    xhr.onerror = () => reject(new ApiError({ status: 0, code: "NETWORK", message: "Upload network error", userMessage: "The upload was interrupted. Check your connection and try again." }));
    xhr.onabort = () => reject(new DOMException("Upload cancelled", "AbortError"));
    signal?.addEventListener("abort", () => xhr.abort());
    xhr.send(file);
  });
}
