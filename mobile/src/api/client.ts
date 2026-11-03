/**
 * The MuseLaunch API from the phone: `Authorization: Bearer mld_<token>` (the linked phone's token),
 * JSON in and out, errors with a plain `userMessage` (the API's own, else a safe default).
 */
import Constants from "expo-constants";
import type { ApiErrorBody, WorkspaceMember } from "./types";

export const PRODUCTION_API = "https://muselaunch-api-264489246542.us-central1.run.app";

/** The API this build talks to by default (EAS sets EXPO_PUBLIC_API_URL; app.json has the same). */
export function defaultApiBase(): string {
  const fromEnv = process.env.EXPO_PUBLIC_API_URL;
  const fromConfig = (Constants.expoConfig?.extra as { apiUrl?: string } | undefined)?.apiUrl;
  return (fromEnv || fromConfig || PRODUCTION_API).replace(/\/+$/, "");
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly userMessage: string;
  readonly details?: Record<string, unknown>;
  constructor(init: { status: number; code: string; message: string; userMessage?: string; details?: Record<string, unknown> }) {
    super(init.message);
    this.name = "ApiError";
    this.status = init.status;
    this.code = init.code;
    this.userMessage = init.userMessage ?? defaultMessage(init.status, init.code);
    this.details = init.details;
  }
}

function defaultMessage(status: number, code: string): string {
  if (status === 0) return "Can’t reach MuseLaunch. Check your connection and try again.";
  if (code === "UNAUTHENTICATED") return "This phone isn’t linked any more. Link it again from MuseLaunch on the web.";
  if (code === "FORBIDDEN") return "You don’t have permission to do that in this workspace.";
  if (code === "NOT_FOUND") return "We couldn’t find that. It may have been removed.";
  if (code === "RATE_LIMITED") return "Too many tries. Wait a moment and try again.";
  if (code === "INSUFFICIENT_CREDITS") return "Not enough credits for this.";
  return status >= 500 ? "Something went wrong on our side. Try again." : "That didn’t work. Try again.";
}

export const errorMessage = (e: unknown) => (e instanceof ApiError ? e.userMessage : e instanceof Error ? e.message : "Something went wrong.");

export type Query = Record<string, string | number | boolean | undefined | null>;

export interface Api {
  base: string;
  get<T>(path: string, query?: Query): Promise<T>;
  post<T>(path: string, body?: unknown, opts?: { idempotencyKey?: string }): Promise<T>;
  put<T>(path: string, body?: unknown): Promise<T>;
  del<T>(path: string): Promise<T>;
  /** `/v1/workspaces/:wid` + path. */
  ws(path?: string): string;
}

export function buildUrl(base: string, path: string, query?: Query): string {
  const qs = query
    ? Object.entries(query)
        .filter(([, v]) => v !== undefined && v !== null && v !== "")
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
        .join("&")
    : "";
  const url = path.startsWith("http") ? path : `${base}${path.startsWith("/") ? "" : "/"}${path}`;
  return qs ? `${url}${url.includes("?") ? "&" : "?"}${qs}` : url;
}

export const newKey = (prefix = "phone") => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

export function createApi(opts: { base: string; token: string | null; workspaceId?: string | null; onUnauthenticated?: () => void }): Api {
  const request = async <T>(method: string, path: string, body?: unknown, query?: Query, idempotencyKey?: string): Promise<T> => {
    const headers: Record<string, string> = { accept: "application/json" };
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
    let res: Response;
    try {
      res = await fetch(buildUrl(opts.base, path, query), { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    } catch (err) {
      throw new ApiError({ status: 0, code: "NETWORK", message: (err as Error)?.message ?? "Network error" });
    }
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    if (!res.ok) {
      const info = (json as ApiErrorBody | undefined)?.error;
      if (res.status === 401) opts.onUnauthenticated?.();
      throw new ApiError({ status: res.status, code: info?.code ?? `HTTP_${res.status}`, message: info?.message ?? `Request failed (${res.status})`, userMessage: info?.userMessage, details: info?.details });
    }
    return json as T;
  };
  return {
    base: opts.base,
    get: (path, query) => request("GET", path, undefined, query),
    post: (path, body, o) => request("POST", path, body ?? {}, undefined, o?.idempotencyKey),
    put: (path, body) => request("PUT", path, body ?? {}),
    del: (path) => request("DELETE", path),
    ws: (path = "") => `/v1/workspaces/${encodeURIComponent(opts.workspaceId ?? "none")}${path && !path.startsWith("/") ? "/" : ""}${path}`,
  };
}

/** The member's capabilities (mirrors packages/contracts/src/permissions.ts; the API checks again). */
export function can(member: Pick<WorkspaceMember, "role" | "canPublish" | "status"> | null | undefined, cap: "publish" | "content.write" | "content.approve"): boolean {
  if (!member || (member.status && member.status !== "active")) return false;
  if (cap === "publish") return member.role === "owner" || Boolean(member.canPublish);
  if (cap === "content.approve") return member.role === "owner" || member.role === "admin";
  return member.role === "owner" || member.role === "admin" || member.role === "editor";
}
