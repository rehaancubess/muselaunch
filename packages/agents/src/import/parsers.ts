import type { StoreListing } from "@muselaunch/contracts";
import { load, type CheerioAPI } from "cheerio";
import { clip, isHttpUrl, sha256, uniq } from "../util";

// ---------------------------------------------------------------------------
// App Store (public iTunes Lookup API)
// ---------------------------------------------------------------------------

/** Parse `https://apps.apple.com/{cc}/app/{slug}/id{digits}` (and legacy itunes.apple.com forms). */
export function parseAppStoreUrl(raw: string): { id: string; country?: string } | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (!/(^|\.)apple\.com$/.test(u.hostname)) return null;
  const id = u.pathname.match(/\/id(\d{5,12})(?:\/|$)/)?.[1] ?? u.searchParams.get("id")?.match(/^\d{5,12}$/)?.[0];
  if (!id) return null;
  const cc = u.pathname.match(/^\/([a-z]{2})(?:\/|$)/i)?.[1]?.toLowerCase();
  return { id, country: cc };
}

export function itunesLookupUrl(id: string, country = "us"): string {
  return `https://itunes.apple.com/lookup?id=${encodeURIComponent(id)}&country=${encodeURIComponent(country)}&entity=software`;
}

/** Fields of an iTunes Lookup `results[]` entry we use (documented public shape). */
export interface ItunesResult {
  kind?: string;
  trackId?: number;
  trackName?: string;
  sellerName?: string;
  artistName?: string;
  description?: string;
  primaryGenreName?: string;
  formattedPrice?: string;
  price?: number;
  currency?: string;
  screenshotUrls?: string[];
  ipadScreenshotUrls?: string[];
  artworkUrl512?: string;
  artworkUrl100?: string;
  averageUserRating?: number;
  userRatingCount?: number;
  releaseNotes?: string;
  currentVersionReleaseDate?: string;
  trackViewUrl?: string;
  supportedDevices?: string[];
}

export function listingFromItunes(r: ItunesResult, requestedUrl: string, fetchedAt: string): StoreListing {
  const shots = (r.screenshotUrls?.length ? r.screenshotUrls : (r.ipadScreenshotUrls ?? [])).filter(isHttpUrl).slice(0, 10);
  const icon = [r.artworkUrl512, r.artworkUrl100].find(isHttpUrl);
  const price = r.formattedPrice ?? (r.price === 0 ? "Free" : r.price !== undefined ? `${r.price} ${r.currency ?? ""}`.trim() : undefined);
  const url = isHttpUrl(r.trackViewUrl) ? r.trackViewUrl : requestedUrl;
  const listing: StoreListing = {
    source: "app_store",
    url,
    fetchedAt,
    name: r.trackName ? clip(r.trackName, 200) : undefined,
    developer: (r.sellerName ?? r.artistName) ? clip(r.sellerName ?? r.artistName, 200) : undefined,
    description: r.description ? clip(r.description, 20_000) : undefined,
    category: r.primaryGenreName ? clip(r.primaryGenreName, 120) : undefined,
    price: price ? clip(price, 60) : undefined,
    // The Lookup API does not expose in-app purchases: left unknown rather than guessed.
    hasInAppPurchases: undefined,
    iconUrl: icon,
    screenshotUrls: shots,
    ratingObserved: typeof r.averageUserRating === "number" && r.userRatingCount ? Math.round(r.averageUserRating * 100) / 100 : undefined,
    ratingCountObserved: typeof r.userRatingCount === "number" && r.userRatingCount > 0 ? r.userRatingCount : undefined,
    releaseNotes: r.releaseNotes ? clip(r.releaseNotes, 5000) : undefined,
    lastUpdated: r.currentVersionReleaseDate ? clip(r.currentVersionReleaseDate, 60) : undefined,
  };
  listing.contentHash = sha256(JSON.stringify({ ...listing, fetchedAt: undefined }));
  return listing;
}

// ---------------------------------------------------------------------------
// Google Play (public listing page)
// ---------------------------------------------------------------------------

export function parsePlayUrl(raw: string): { packageId: string; hl?: string; gl?: string } | null {
  try {
    const u = new URL(raw);
    if (u.hostname !== "play.google.com") return null;
    const id = u.searchParams.get("id");
    if (!id || !/^[A-Za-z0-9_.]{3,200}$/.test(id)) return null;
    return { packageId: id, hl: u.searchParams.get("hl") ?? undefined, gl: u.searchParams.get("gl") ?? undefined };
  } catch {
    return null;
  }
}

export function playListingUrl(packageId: string, hl = "en", gl = "US"): string {
  return `https://play.google.com/store/apps/details?id=${encodeURIComponent(packageId)}&hl=${encodeURIComponent(hl)}&gl=${encodeURIComponent(gl)}`;
}

