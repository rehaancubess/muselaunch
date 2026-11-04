import type { Platform } from "@muselaunch/platform";
import { AppError } from "@muselaunch/platform";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import type { AppEnv } from "./context";
import { accessLog, authenticate, errorResponse, rateLimit, requestId, webSessionOnly, workspaceScope } from "./middleware";
import { deviceRoutes, publicDeviceRoutes } from "./routes/devices";
import { analyticsRoutes } from "./routes/analytics";
import { appDnaRoutes } from "./routes/app-dna";
import { appRoutes } from "./routes/apps";
import { assetRoutes } from "./routes/assets";
import { alwaysOnRoutes } from "./routes/always-on";
import { appSetupRoutes } from "./routes/app-setup";
import { autopilotRoutes } from "./routes/autopilot";
import { adminRoutes, billingRoutes } from "./routes/billing";
import { campaignRoutes } from "./routes/campaigns";
import { compositionRoutes } from "./routes/compositions";
import { creditRoutes } from "./routes/core-billing";
import { createRunRoutes } from "./routes/create-runs";
import { discoverRoutes } from "./routes/discover";
import { guardianRoutes } from "./routes/guardian";
import { jobRoutes } from "./routes/jobs";
import { meRoutes } from "./routes/me";
import { mediaRoutes } from "./routes/media";
import { needsYouRoutes } from "./routes/needs-you";
import { oauthRoutes } from "./routes/oauth";
import { publicLinkRoutes } from "./routes/public-links";
import { publishingRoutes } from "./routes/publishing";
import { soundRoutes } from "./routes/sound";
import { statusRoutes } from "./routes/status";
import { todayRoutes } from "./routes/today";
import { localStorageRoutes } from "./routes/storage-local";
import { videoReviewRoutes } from "./routes/video-reviews";
import { webPushRoutes } from "./routes/web-push";
import { workspaceRoutes } from "./routes/workspace";

export function buildApp(platform: Platform) {
  const app = new Hono<AppEnv>();
  const allowedOrigins = new Set([platform.cfg.PUBLIC_WEB_URL, ...(process.env.CORS_EXTRA_ORIGINS?.split(",").filter(Boolean) ?? [])]);

  app.use("*", async (c, next) => {
    c.set("platform", platform);
    await next();
  });
  app.use("*", requestId);
  app.use("*", accessLog);
  app.use("*", secureHeaders({ crossOriginResourcePolicy: "cross-origin" }));
  app.use(
    "*",
    cors({
      origin: (origin) => (allowedOrigins.has(origin) ? origin : null),
      allowHeaders: ["authorization", "content-type", "idempotency-key", "x-request-id", "range"],
      allowMethods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
      exposeHeaders: ["x-request-id", "content-range", "accept-ranges"],
      maxAge: 600,
    }),
  );
  app.onError((err, c) => errorResponse(err, c));
  app.notFound((c) => errorResponse(new AppError("NOT_FOUND", `Route ${c.req.method} ${c.req.path} not found`), c));

  // `standIn` (only while OpenAI stands in for the Meta Model API) drives the web app's banner.
  app.get("/health", (c) =>
    c.json({ ok: true, service: "api", db: platform.db.driver, storage: platform.storage.driver, jobs: platform.jobs.dispatchMode, ...(platform.cfg.standIn ? { standIn: platform.cfg.standIn } : {}) }),
  );

  // Public, unauthenticated surfaces (each validates its own signed tokens).
  app.route("/v1/storage/local", localStorageRoutes);
  app.route("/v1/oauth", oauthRoutes);
  app.route("/r", publicLinkRoutes);
  // The phone app redeems a link code here (it has no token yet; rate-limited per address).
  app.route("/v1/device-links", publicDeviceRoutes);

  // Authenticated API (a Firebase session, or a linked phone's `mld_` token).
  const v1 = new Hono<AppEnv>();
  v1.use("*", authenticate);
  v1.use("*", rateLimit({ perMinute: 240 }));
  // A linked phone can't accept invites or open the operator console (and can't make phone links).
  v1.use("/invites/*", webSessionOnly);
  v1.use("/admin/*", webSessionOnly);
  v1.route("/", meRoutes);
  v1.route("/", deviceRoutes);
  // Notifications in the browser (Web Push): the server's public key and this person's browsers.
  v1.route("/", webPushRoutes);
  v1.route("/", statusRoutes);
  // Operator console (ADMIN_UIDS only; the routes check it themselves).
  v1.route("/admin", adminRoutes);

  // Tenant-scoped API: membership verified once here for every nested route.
  const ws = new Hono<AppEnv>();
  ws.use("*", workspaceScope);
  ws.route("/", workspaceRoutes);
  ws.route("/", creditRoutes);
  ws.route("/", assetRoutes);
  ws.route("/apps", appRoutes);
  ws.route("/", appDnaRoutes);
  ws.route("/jobs", jobRoutes);
  ws.route("/", campaignRoutes);
  ws.route("/", createRunRoutes);
  ws.route("/", autopilotRoutes);
  ws.route("/", alwaysOnRoutes);
  ws.route("/", appSetupRoutes);
  ws.route("/", compositionRoutes);
  ws.route("/", mediaRoutes);
  ws.route("/", soundRoutes);
  ws.route("/", discoverRoutes);
  ws.route("/", publishingRoutes);
  ws.route("/", analyticsRoutes);
  ws.route("/", billingRoutes);
  ws.route("/", guardianRoutes);
  ws.route("/", videoReviewRoutes);
  ws.route("/", needsYouRoutes);
  ws.route("/", todayRoutes);
  v1.route("/workspaces/:workspaceId", ws);

  app.route("/v1", v1);
  return app;
}
