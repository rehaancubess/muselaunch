import { randomUUID } from "node:crypto";
import { AppError, toAppError, verifyBearer } from "@muselaunch/platform";
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "./context";

export const requestId: MiddlewareHandler<AppEnv> = async (c, next) => {
  const id = c.req.header("x-request-id")?.slice(0, 64) || randomUUID();
  c.set("requestId", id);
  c.header("x-request-id", id);
  await next();
};

export const accessLog: MiddlewareHandler<AppEnv> = async (c, next) => {
  const start = Date.now();
  await next();
  const p = c.get("platform");
  if (c.req.path === "/health") return;
  p.log.info(
    { requestId: c.get("requestId"), method: c.req.method, path: c.req.path, status: c.res.status, ms: Date.now() - start, uid: c.var.user?.uid, workspaceId: c.var.workspaceId },
    "request",
  );
};

export const authenticate: MiddlewareHandler<AppEnv> = async (c, next) => {
  const p = c.get("platform");
  const user = await verifyBearer(p.cfg, c.req.header("authorization"));
  c.set("user", user);
  // Only trust a country header injected by our own edge (Cloud Run behind a LB/CDN that sets it).
  const edgeCountry = c.req.header("x-client-country") ?? c.req.header("cf-ipcountry");
  if (edgeCountry && /^[A-Z]{2}$/.test(edgeCountry) && process.env.TRUST_EDGE_COUNTRY === "1") c.set("country", edgeCountry);
  await next();
};

/**
 * Resolve `:workspaceId` and the caller's membership. Non-members get 404 (not 403) so
 * workspace ids cannot be probed. Everything below this middleware is tenant-scoped.
 */
export const workspaceScope: MiddlewareHandler<AppEnv> = async (c, next) => {
  const p = c.get("platform");
  const workspaceId = c.req.param("workspaceId");
  if (!workspaceId || !/^[A-Za-z0-9_-]{1,128}$/.test(workspaceId)) throw new AppError("NOT_FOUND", "Workspace not found");
  const uid = c.get("user").uid;
  const [workspace, member] = await Promise.all([p.db.top("workspaces").get(workspaceId), p.db.ws(workspaceId).collection("members").get(uid)]);
  if (!workspace || !member || member.status !== "active") throw new AppError("NOT_FOUND", "Workspace not found");
  c.set("workspaceId", workspaceId);
  c.set("workspace", workspace);
  c.set("member", member);
  if (!c.get("country")) {
    const profile = await p.db.top("users").get(uid);
    if (profile?.country) c.set("country", profile.country);
  }
  await next();
};

/** Simple per-user token bucket (per instance). Expensive routes pass a lower rate. */
export function rateLimit(opts: { perMinute: number; key?: string }): MiddlewareHandler<AppEnv> {
  const buckets = new Map<string, { tokens: number; at: number }>();
  return async (c, next) => {
    const uid = c.var.user?.uid ?? c.req.header("x-forwarded-for") ?? "anon";
    const key = `${opts.key ?? "default"}:${uid}`;
    const now = Date.now();
    const b = buckets.get(key) ?? { tokens: opts.perMinute, at: now };
    b.tokens = Math.min(opts.perMinute, b.tokens + ((now - b.at) / 60_000) * opts.perMinute);
    b.at = now;
    if (b.tokens < 1) {
      c.header("retry-after", "10");
      throw new AppError("RATE_LIMITED", "Too many requests");
    }
    b.tokens -= 1;
    buckets.set(key, b);
    if (buckets.size > 50_000) buckets.clear();
    await next();
  };
}

export function errorResponse(err: unknown, c: Parameters<MiddlewareHandler<AppEnv>>[0]) {
  const e = toAppError(err);
  const p = c.get("platform");
  if (e.status >= 500) p?.log.error({ requestId: c.get("requestId"), err: { code: e.code, message: e.message, stack: e.stack } }, "request failed");
  return c.json({ error: e.toInfo() }, e.status as 400);
}
