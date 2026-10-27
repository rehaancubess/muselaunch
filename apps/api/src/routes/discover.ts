import { Hono } from "hono";
import type { AppEnv } from "../context";

/**
 * Owner: module E (Growth): research runs, opportunities, tracked creators, competitors feed, creator prospects.
 * Mounted under /v1/workspaces/:workspaceId (workspace scope + membership already enforced).
 * Use requireCap(...) for writes, body(c, Schema) for input, and return contract-shaped JSON.
 */
export const discoverRoutes = new Hono<AppEnv>();
