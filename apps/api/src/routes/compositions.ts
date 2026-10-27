import { Hono } from "hono";
import type { AppEnv } from "../context";

/**
 * Owner: module C (Video Studio): compositions, versions, patches, undo/redo, preview/render, exports.
 * Mounted under /v1/workspaces/:workspaceId (workspace scope + membership already enforced).
 * Use requireCap(...) for writes, body(c, Schema) for input, and return contract-shaped JSON.
 */
export const compositionRoutes = new Hono<AppEnv>();
