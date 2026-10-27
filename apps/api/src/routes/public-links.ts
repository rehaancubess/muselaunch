import { resolveAndCount, shouldThrottle } from "@muselaunch/analytics";
import { Hono } from "hono";
import type { AppEnv } from "../context";

/**
 * Owner: module F (Analytics) — PUBLIC tracked-link redirects, mounted at /r.
 * GET /r/:slug → 302 to the destination with UTMs, increments click counters.
 * Must be cheap, never leak workspace data, and only redirect to stored destinations.
 * No IPs or raw user agents are stored: the client address is only hashed in memory to
 * throttle rapid repeats, and only a coarse user-agent class is counted.
 */
export const publicLinkRoutes = new Hono<AppEnv>();

publicLinkRoutes.on(["GET", "HEAD"], "/:slug", async (c) => {
  const p = c.get("platform");
  const slug = c.req.param("slug").toLowerCase();
  const client = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || c.req.header("x-real-ip");
  const out = await resolveAndCount(p, slug, {
    method: c.req.method,
    userAgent: c.req.header("user-agent"),
    throttled: c.req.method === "GET" && shouldThrottle(client, slug),
  });
  c.header("cache-control", "no-store");
  c.header("x-robots-tag", "noindex, nofollow");
  if (!out) return c.text("This link doesn't exist or is no longer active.", 404);
  return c.redirect(out.redirectUrl, 302);
});
