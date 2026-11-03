import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { DEVICE_LINK_ALPHABET, DEVICE_LINK_CODE_LENGTH, DEVICE_TOKEN_PREFIX, type Device } from "@muselaunch/contracts";
import type { Db } from "@muselaunch/db";
import type { AuthUser } from "./auth";
import { AppError } from "./errors";

/**
 * Linked phones (the MuseLaunch phone app): token and code primitives, and checking a phone's
 * `Bearer mld_…` token. Only SHA-256 hashes are stored; a token is looked up by its hash (the
 * document id), so nothing secret is ever compared character by character against stored data.
 */

/** sha256 hex of a phone token or a normalised link code (namespaced so the two never collide). */
export function deviceSecretHash(kind: "token" | "code", secret: string): string {
  return createHash("sha256").update(`muselaunch:${kind}:${secret}`).digest("hex");
}

/** A new phone token: `mld_` + 32 random bytes (base64url, 43 characters). */
export function newDeviceToken(): string {
  return `${DEVICE_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
}

/** A new 8-character link code from the unambiguous alphabet (uniform per character). */
export function newLinkCode(): string {
  let s = "";
  for (let i = 0; i < DEVICE_LINK_CODE_LENGTH; i++) s += DEVICE_LINK_ALPHABET[randomInt(DEVICE_LINK_ALPHABET.length)];
  return s;
}

/** Shape check before any lookup: `mld_` + 43 base64url characters. */
export const isDeviceTokenShape = (token: string) => /^mld_[A-Za-z0-9_-]{43}$/.test(token);

/** How often `lastUsedAt` is written (not on every request). */
const TOUCH_MS = 10 * 60_000;

/**
 * Check a phone token and return the person it acts for. Unknown, malformed, removed and expired
 * tokens are all "invalid or expired" (no oracle); an expired token's record is deleted.
 */
export async function verifyDeviceToken(db: Db, token: string, now = Date.now()): Promise<AuthUser & { device: Device }> {
  if (!isDeviceTokenShape(token)) throw new AppError("UNAUTHENTICATED", "Invalid or expired phone link");
  const hash = deviceSecretHash("token", token);
  const device = await db.top("devices").get(hash);
  // The hash is the document id; this compare is belt and braces against a store returning another doc.
  if (!device || device.tokenHash.length !== hash.length || !timingSafeEqual(Buffer.from(device.tokenHash), Buffer.from(hash))) {
    throw new AppError("UNAUTHENTICATED", "Invalid or expired phone link");
  }
  if (Date.parse(device.expiresAt) <= now) {
    await db.top("devices").delete(hash).catch(() => {});
    throw new AppError("UNAUTHENTICATED", "This phone's link expired. Link it again from MuseLaunch on the web.");
  }
  let current = device;
  if (!device.lastUsedAt || now - Date.parse(device.lastUsedAt) > TOUCH_MS) {
    current = await db
      .top("devices")
      .update(hash, { lastUsedAt: new Date(now).toISOString() })
      .catch(() => device);
  }
  return { uid: current.userId, email: current.email, emailVerified: current.emailVerified, name: current.displayName, provider: "device", deviceId: current.id, device: current };
}

/** A person's linked phones (newest first). Unindexed equality query; sorted here. */
export async function devicesOf(db: Db, userId: string): Promise<Device[]> {
  const page = await db.top("devices").list({ where: [["userId", "==", userId]], limit: 100 });
  return page.items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
