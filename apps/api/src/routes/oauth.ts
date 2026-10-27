import { Hono } from "hono";
import type { AppEnv } from "../context";

/**
 * Owner: module E (Growth & Distribution) — PUBLIC (unauthenticated) OAuth callbacks,
 * mounted at /v1/oauth. Validate `state` (signed, bound to workspace + user + nonce) before
 * exchanging codes; store tokens only via platform.secrets.
 */
export const oauthRoutes = new Hono<AppEnv>();
