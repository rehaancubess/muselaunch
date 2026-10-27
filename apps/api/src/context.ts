import type { Capability, Workspace, WorkspaceMember } from "@muselaunch/contracts";
import { can } from "@muselaunch/contracts";
import { AppError, type AuthUser, type Platform } from "@muselaunch/platform";
import type { Context, MiddlewareHandler } from "hono";
import type { z } from "zod";

export type AppEnv = {
  Variables: {
    platform: Platform;
    requestId: string;
    user: AuthUser;
    /** ISO country from a trusted edge header or the user's profile; used for provider eligibility. */
    country?: string;
    workspaceId: string;
    workspace: Workspace;
    member: WorkspaceMember;
  };
};

export type Ctx = Context<AppEnv>;

/** Parse and validate a JSON body against a contract schema (422 on failure). */
export async function body<S extends z.ZodTypeAny>(c: Ctx, schema: S): Promise<z.infer<S>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new AppError("BAD_REQUEST", "Request body must be JSON");
  }
  return schema.parse(raw);
}

export function query<S extends z.ZodTypeAny>(c: Ctx, schema: S): z.infer<S> {
  return schema.parse(c.req.query());
}

/** Capability guard for workspace routes. */
export function requireCap(cap: Capability): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!can(c.get("member"), cap)) throw new AppError("FORBIDDEN", `Missing capability ${cap}`);
    await next();
  };
}

export function assertCap(c: Ctx, cap: Capability) {
  if (!can(c.get("member"), cap)) throw new AppError("FORBIDDEN", `Missing capability ${cap}`);
}

export const actorOf = (c: Ctx) => c.get("user").uid;

/** Idempotency key from the `Idempotency-Key` header, namespaced to the workspace+user. */
export function idempotencyKey(c: Ctx, fallback?: string): string | undefined {
  const h = c.req.header("idempotency-key");
  if (h && /^[A-Za-z0-9:_-]{8,120}$/.test(h)) return `${c.get("user").uid}:${h}`;
  return fallback;
}
