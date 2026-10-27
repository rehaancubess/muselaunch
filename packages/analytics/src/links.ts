import { createHash, randomBytes } from "node:crypto";
import type { App, AttributionLink, Campaign, CreateTrackedLinkRequest } from "@muselaunch/contracts";
import { nowIso } from "@muselaunch/db";
import { AppError, assertSafeUrl, type Platform } from "@muselaunch/platform";
import { z } from "zod";
import { CLICK_DEFINITION } from "./metrics";
import { DAY_MS, makeDedupKey, observationIdFor, utcDayStart } from "./observations";

/**
 * Global slug registry (`ops/link.<slug>`): the public redirect needs one read and never touches
 * workspace data beyond the link it resolves. Holds no PII.
 */
export const LinkRegistry = z.object({
  workspaceId: z.string(),
  linkId: z.string(),
  appId: z.string(),
  campaignId: z.string(),
  redirectUrl: z.string(),
  active: z.boolean(),
  createdAt: z.string(),
});
export type LinkRegistry = z.infer<typeof LinkRegistry>;

const registryKey = (slug: string) => `link.${slug}`;
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{2,38}[a-z0-9]$/;
const SLUG_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

function randomSlug(len = 8): string {
  const bytes = randomBytes(len);
  let s = "";
  for (let i = 0; i < len; i++) s += SLUG_ALPHABET[bytes[i]! % SLUG_ALPHABET.length];
  return s;
}

const bareHost = (h: string) => h.toLowerCase().replace(/^www\./, "");

/** True when `candidate` points at the same app destination as `own` (store app id or site host). */
export function sameDestination(own: string | undefined, candidate: string): boolean {
  if (!own) return false;
  let a: URL;
  let b: URL;
  try {
    a = new URL(own);
    b = new URL(candidate);
  } catch {
    return false;
  }
  const ha = bareHost(a.hostname);
  const hb = bareHost(b.hostname);
  if (ha === "apps.apple.com" || ha === "itunes.apple.com") {
    const ida = /id(\d{5,})/.exec(a.pathname)?.[1];
    const idb = /id(\d{5,})/.exec(b.pathname)?.[1];
    return (hb === "apps.apple.com" || hb === "itunes.apple.com") && Boolean(ida) && ida === idb;
  }
  if (ha === "play.google.com") {
    return hb === "play.google.com" && Boolean(a.searchParams.get("id")) && a.searchParams.get("id") === b.searchParams.get("id");
  }
  return hb === ha || hb.endsWith(`.${ha}`);
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 120) || "campaign";
}

/**
 * Final redirect URL. Websites get standard utm_* params (existing ones are kept). Google Play
 * links get the documented `referrer` parameter so Play's install referrer can attribute installs.
 * App Store links are left unchanged: Apple campaign attribution needs a provider token (`pt`)
 * from App Store Connect, which MuseLaunch doesn't have.
 */
export function buildRedirectUrl(destination: string, utm: AttributionLink["utm"]): string {
  const url = new URL(destination);
  const host = bareHost(url.hostname);
  const params: [string, string | undefined][] = [
    ["utm_source", utm.source],
    ["utm_medium", utm.medium],
    ["utm_campaign", utm.campaign],
    ["utm_content", utm.content],
  ];
  if (host === "play.google.com") {
    if (!url.searchParams.has("referrer")) {
      const ref = new URLSearchParams(params.filter((p): p is [string, string] => Boolean(p[1])));
      url.searchParams.set("referrer", ref.toString());
    }
    return url.toString();
  }
  if (host === "apps.apple.com" || host === "itunes.apple.com") return url.toString();
  for (const [k, v] of params) if (v && !url.searchParams.has(k)) url.searchParams.set(k, v);
  return url.toString();
}

function ownDestination(app: App, kind: "ios" | "android" | "website"): string | undefined {
  return kind === "ios" ? app.storeUrls.ios : kind === "android" ? app.storeUrls.android : app.websiteUrl;
}

