import { Hono } from "hono";
import type { AppEnv } from "../context";

/**
 * Owner: module F (Analytics) — PUBLIC tracked-link redirects, mounted at /r.
 * GET /r/:slug → 302 to the destination with UTMs, increments click counters.
 * Must be cheap, never leak workspace data, and only redirect to stored destinations.
 */
export const publicLinkRoutes = new Hono<AppEnv>();
