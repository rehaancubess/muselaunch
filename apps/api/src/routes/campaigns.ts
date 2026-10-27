import { Hono } from "hono";
import type { AppEnv } from "../context";

/**
 * Owner: module B (Intelligence): campaigns, concepts, briefs, storyboards, copy packs, strategy runs, agent runs.
 * Mounted under /v1/workspaces/:workspaceId (workspace scope + membership already enforced).
 * Use requireCap(...) for writes, body(c, Schema) for input, and return contract-shaped JSON.
 */
export const campaignRoutes = new Hono<AppEnv>();
