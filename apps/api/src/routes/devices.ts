import {
  DEVICE_LINK_TTL_MS,
  DEVICE_TOKEN_TTL_MS,
  RedeemDeviceLinkRequest,
  UpdateDevicePushRequest,
  formatLinkCode,
  normalizeLinkCode,
  type Device,
  type DeviceLink,
  type DeviceView,
} from "@muselaunch/contracts";
import { newId } from "@muselaunch/db";
import { AppError, deviceSecretHash, devicesOf, newDeviceToken, newLinkCode, type AuthUser, type Platform } from "@muselaunch/platform";
import { Hono } from "hono";
import { z } from "zod";
import { body, type AppEnv, type Ctx } from "../context";
import { clientIp, webSessionOnly } from "../middleware";
import { ensureUser } from "../services/workspaces";

/**
 * The phone app's sign-in: link a phone from the web, no passwords on the phone.
 *
 *   POST   /v1/me/device-links        (web session) → an 8-character code, valid 10 minutes, single use,
 *                                     and the QR text (`muselaunch://link?code=…`). A new code replaces
 *                                     the person's unused one. 5 per 10 minutes per person.
 *   POST   /v1/device-links/redeem    (public) {code, deviceName, platform} → a long random phone token
 *                                     (`mld_…`, 90 days). 10 tries per 10 minutes per address; the code
 *                                     is used up in the same transaction that creates the phone.
 *   GET    /v1/me/devices             the person's linked phones (web: Settings → Phone app).
 *   DELETE /v1/me/devices/:deviceId   remove one (a phone may only remove itself).
 *   GET    /v1/me/device              the phone asking (phone only).
 *   DELETE /v1/me/device              "Unlink this phone" (phone only).
 *   PUT    /v1/me/device/push         the phone's Expo push token and its notifications switch.
 *
 * Only SHA-256 hashes of codes and tokens are stored, as the document ids they're looked up by. A
 * wrong, used and expired code all get the same answer.
 */

const MINUTE = 60_000;

/** Sliding-window limits, per process (Cloud Run instances each keep their own). */
const windows = new WeakMap<Platform, Map<string, number[]>>();
function allow(p: Platform, key: string, max: number, windowMs: number, now = Date.now()): boolean {
  let m = windows.get(p);
  if (!m) windows.set(p, (m = new Map()));
  const hits = (m.get(key) ?? []).filter((t) => now - t < windowMs);
  if (hits.length >= max) {
    m.set(key, hits);
    return false;
  }
  hits.push(now);
  m.set(key, hits);
  if (m.size > 20_000) m.clear();
  return true;
}

const tooMany = (c: Ctx, retrySec: number, what: string) => {
  c.header("retry-after", String(retrySec));
  return new AppError("RATE_LIMITED", `Too many ${what}`, { userMessage: `Too many tries. Wait ${Math.ceil(retrySec / 60)} minutes and try again.` });
};

const emailOf = (u: Pick<AuthUser, "email">) => (u.email && z.email().safeParse(u.email).success ? u.email : undefined);

function view(d: Device, currentId?: string): DeviceView {
  return {
    id: d.id,
    name: d.name,
    platform: d.platform,
    createdAt: d.createdAt,
    ...(d.lastUsedAt ? { lastUsedAt: d.lastUsedAt } : {}),
    expiresAt: d.expiresAt,
    notifications: { enabled: d.push.enabled, registered: Boolean(d.push.token) },
    current: d.id === currentId,
  };
}

async function liveDevices(p: Platform, uid: string, now = Date.now()): Promise<Device[]> {
  return (await devicesOf(p.db, uid)).filter((d) => Date.parse(d.expiresAt) > now);
}

/** The phone making this request (phone tokens only). */
async function currentDevice(c: Ctx): Promise<Device> {
  const user = c.get("user");
  if (user.provider !== "device" || !user.deviceId) throw new AppError("FORBIDDEN", "Only a linked phone can do this", { userMessage: "This is for the phone app." });
  const d = (await devicesOf(c.get("platform").db, user.uid)).find((x) => x.id === user.deviceId);
  if (!d) throw new AppError("UNAUTHENTICATED", "This phone isn't linked any more");
  return d;
}

// ---------------------------------------------------------------------------
// Authenticated (/v1)
// ---------------------------------------------------------------------------

export const deviceRoutes = new Hono<AppEnv>();

deviceRoutes.post("/me/device-links", webSessionOnly, async (c) => {
  const p = c.get("platform");
  const user = c.get("user");
  if (!allow(p, `link:${user.uid}`, 5, 10 * MINUTE)) throw tooMany(c, 600, "link codes");
  await ensureUser(p, user);
  const now = Date.now();
  // One live code per person: a new one replaces their unused ones (and tidies away old ones).
  const mine = await p.db.top("deviceLinks").list({ where: [["userId", "==", user.uid]], limit: 50 });
  for (const l of mine.items) if (!l.usedAt || now - Date.parse(l.createdAt) > 86_400_000) await p.db.top("deviceLinks").delete(l.id);
  const code = newLinkCode();
  const at = new Date(now).toISOString();
  const link: DeviceLink = {
    id: deviceSecretHash("code", code),
    userId: user.uid,
    email: emailOf(user),
    emailVerified: user.emailVerified,
    displayName: user.name?.slice(0, 120),
    createdAt: at,
    updatedAt: at,
    expiresAt: new Date(now + DEVICE_LINK_TTL_MS).toISOString(),
  };
  await p.db.top("deviceLinks").set(link.id, link);
  const qr = `muselaunch://link?code=${code}&api=${encodeURIComponent(p.cfg.API_PUBLIC_URL)}`;
  return c.json({ code: formatLinkCode(code), expiresAt: link.expiresAt, qr }, 201);
});

