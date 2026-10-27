import { Hono } from "hono";
import type { AppEnv } from "../context";

/**
 * Owner: module F (Analytics): connections, observations, CSV import, tracked links, experiments, recommendations.
 * Mounted under /v1/workspaces/:workspaceId (workspace scope + membership already enforced).
 * Use requireCap(...) for writes, body(c, Schema) for input, and return contract-shaped JSON.
 */
export const analyticsRoutes = new Hono<AppEnv>();