/** googleusercontent image URLs carry a size suffix (`=w526-h296-rw`); ask for a larger rendition. */
export function upscalePlayImage(url: string, kind: "icon" | "screenshot"): string {
  if (!/googleusercontent\.com\//.test(url)) return url;
  const base = url.replace(/=[^/=]*$/, "");
  return `${base}=${kind === "icon" ? "s512" : "h1600"}`;
}

interface JsonLdApp {
  "@type"?: string | string[];
  name?: string;
  description?: string;
  image?: string;
  applicationCategory?: string;
  author?: { name?: string } | { name?: string }[];
  aggregateRating?: { ratingValue?: string | number; ratingCount?: string | number };
  offers?: { price?: string | number; priceCurrency?: string } | { price?: string | number; priceCurrency?: string }[];
}

function jsonLdApps($: CheerioAPI): JsonLdApp[] {
  const out: JsonLdApp[] = [];
  $('script[type="application/ld+json"]').each((_i, el) => {
    try {
      const data = JSON.parse($(el).text()) as unknown;
      const items = Array.isArray(data) ? data : [data];
      for (const it of items) {
        const t = (it as JsonLdApp)["@type"];
        const types = Array.isArray(t) ? t : [t];
        if (types.some((x) => x === "SoftwareApplication" || x === "MobileApplication")) out.push(it as JsonLdApp);
      }
    } catch {
      /* ignore malformed blocks */
    }
  });
  return out;
}

function absUrl(src: string | undefined, base: string): string | undefined {
  if (!src) return undefined;
  try {
    const u = new URL(src.trim().split(/\s+/)[0]!, base).toString();
    return isHttpUrl(u) ? u : undefined;
  } catch {
    return undefined;
  }
}

export function listingFromPlayHtml(html: string, url: string, fetchedAt: string): StoreListing {
  const $ = load(html);
  const ld = jsonLdApps($)[0];
  const meta = (sel: string) => $(sel).attr("content")?.trim() || undefined;
  const name = ld?.name ?? ($("h1").first().text().trim() || meta('meta[property="og:title"]')?.replace(/ - Apps on Google Play$/i, ""));
  const author = Array.isArray(ld?.author) ? ld?.author[0] : ld?.author;
  const developer = author?.name ?? ($('a[href*="/store/apps/dev"]').first().text().trim() || undefined);
  const domDescription = $('[data-g-id="description"]').first().text().trim();
  const description = domDescription || ld?.description || meta('meta[itemprop="description"]') || meta('meta[name="description"]') || meta('meta[property="og:description"]');
  const category = ld?.applicationCategory?.replace(/_/g, " ").toLowerCase().replace(/(^|\s)\S/g, (m) => m.toUpperCase()) ?? ($('a[itemprop="genre"]').first().text().trim() || $('a[href*="/store/apps/category/"]').first().text().trim() || undefined);
  const offer = Array.isArray(ld?.offers) ? ld?.offers[0] : ld?.offers;
  const priceNum = offer?.price !== undefined ? Number(offer.price) : undefined;
  const price = priceNum === 0 ? "Free" : priceNum && Number.isFinite(priceNum) ? `${priceNum} ${offer?.priceCurrency ?? ""}`.trim() : undefined;
  const pageText = $("body").text();
  const hasIap = /in-app purchases/i.test(pageText) ? true : undefined;
  const iconRaw = absUrl(ld?.image, url) ?? absUrl($('img[itemprop="image"]').attr("src"), url) ?? absUrl($('img[alt="Icon image"]').attr("src"), url) ?? absUrl(meta('meta[property="og:image"]'), url);
  const shots: string[] = [];
  $('img[data-screenshot-index], img[alt*="creenshot"]').each((_i, el) => {
    const src = absUrl($(el).attr("src") ?? $(el).attr("data-src"), url) ?? absUrl($(el).attr("srcset"), url);
    if (src) shots.push(upscalePlayImage(src, "screenshot"));
  });
  const ratingValue = ld?.aggregateRating?.ratingValue !== undefined ? Number(ld.aggregateRating.ratingValue) : undefined;
  const ratingCount = ld?.aggregateRating?.ratingCount !== undefined ? Number(String(ld.aggregateRating.ratingCount).replace(/[^\d]/g, "")) : undefined;
  const listing: StoreListing = {
    source: "google_play",
    url,
    fetchedAt,
    name: name ? clip(name, 200) : undefined,
    developer: developer ? clip(developer, 200) : undefined,
    description: description ? clip(description, 20_000) : undefined,
    category: category ? clip(category, 120) : undefined,
    price,
    hasInAppPurchases: hasIap,
    iconUrl: iconRaw ? upscalePlayImage(iconRaw, "icon") : undefined,
    screenshotUrls: uniq(shots).slice(0, 10),
    ratingObserved: ratingValue !== undefined && Number.isFinite(ratingValue) && ratingValue >= 0 && ratingValue <= 5 ? Math.round(ratingValue * 100) / 100 : undefined,
    ratingCountObserved: ratingCount && Number.isFinite(ratingCount) ? ratingCount : undefined,
  };
  listing.contentHash = sha256(JSON.stringify({ ...listing, fetchedAt: undefined }));
  return listing;
}

// ---------------------------------------------------------------------------
// Website
// ---------------------------------------------------------------------------

export interface WebsiteExtract {
  listing: StoreListing;
  /** Short visible-text lines (list items / headings) usable as feature evidence. */
  bullets: string[];
  iconUrl?: string;
  appStoreUrl?: string;
  playStoreUrl?: string;
  text: string;
}

export function extractPageText($: CheerioAPI, maxChars: number): string {
  $("script, style, noscript, svg, template, iframe").remove();
  const text = $("body").text().replace(/\s+/g, " ").trim();
  return clip(text, maxChars);
}

export function extractWebsite(html: string, url: string, fetchedAt: string): WebsiteExtract {
  const $ = load(html);
  const meta = (sel: string) => $(sel).attr("content")?.trim() || undefined;
  const title = meta('meta[property="og:title"]') ?? ($("title").first().text().trim() || undefined);
  const description = meta('meta[name="description"]') ?? meta('meta[property="og:description"]');
  const iconUrl =
    absUrl($('link[rel~="apple-touch-icon"]').attr("href"), url) ??
    absUrl($('link[rel~="icon"][sizes]').last().attr("href"), url) ??
    absUrl($('link[rel~="icon"]').attr("href"), url);
  let appStoreUrl: string | undefined;
  let playStoreUrl: string | undefined;
  $("a[href]").each((_i, el) => {
    const href = absUrl($(el).attr("href"), url);
    if (!href) return;
    if (!appStoreUrl && /apps\.apple\.com\/.*\/id\d+/.test(href)) appStoreUrl = href;
    if (!playStoreUrl && /play\.google\.com\/store\/apps\/details\?id=/.test(href)) playStoreUrl = href;
  });
  const bullets: string[] = [];
  $("li, h2, h3").each((_i, el) => {
    const t = $(el).text().replace(/\s+/g, " ").trim();
    if (t.length >= 12 && t.length <= 240 && !bullets.includes(t)) bullets.push(t);
  });
  const text = extractPageText($, 12_000);
  const listing: StoreListing = {
    source: "website",
    url,
    fetchedAt,
    name: title ? clip(title, 200) : undefined,
    description: clip([description, text].filter(Boolean).join("\n\n"), 20_000) || undefined,
    screenshotUrls: [],
    iconUrl,
  };
  listing.contentHash = sha256(JSON.stringify({ ...listing, fetchedAt: undefined }));
  return { listing, bullets: bullets.slice(0, 15), iconUrl, appStoreUrl, playStoreUrl, text };
}

/** Split a listing description into short feature-like lines (bullets / short sentences). */
export function descriptionBullets(description: string, max = 15): string[] {
  const lines = description
    .split(/\r?\n/)
    .map((l) => l.replace(/^[\s•●▪◦·*\-–—✓✔︎✅►▶︎➤→]+/u, "").trim())
    .filter((l) => l.length >= 12 && l.length <= 300);
  const bulletish = description.split(/\r?\n/).filter((l) => /^[\s]*[•●▪◦·*\-–—✓✔✅►▶➤→]/u.test(l)).length >= 2;
  const chosen = bulletish
    ? description
        .split(/\r?\n/)
        .filter((l) => /^[\s]*[•●▪◦·*\-–—✓✔✅►▶➤→]/u.test(l))
        .map((l) => l.replace(/^[\s•●▪◦·*\-–—✓✔︎✅►▶︎➤→]+/u, "").trim())
        .filter((l) => l.length >= 8 && l.length <= 300)
    : lines.slice(1);
  return uniq(chosen).slice(0, max);
}

export function firstParagraph(description: string): string {
  const p = description.split(/\r?\n\s*\r?\n/).map((x) => x.trim()).find((x) => x.length > 20) ?? description.trim();
  return clip(p.replace(/\s+/g, " "), 1000);
}

const PRICING_WORDS = /\b(subscriptions?|subscribe|premium|pro version|\bpro\b|in-app purchases?|free trial|per month|per year|monthly|yearly|annual|lifetime|one-time purchase|unlock)/i;

/** Description sentences that talk about pricing/plans (verbatim), for monetization evidence. */
export function pricingSentences(description: string, max = 4): string[] {
  const sentences = description
    .split(/\r?\n|(?<=[.!?])\s+/)
    .map((x) => x.replace(/^[\s•●▪◦·*\-–—✓✔︎✅►▶︎➤→]+/u, "").trim())
    .filter((x) => x.length >= 12 && x.length <= 400 && PRICING_WORDS.test(x));
  return uniq(sentences).slice(0, max);
}