export async function createTrackedLink(p: Platform, workspaceId: string, campaignId: string, input: CreateTrackedLinkRequest, actor: string): Promise<AttributionLink> {
  const ws = p.db.ws(workspaceId);
  const campaign: Campaign = await ws.collection("campaigns").getOrThrow(campaignId);
  const app = await ws.collection("apps").getOrThrow(campaign.appId);
  let destinationUrl: string;
  let destinationKind: AttributionLink["destinationKind"];
  let destinationConfirmedBy: string | undefined;
  if (input.destination) {
    const own = ownDestination(app, input.destination);
    if (!own) throw new AppError("BAD_REQUEST", `App has no ${input.destination} URL`, { userMessage: `Add the app's ${input.destination === "website" ? "website" : `${input.destination === "ios" ? "App Store" : "Google Play"} link`} first.` });
    destinationUrl = own;
    destinationKind = input.destination;
  } else if (input.destinationUrl) {
    destinationUrl = input.destinationUrl;
    const kinds = (["ios", "android", "website"] as const).filter((k) => sameDestination(ownDestination(app, k), input.destinationUrl!));
    if (kinds.length) destinationKind = kinds[0];
    else {
      if (!input.confirmExternalDestination) {
        throw new AppError("VALIDATION_FAILED", "Destination is not one of this app's own URLs", {
          userMessage: "This link doesn't go to your app's store page or website. Confirm the destination to use it anyway.",
          details: { needsConfirmation: true },
        });
      }
      destinationKind = "other";
      destinationConfirmedBy = actor;
    }
  } else throw new AppError("BAD_REQUEST", "Choose a destination");
  assertSafeUrl(destinationUrl);
  if (input.publicationId) {
    const pub = await ws.collection("publications").getOrThrow(input.publicationId);
    if (pub.campaignId !== campaignId) throw new AppError("BAD_REQUEST", "Publication belongs to another campaign");
  }
  if (input.scheduledPostId) {
    const post = await ws.collection("scheduledPosts").getOrThrow(input.scheduledPostId);
    if (post.campaignId !== campaignId) throw new AppError("BAD_REQUEST", "Post belongs to another campaign");
  }
  const utm = { source: input.utm.source, medium: input.utm.medium, campaign: input.utm.campaign ?? slugify(campaign.name), content: input.utm.content };
  const redirectUrl = buildRedirectUrl(destinationUrl, utm);
  const repo = ws.collection("attributionLinks");

  for (let attempt = 0; attempt < 5; attempt++) {
    const slug = input.slug ?? randomSlug();
    const id = repo.newId();
    try {
      return await p.db.runTransaction(async (tx) => {
        if (await tx.getGlobal(registryKey(slug), LinkRegistry)) throw new AppError("ALREADY_EXISTS", "Slug is taken", { userMessage: "That link name is taken. Try another." });
        const link = tx.create(
          workspaceId,
          "attributionLinks",
          { id, appId: app.id, campaignId, publicationId: input.publicationId, scheduledPostId: input.scheduledPostId, slug, destinationUrl, utm, clickCount: 0, active: true, destinationKind, destinationConfirmedBy, redirectUrl, channel: input.channel, uaClassCounts: {} },
          { actor },
        );
        tx.setGlobal(registryKey(slug), LinkRegistry, { workspaceId, linkId: id, appId: app.id, campaignId, redirectUrl, active: true, createdAt: nowIso() });
        return link;
      });
    } catch (err) {
      if (err instanceof AppError && err.code === "ALREADY_EXISTS" && !input.slug) continue;
      throw err;
    }
  }
  throw new AppError("CONFLICT", "Could not allocate a link slug");
}

export async function setLinkActive(p: Platform, workspaceId: string, linkId: string, active: boolean, actor: string): Promise<AttributionLink> {
  return p.db.runTransaction(async (tx) => {
    const link = await tx.get(workspaceId, "attributionLinks", linkId);
    if (!link) throw new AppError("NOT_FOUND", "Link not found");
    const reg = await tx.getGlobal(registryKey(link.slug), LinkRegistry);
    const updated = tx.update(workspaceId, "attributionLinks", linkId, { active }, { actor });
    if (reg && reg.workspaceId === workspaceId && reg.linkId === linkId) tx.setGlobal(registryKey(link.slug), LinkRegistry, { ...reg, active });
    return updated;
  });
}

export type UaClass = "mobile" | "desktop" | "bot" | "other";

const BOT_RE =
  /bot\b|bot\/|crawler|spider|crawl|slurp|facebookexternalhit|facebot|meta-externalagent|whatsapp|telegram|discord|embedly|quora link preview|skypeuripreview|vkshare|pinterest|redditbot|preview|headless|lighthouse|curl\/|wget|python-requests|python-urllib|go-http-client|okhttp|java\/|node-fetch|axios|undici|postman/i;

