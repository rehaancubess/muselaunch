import { completeConnection } from "@muselaunch/growth";
import { Hono } from "hono";
import type { AppEnv } from "../context";

/**
 * Owner: module E (Growth & Distribution) — PUBLIC (unauthenticated) OAuth callbacks,
 * mounted at /v1/oauth. Validate `state` (signed, bound to workspace + user + nonce) before
 * exchanging codes; store tokens only via platform.secrets.
 *
 * Register `${API_PUBLIC_URL}/v1/oauth/<provider>/callback` as the redirect URI with each provider.
 * A tampered/expired/replayed state is rejected with 403 before any code exchange.
 */
export const oauthRoutes = new Hono<AppEnv>();

oauthRoutes.get("/:provider/callback", async (c) => {
  const q = c.req.query();
  const result = await completeConnection(c.get("platform"), c.req.param("provider"), {
    code: q.code,
    state: q.state,
    error: q.error,
    error_description: q.error_description ?? q.error_message,
  });
  c.header("cache-control", "no-store");
  c.header("referrer-policy", "no-referrer");
  return c.redirect(result.redirect, 302);
});
