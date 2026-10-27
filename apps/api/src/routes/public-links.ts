import { INTERSTITIAL_CSP, renderInterstitial, resolveAndCount, shouldThrottle } from "@muselaunch/analytics";
import { Hono } from "hono";
import type { AppEnv } from "../context";

/**
 * Owner: module F (Analytics) — PUBLIC tracked-link redirects, mounted at /r.
 * GET /r/:slug → 302 to the app's own store page/website (with UTMs), increments click counters.
 * User-confirmed EXTERNAL destinations never get a 302 (no open redirect): they get a minimal
 * interstitial ("You're leaving to <host> — Continue") with a strict CSP. The click is counted once,
 * on the interstitial view; "Continue" links straight to the destination, not back through /r.
 * Must be cheap, never leak workspace data, and only send people to stored destinations.
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
  if (!out.external) return c.redirect(out.redirectUrl, 302);
  const page = renderInterstitial(out.redirectUrl);
  if (!page) return c.text("This link doesn't exist or is no longer active.", 404);
  c.header("content-security-policy", INTERSTITIAL_CSP);
  c.header("referrer-policy", "no-referrer");
  c.header("x-content-type-options", "nosniff");
  return c.html(page.html, 200);
});