/** Coarse class only; the raw user agent is never stored. */
export function classifyUserAgent(ua: string | undefined): UaClass {
  if (!ua) return "other";
  if (BOT_RE.test(ua)) return "bot";
  if (/mobile|iphone|ipad|ipod|android/i.test(ua)) return "mobile";
  if (/windows|macintosh|mac os x|linux|cros/i.test(ua)) return "desktop";
  return "other";
}

/** Per-instance throttle keyed by an in-memory hash (never persisted) to stop click inflation. */
const throttle = new Map<string, { n: number; at: number }>();
export function shouldThrottle(clientKey: string | undefined, slug: string, perMinute = 20): boolean {
  if (!clientKey) return false;
  const k = createHash("sha256").update(`${clientKey}:${slug}`).digest("base64url").slice(0, 16);
  const now = Date.now();
  const cur = throttle.get(k);
  if (!cur || now - cur.at > 60_000) {
    throttle.set(k, { n: 1, at: now });
    if (throttle.size > 20_000) throttle.clear();
    return false;
  }
  cur.n++;
  return cur.n > perMinute;
}

/**
 * Resolve a public slug and (for GET) count the click atomically: the link's counters and the
 * per-UTC-day `clicks` observation (attribution `link`) change in one transaction.
 * Bots and throttled repeats are tallied by class only and never counted as clicks.
 */
export async function resolveAndCount(p: Platform, slug: string, opts: { method: string; userAgent?: string; throttled?: boolean; now?: number }): Promise<{ redirectUrl: string } | null> {
  if (!SLUG_RE.test(slug)) return null;
  const reg = await p.db.global(registryKey(slug), LinkRegistry).get();
  if (!reg || !reg.active) return null;
  if (opts.method !== "GET") return { redirectUrl: reg.redirectUrl };
  const cls: UaClass | "throttled" = opts.throttled ? "throttled" : classifyUserAgent(opts.userAgent);
  const human = cls === "mobile" || cls === "desktop" || cls === "other";
  const now = opts.now ?? Date.now();
  const dayStart = utcDayStart(now);
  const windowStart = new Date(dayStart).toISOString();
  const windowEnd = new Date(dayStart + DAY_MS).toISOString();
  const dedupKey = makeDedupKey(`link:${reg.linkId}`, windowStart, windowEnd);
  const obsId = observationIdFor(dedupKey);
  try {
    await p.db.runTransaction(async (tx) => {
      const link = await tx.get(reg.workspaceId, "attributionLinks", reg.linkId);
      if (!link || !link.active) return;
      const obs = human ? await tx.get(reg.workspaceId, "metricObservations", obsId) : null;
      const at = new Date(now).toISOString();
      tx.update(
        reg.workspaceId,
        "attributionLinks",
        link.id,
        { clickCount: link.clickCount + (human ? 1 : 0), lastClickAt: human ? at : link.lastClickAt, uaClassCounts: { ...link.uaClassCounts, [cls]: (link.uaClassCounts[cls] ?? 0) + 1 } },
        { actor: "system:link" },
      );
      if (!human) return;
      if (obs) tx.update(reg.workspaceId, "metricObservations", obsId, { value: obs.value + 1, provenance: { ...obs.provenance, fetchedAt: at } }, { actor: "system:link" });
      else
        tx.create(
          reg.workspaceId,
          "metricObservations",
          {
            id: obsId,
            appId: link.appId,
            campaignId: link.campaignId,
            publicationId: link.publicationId,
            source: "tracked_link",
            metric: "clicks",
            metricDefinition: CLICK_DEFINITION,
            value: 1,
            unit: "count",
            windowStart,
            windowEnd,
            timezone: "UTC",
            channel: link.channel,
            attribution: "link",
            externalAccountId: link.id,
            provenance: { imported: false, fetchedAt: at },
            dedupKey,
          },
          { actor: "system:link" },
        );
    });
  } catch (err) {
    // Never block the visitor's redirect on a counting failure; it is logged for ops.
    p.log.warn({ err, slug }, "click count failed");
  }
  return { redirectUrl: reg.redirectUrl };
}
