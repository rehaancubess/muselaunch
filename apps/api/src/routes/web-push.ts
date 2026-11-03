import { RemoveWebPushRequest, WebPushSubscriptionInput, type WebPushConfig } from "@muselaunch/contracts";
import { AppError, removeWebPushSubscription, saveWebPushSubscription, sendWebPushTest, webPushKeys, webPushSubscriptionsOf, webPushView } from "@muselaunch/platform";
import { Hono } from "hono";
import { body, type AppEnv } from "../context";
import { webSessionOnly } from "../middleware";
import { ensureUser } from "../services/workspaces";
import { allow, tooMany } from "./devices";

/**
 * Notifications in the browser (Web Push; sending and storage in platform/web-push.ts).
 *
 *   GET    /v1/push/web/config      { enabled, publicKey? }: whether this server sends browser
 *                                   notifications (production without keys: enabled false).
 *   POST   /v1/me/web-push          the browser's PushSubscription JSON → saved for this person
 *                                   (upsert by sha256(endpoint)). 20 per 10 minutes per person.
 *   DELETE /v1/me/web-push          { endpoint } (this browser) or { id } (Settings → Remove).
 *   GET    /v1/me/web-push          this person's browsers: label and dates only.
 *   POST   /v1/me/web-push/test     "Notifications are on" to this person's browsers. 5 per 10 minutes.
 *
 * The /me routes need a web session: a linked phone's token can't add or remove browsers. Endpoints
 * must be https on a public host (no private, loopback or internal addresses). Nobody else's
 * browsers are ever listed, removed or sent to (someone else's id gets 404).
 */

const MINUTE = 60_000;

export const webPushRoutes = new Hono<AppEnv>();

webPushRoutes.get("/push/web/config", (c) => {
  const keys = webPushKeys(c.get("platform"));
  const out: WebPushConfig = keys ? { enabled: true, publicKey: keys.publicKey } : { enabled: false };
  return c.json(out);
});

// Matches /me/web-push itself too.
webPushRoutes.use("/me/web-push/*", webSessionOnly);

webPushRoutes.get("/me/web-push", async (c) => {
  const p = c.get("platform");
  const items = (await webPushSubscriptionsOf(p.db, c.get("user").uid)).map(webPushView);
  return c.json({ items, enabled: webPushKeys(p) !== null });
});

webPushRoutes.post("/me/web-push", async (c) => {
  const p = c.get("platform");
  const user = c.get("user");
  if (!allow(p, `webpush:${user.uid}`, 20, 10 * MINUTE)) throw tooMany(c, 600, "notification changes");
  const input = await body(c, WebPushSubscriptionInput);
  await ensureUser(p, user);
  const saved = await saveWebPushSubscription(p, user.uid, input, c.req.header("user-agent"));
  p.log.info({ uid: user.uid, sub: saved.id.slice(0, 8), label: saved.label }, "browser notifications on");
  return c.json({ browser: webPushView(saved) }, 201);
});

webPushRoutes.delete("/me/web-push", async (c) => {
  const p = c.get("platform");
  const user = c.get("user");
  if (!allow(p, `webpush-del:${user.uid}`, 30, 10 * MINUTE)) throw tooMany(c, 600, "notification changes");
  const input = await body(c, RemoveWebPushRequest);
  await removeWebPushSubscription(p, user.uid, input);
  p.log.info({ uid: user.uid }, "browser notifications off");
  return c.json({ ok: true });
});

webPushRoutes.post("/me/web-push/test", async (c) => {
  const p = c.get("platform");
  const user = c.get("user");
  if (!webPushKeys(p)) throw new AppError("PROVIDER_NOT_CONFIGURED", "Web push is off on this server", { userMessage: "Notifications in the browser aren’t set up on this server yet." });
  if (!allow(p, `webpush-test:${user.uid}`, 5, 10 * MINUTE)) throw tooMany(c, 600, "test notifications");
  const result = await sendWebPushTest(p, user.uid);
  if (!result.browsers) throw new AppError("NOT_FOUND", "No browsers with notifications on", { userMessage: "Turn notifications on in this browser first." });
  return c.json({ result });
});
