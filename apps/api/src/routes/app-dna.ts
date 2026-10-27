import { Hono } from "hono";
import type { AppEnv } from "../context";

/**
 * Owner: module B (Intelligence): App DNA, evidence, claims, brand kit, competitors, memory/preferences.
 * Mounted under /v1/workspaces/:workspaceId (workspace scope + membership already enforced).
 * Use requireCap(...) for writes, body(c, Schema) for input, and return contract-shaped JSON.
 */
export const appDnaRoutes = new Hono<AppEnv>();