deviceRoutes.get("/me/devices", async (c) => {
  const user = c.get("user");
  const items = (await liveDevices(c.get("platform"), user.uid)).map((d) => view(d, user.deviceId));
  return c.json({ items });
});

deviceRoutes.delete("/me/devices/:deviceId", async (c) => {
  const p = c.get("platform");
  const user = c.get("user");
  const d = (await devicesOf(p.db, user.uid)).find((x) => x.id === c.req.param("deviceId"));
  if (!d) throw new AppError("NOT_FOUND", "Phone not found");
  if (user.provider === "device" && d.id !== user.deviceId) throw new AppError("FORBIDDEN", "A phone can only unlink itself", { userMessage: "Remove other phones from MuseLaunch on the web." });
  await p.db.top("devices").delete(d.tokenHash);
  p.log.info({ uid: user.uid, deviceId: d.id, by: user.provider }, "phone unlinked");
  return c.json({ ok: true });
});

deviceRoutes.get("/me/device", async (c) => {
  const d = await currentDevice(c);
  return c.json({ device: view(d, d.id) });
});

deviceRoutes.delete("/me/device", async (c) => {
  const d = await currentDevice(c);
  await c.get("platform").db.top("devices").delete(d.tokenHash);
  c.get("platform").log.info({ uid: d.userId, deviceId: d.id, by: "device" }, "phone unlinked");
  return c.json({ ok: true });
});

deviceRoutes.put("/me/device/push", async (c) => {
  const p = c.get("platform");
  const d = await currentDevice(c);
  const input = await body(c, UpdateDevicePushRequest);
  const token = input.token === undefined ? d.push.token : (input.token ?? undefined);
  if (token && token !== d.push.token) {
    // The same phone linked again (maybe as someone else): only the newest link gets its pushes.
    const others = await p.db.top("devices").list({ where: [["push.token", "==", token]], limit: 20 });
    for (const o of others.items) if (o.tokenHash !== d.tokenHash) await p.db.top("devices").update(o.tokenHash, { push: { enabled: o.push.enabled, updatedAt: new Date().toISOString() } });
  }
  const updated = await p.db.top("devices").update(d.tokenHash, { push: { token, enabled: input.enabled ?? d.push.enabled, updatedAt: new Date().toISOString() } });
  return c.json({ device: view(updated, updated.id) });
});

// ---------------------------------------------------------------------------
// Public (/v1/device-links): the phone has no token yet
// ---------------------------------------------------------------------------

export const publicDeviceRoutes = new Hono<AppEnv>();

publicDeviceRoutes.post("/redeem", async (c) => {
  const p = c.get("platform");
  if (!allow(p, `redeem:${clientIp(c)}`, 10, 10 * MINUTE)) throw tooMany(c, 600, "link attempts");
  const input = await body(c, RedeemDeviceLinkRequest);
  const invalid = () =>
    new AppError("BAD_REQUEST", "Invalid or expired link code", {
      userMessage: "That code didn’t work. A code lasts 10 minutes and works once: make a new one in MuseLaunch on the web (Settings → Phone app).",
    });
  const code = normalizeLinkCode(input.code);
  if (!code) throw invalid();
  const linkId = deviceSecretHash("code", code);
  const token = newDeviceToken();
  const tokenHash = deviceSecretHash("token", token);
  const now = Date.now();
  const at = new Date(now).toISOString();
  const made = await p.db.runTransaction(async (tx) => {
    const link = await tx.getTop("deviceLinks", linkId);
    if (!link || link.usedAt || Date.parse(link.expiresAt) <= now) return null;
    const profile = await tx.getTop("users", link.userId);
    if (!profile) return null;
    const device: Device = {
      id: newId("dev"),
      tokenHash,
      userId: link.userId,
      email: link.email ?? profile.email,
      emailVerified: link.emailVerified,
      displayName: link.displayName ?? profile.displayName,
      name: input.deviceName,
      platform: input.platform,
      appVersion: input.appVersion,
      createdAt: at,
      updatedAt: at,
      lastUsedAt: at,
      expiresAt: new Date(now + DEVICE_TOKEN_TTL_MS).toISOString(),
      push: { enabled: true },
    };
    tx.setTop("deviceLinks", linkId, { ...link, usedAt: at, updatedAt: at, deviceId: device.id });
    tx.setTop("devices", tokenHash, device);
    return { device, profile };
  });
  if (!made) throw invalid();
  p.log.info({ uid: made.device.userId, deviceId: made.device.id, platform: made.device.platform }, "phone linked");
  return c.json(
    {
      token,
      device: view(made.device, made.device.id),
      user: { id: made.profile.id, ...(made.profile.email ? { email: made.profile.email } : {}), ...(made.profile.displayName ? { displayName: made.profile.displayName } : {}) },
    },
    201,
  );
});
