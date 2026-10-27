import type { Platform } from "@muselaunch/platform";
import { AppError } from "@muselaunch/platform";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import type { AppEnv } from "./context";
import { accessLog, authenticate, errorResponse, rateLimit, requestId, workspaceScope } from "./middleware";
import { analyticsRoutes } from "./routes/analytics";
import { appDnaRoutes } from "./routes/app-dna";
import { appRoutes } from "./routes/apps";
import { assetRoutes } from "./routes/assets";
import { adminRoutes, billingRoutes } from "./routes/billing";
import { campaignRoutes } from "./routes/campaigns";
import { compositionRoutes } from "./routes/compositions";
import { creditRoutes } from "./routes/core-billing";
import { discoverRoutes } from "./routes/discover";
import { jobRoutes } from "./routes/jobs";
import { meRoutes } from "./routes/me";
import { mediaRoutes } from "./routes/media";
import { oauthRoutes } from "./routes/oauth";
import { publicLinkRoutes } from "./routes/public-links";
import { publishingRoutes } from "./routes/publishing";
import { statusRoutes } from "./routes/status";
import { localStorageRoutes } from "./routes/storage-local";
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

  app.get("/health", (c) => c.json({ ok: true, service: "api", db: platform.db.driver, storage: platform.storage.driver, jobs: platform.jobs.dispatchMode }));

  // Public, unauthenticated surfaces (each validates its own signed tokens).
  app.route("/v1/storage/local", localStorageRoutes);
  app.route("/v1/oauth", oauthRoutes);
  app.route("/r", publicLinkRoutes);

  // Authenticated API.
  const v1 = new Hono<AppEnv>();
  v1.use("*", authenticate);
  v1.use("*", rateLimit({ perMinute: 240 }));
  v1.route("/", meRoutes);
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
  ws.route("/", compositionRoutes);
  ws.route("/", mediaRoutes);
  ws.route("/", discoverRoutes);
  ws.route("/", publishingRoutes);
  ws.route("/", analyticsRoutes);
  ws.route("/", billingRoutes);
  v1.route("/workspaces/:workspaceId", ws);

  app.route("/v1", v1);
  return app;
}
