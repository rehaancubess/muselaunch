import { Hono } from "hono";
import type { AppEnv } from "../context";

/**
 * Owner: module E (Growth): calendar, scheduled posts, approvals, connections, publications, outreach.
 * Mounted under /v1/workspaces/:workspaceId (workspace scope + membership already enforced).
 * Use requireCap(...) for writes, body(c, Schema) for input, and return contract-shaped JSON.
 */
export const publishingRoutes = new Hono<AppEnv>();
