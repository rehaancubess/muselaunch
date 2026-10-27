import { Hono } from "hono";
import type { AppEnv } from "../context";

/**
 * Owner: module F (Platform): plans, subscriptions, usage dashboards, admin operations.
 * Mounted under /v1/workspaces/:workspaceId (workspace scope + membership already enforced).
 * Use requireCap(...) for writes, body(c, Schema) for input, and return contract-shaped JSON.
 */
export const billingRoutes = new Hono<AppEnv>();
