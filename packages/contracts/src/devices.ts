import { z } from "zod";
import { Id, IsoDateTime } from "./common";

/**
 * The phone app (mobile/): linked from the web, never signed in with a password.
 *
 *  1. A signed-in person asks for a link code on the web (Settings → Phone app): 8 characters, valid
 *     10 minutes, single use. Only its hash is stored (`deviceLinks/{sha256(code)}`).
 *  2. The phone redeems the code (scanned from the QR or typed) and gets a long random device token
 *     (`mld_…`). Only its hash is stored (`devices/{sha256(token)}`); it expires after 90 days and
 *     is revoked by removing the device (web) or unlinking (phone).
 *  3. The API accepts `Authorization: Bearer mld_<token>` as that person, alongside Firebase tokens.
 *
 * Push notifications go to a device's Expo push token when the person kept them on.
 */

export const DEVICE_TOKEN_PREFIX = "mld_";
export const DEVICE_LINK_CODE_LENGTH = 8;
/** No 0/O or 1/I/L: easy to read off a screen and type on a phone. */
export const DEVICE_LINK_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const DEVICE_LINK_TTL_MS = 10 * 60_000;
export const DEVICE_TOKEN_TTL_MS = 90 * 86_400_000;

export const DevicePlatform = z.enum(["ios", "android", "web"]);
export type DevicePlatform = z.infer<typeof DevicePlatform>;

/** `ExponentPushToken[…]` / `ExpoPushToken[…]` (what `getExpoPushTokenAsync` returns). */
export const ExpoPushToken = z
  .string()
  .max(200)
  .regex(/^Expo(nent)?PushToken\[[A-Za-z0-9_-]{8,160}\]$/, "Not an Expo push token");

/** `devices/{sha256(token)}` (top level). */
export const Device = z.object({
  /** Public id (`dev_…`), shown in lists and used to remove it. Never the token or its hash. */
  id: Id,
  tokenHash: z.string().regex(/^[a-f0-9]{64}$/),
  userId: Id,
  /** Copied from the web session that made the link code (the token acts as that person). */
  email: z.email().optional(),
  emailVerified: z.boolean().default(false),
  displayName: z.string().max(120).optional(),
  name: z.string().min(1).max(80),
  platform: DevicePlatform,
  appVersion: z.string().max(40).optional(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  lastUsedAt: IsoDateTime.optional(),
  expiresAt: IsoDateTime,
  push: z
    .object({
      /** The Expo push token; removed when Expo says the app was uninstalled (DeviceNotRegistered). */
      token: ExpoPushToken.optional(),
      /** The in-app switch ("Notifications"). */
      enabled: z.boolean().default(true),
      updatedAt: IsoDateTime.optional(),
    })
    .default({ enabled: true }),
});
export type Device = z.infer<typeof Device>;

/** `deviceLinks/{sha256(code)}` (top level): one code, single use, 10 minutes. */
export const DeviceLink = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  userId: Id,
  email: z.email().optional(),
  emailVerified: z.boolean().default(false),
  displayName: z.string().max(120).optional(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  expiresAt: IsoDateTime,
  usedAt: IsoDateTime.optional(),
  deviceId: Id.optional(),
});
export type DeviceLink = z.infer<typeof DeviceLink>;

/** A linked phone as the person sees it (no token, no hash). */
export const DeviceView = z.object({
  id: Id,
  name: z.string(),
  platform: DevicePlatform,
  createdAt: IsoDateTime,
  lastUsedAt: IsoDateTime.optional(),
  expiresAt: IsoDateTime,
  notifications: z.object({ enabled: z.boolean(), registered: z.boolean() }),
  /** The phone making this request. */
  current: z.boolean(),
});
export type DeviceView = z.infer<typeof DeviceView>;

/** POST /v1/me/device-links → the code to type, and what the QR code holds. */
export const DeviceLinkResponse = z.object({
  /** "ABCD-EFGH" (the dash is optional when typing). */
  code: z.string(),
  expiresAt: IsoDateTime,
  /** `muselaunch://link?code=ABCDEFGH&api=…` (opens the app when scanned with the phone's camera). */
  qr: z.string(),
});
export type DeviceLinkResponse = z.infer<typeof DeviceLinkResponse>;

export const RedeemDeviceLinkRequest = z.object({
  code: z.string().min(4).max(32),
  deviceName: z.string().trim().min(1).max(80),
  platform: DevicePlatform,
  appVersion: z.string().max(40).optional(),
});
export type RedeemDeviceLinkRequest = z.infer<typeof RedeemDeviceLinkRequest>;

export const RedeemDeviceLinkResponse = z.object({
  token: z.string(),
  device: DeviceView,
  user: z.object({ id: Id, email: z.string().optional(), displayName: z.string().optional() }),
});
export type RedeemDeviceLinkResponse = z.infer<typeof RedeemDeviceLinkResponse>;

/** PUT /v1/me/device/push (the phone itself): its Expo push token and the in-app switch. */
export const UpdateDevicePushRequest = z.object({
  token: ExpoPushToken.nullable().optional(),
  enabled: z.boolean().optional(),
});
export type UpdateDevicePushRequest = z.infer<typeof UpdateDevicePushRequest>;

/** Normalise what a person typed ("abcd efgh", "ABCD-EFGH") to the 8 code characters, or null. */
export function normalizeLinkCode(input: string): string | null {
  const s = input.toUpperCase().replace(/[\s-]+/g, "");
  if (s.length !== DEVICE_LINK_CODE_LENGTH) return null;
  for (const ch of s) if (!DEVICE_LINK_ALPHABET.includes(ch)) return null;
  return s;
}

/** "ABCDEFGH" → "ABCD-EFGH". */
export const formatLinkCode = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`;
