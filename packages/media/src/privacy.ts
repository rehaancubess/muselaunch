import type { PrivacyFinding } from "@muselaunch/contracts";
import { z } from "zod";

/**
 * What counts as private on real product media (screen recordings, screenshots). Shared by the
 * walkthrough labeller and the screenshot check so a recording and a screenshot of the same screen are
 * judged the same way. Indie developers record their real dashboards: secrets matter as much as names.
 */
export const PRIVACY_RULES = `privacy: flagged = true when anything personal or secret is readable:
  - personal information: notification banners, people's names, email addresses, phone numbers, street addresses, private messages, photos of people, avatars with names;
  - secrets: API keys and tokens (e.g. strings starting sk_, pk_live_, rk_, ghp_, xox, AKIA, AIza, eyJ), passwords or password fields with visible characters, .env / config values, webhook signing secrets, database URLs with credentials, SSH keys, 2FA / recovery codes, QR codes for login;
  - money and accounts: card or bank numbers, account ids, invoices, customer lists, real revenue / MRR / payout / balance figures in Stripe, RevenueCat, App Store Connect or Play Console dashboards, customer emails in analytics tables.
  For each item give a region (x, y, w, h as 0–1 fractions of the image, origin top-left) that fully covers it with a small margin, and a short note naming what it is (never repeat the secret itself). Obvious sample/demo content (lorem ipsum, "Jane Doe", placeholder keys like sk_test_xxx shown as an example) is not private.`;

/** Spark output for one image's privacy check. Slightly out-of-range boxes are clamped afterwards, not rejected. */
export const PrivacyOut = z
  .object({
    flagged: z.boolean(),
    notes: z.string().max(300).optional(),
    regions: z.array(z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).describe("0–1 fractions of the image, origin top-left")).max(8).default([]),
  })
  .default({ flagged: false, regions: [] });
export type PrivacyOut = z.infer<typeof PrivacyOut>;

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const r4 = (v: number) => Math.round(v * 10_000) / 10_000;

/** Clamp to the image, drop empty boxes, at most 8. */
export function cleanRegions(regions: { x: number; y: number; w: number; h: number }[]): PrivacyFinding["regions"] {
  return regions
    .map((r) => {
      const x = clamp01(r.x);
      const y = clamp01(r.y);
      return { x: r4(x), y: r4(y), w: r4(clamp01(Math.min(r.w, 1 - x))), h: r4(clamp01(Math.min(r.h, 1 - y))) };
    })
    .filter((r) => r.w > 0.005 && r.h > 0.005)
    .slice(0, 8);
}

export function cleanPrivacy(p: PrivacyOut): PrivacyFinding {
  const regions = cleanRegions(p.regions);
  return { flagged: p.flagged || regions.length > 0, notes: p.notes?.slice(0, 300) || undefined, regions };
}

/**
 * Regions of an image re-expressed in a crop of it (crop in image pixels). Regions outside the crop
 * disappear; a region cut by the crop edge keeps its visible part.
 */
export function regionsInCrop(regions: PrivacyFinding["regions"], image: { width: number; height: number }, crop: { x: number; y: number; w: number; h: number }): PrivacyFinding["regions"] {
  return cleanRegions(
    regions
      .map((r) => {
        const x0 = (r.x * image.width - crop.x) / crop.w;
        const y0 = (r.y * image.height - crop.y) / crop.h;
        const x1 = ((r.x + r.w) * image.width - crop.x) / crop.w;
        const y1 = ((r.y + r.h) * image.height - crop.y) / crop.h;
        const x = clamp01(x0);
        const y = clamp01(y0);
        return { x, y, w: clamp01(x1) - x, h: clamp01(y1) - y };
      })
      .filter((r) => r.w > 0 && r.h > 0),
  );
}
