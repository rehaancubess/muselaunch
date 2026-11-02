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

/**
 * The Lookup API's screenshot URLs are small renditions (`.../392x696bb.png`, 160 px wide once the phone
 * screen is cut out of a store image). mzstatic serves any size from the name, so ask for one whose long
 * edge is 2400 px (same aspect ratio); the original is the upper bound.
 */
export function upscaleAppStoreImage(url: string, longEdge = 2400): string {
  const m = url.match(/\/(\d+)x(\d+)([a-z]{0,3})\.(png|jpe?g|webp)$/i);
  if (!m || !/mzstatic\.com\//.test(url)) return url;
  const [w, h] = [Number(m[1]), Number(m[2])];
  const scale = longEdge / Math.max(w, h);
  if (!(scale > 1)) return url;
  return url.replace(m[0], `/${Math.round(w * scale)}x${Math.round(h * scale)}${m[3] || "bb"}.${m[4]}`);
}

export function listingFromItunes(r: ItunesResult, requestedUrl: string, fetchedAt: string): StoreListing {
  const shots = (r.screenshotUrls?.length ? r.screenshotUrls : (r.ipadScreenshotUrls ?? [])).filter(isHttpUrl).slice(0, 10).map((u) => upscaleAppStoreImage(u));
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
  /**
   * What the page groups under its headings, literally: a heading and the names listed below it
   * (sub-headings, card titles, bold labels), e.g. "Racing" → ["Pocket GP", "Mud Slingers"].
   */
  sections: WebsiteSection[];
  /** Named cards with their one-line description, e.g. "Pin Party" → "Ten-pin bowling for up to six players". */
  cards: { name: string; description: string }[];
  /** Sentences that name where the app runs or count what it has ("Join once and hop between all 15 games"). */
  statements: { kind: "platform" | "count"; text: string }[];
  /** Sentences about plans and prices, read block by block (verbatim). */
  pricing: string[];
  iconUrl?: string;
  appStoreUrl?: string;
  playStoreUrl?: string;
  text: string;
}

export interface WebsiteSection {
  heading: string;
  items: string[];
}

export function extractPageText($: CheerioAPI, maxChars: number): string {
  $("script, style, noscript, svg, template, iframe").remove();
  const text = $("body").text().replace(/\s+/g, " ").trim();
  return clip(text, maxChars);
}

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

/** Keep words apart when markup has none between blocks (`<span>01</span><h3>Open</h3>`, `<br>`). */
function spaceOut($: CheerioAPI): void {
  $("br").replaceWith(" ");
  $("p, li, h1, h2, h3, h4, h5, h6, div, span, strong, b, em, a, dt, dd, td, th, figcaption, section, article, header, label, button").append(" ");
}

/**
 * Text that tries to instruct a model ("ignore previous instructions…") is never kept as a fact,
 * even when it sits on the app's own page.
 */
export const INSTRUCTION_LIKE = /\b(?:ignore|disregard|forget|override)\b[^.!?\n]{0,60}\b(?:instructions?|prompts?|rules|system)\b|\b(?:you are|act as)\s+(?:an?\s+)?(?:ai|assistant|model|chatgpt|llm)\b/i;

/** Where an app can run, as listings and sites name it (used to keep sentences that state platforms). */
export const PLATFORM_WORDS =
  /\b(?:fire\s?tv(?:\s+stick)?|apple\s+tv|android\s+tv|google\s+tv|smart\s+tvs?|roku|chromecast|tvos|iphone|ipad|ios|android|macos|mac\s+app\s+store|windows\s+(?:pc|10|11)|linux|chromebook|apple\s+watch|wear\s?os|web\s+browser|in\s+your\s+browser|steam\s+deck|xbox|playstation|nintendo\s+switch|meta\s+quest|vision\s+pro)\b/i;

/** "15 games", "6 players", "3 modes": a small number counting things the product has. */
const COUNT_PHRASE = /\b(?:all\s+)?\d{1,4}\+?\s+(?:[a-z][\w-]*\s+){0,2}?(?:games?|players?|levels?|modes?|worlds?|tracks?|courses?|maps?|characters?|songs?|lessons?|recipes?|workouts?|templates?|themes?|languages?|stickers?|filters?|puzzles?|quizzes|decks?|voices?|widgets?|integrations?|devices?|screens?|controllers?|categories|groups?|apps?)\b/i;

/** A label-ish element: card titles, product names, bold names in a grid. */
const NAME_TAGS = new Set(["strong", "b", "dt", "figcaption", "h4", "h5", "h6"]);
const NAME_CLASS = /(?:^|[\s_-])(?:title|name|heading)(?:$|[\s_-])/i;
const INLINE_PARENTS = new Set(["p", "li", "a", "span", "em", "i", "label", "small", "td"]);

/**
 * The page's own structure, read literally: headings with the names grouped under them, named
 * cards with their one-line description, and sentences that state platforms or counts. Navigation,
 * footers, forms and anything instruction-like are left out. Nothing is paraphrased.
 */
export function websiteStructure(html: string): Pick<WebsiteExtract, "sections" | "cards" | "statements" | "pricing"> {
  const $ = load(html);
  $("script, style, noscript, svg, template, iframe, nav, footer, form, [hidden], [aria-hidden='true']").remove();
  spaceOut($);
  $("[id*='cookie' i], [class*='cookie' i], [id*='consent' i], [class*='consent' i]").remove();

  type Section = { level: number; heading: string; items: string[] };
  const done: Section[] = [];
  const stack: Section[] = [];
  const cards: { name: string; description: string }[] = [];
  const add = (s: Section, item: string) => {
    if (item.length < 2 || item.length > 80 || INSTRUCTION_LIKE.test(item)) return;
    if (item.toLowerCase() === s.heading.toLowerCase() || s.items.some((x) => x.toLowerCase() === item.toLowerCase())) return;
    if (s.items.length < 24) s.items.push(item);
  };
  /** The first short paragraph next to a name inside its card (up to three levels up). */
  const descriptionOf = (el: Parameters<typeof $>[0], name: string): string | undefined => {
    let box = $(el).parent();
    for (let depth = 0; depth < 3 && box.length; depth++) {
      if (squash(box.text()).length > 600) return undefined;
      const p = box
        .find("p")
        .toArray()
        .map((x) => squash($(x).text()))
        .find((t) => t.length >= 12 && t.length <= 220 && t !== name && !t.startsWith(name));
      if (p) return p;
      box = box.parent();
    }
    return undefined;
  };
  const isName = (el: { tagName?: string; attribs?: Record<string, string> }, text: string): boolean => {
    const tag = (el.tagName ?? "").toLowerCase();
    if (!NAME_TAGS.has(tag) && !NAME_CLASS.test(el.attribs?.class ?? "")) return false;
    // Names are short labels, not questions or sentences.
    if (text.length < 2 || text.length > 80 || text.endsWith("?") || (/[.!]$/.test(text) && text.split(" ").length > 6)) return false;
    const node = $(el as Parameters<typeof $>[0]);
    if (node.closest("h1, h2, h3, h4, h5, h6").length && !/^h[4-6]$/.test(tag)) return false;
    if (node.find("h1, h2, h3, h4, h5, h6, p, li, strong, b, [class*='title' i], [class*='name' i]").length) return false;
    // Bold words inside a sentence are emphasis, not a name.
    const parent = node.parent();
    const parentTag = ((parent.get(0) as { tagName?: string } | undefined)?.tagName ?? "").toLowerCase();
    if (INLINE_PARENTS.has(parentTag) && squash(parent.text()) !== text) return false;
    return true;
  };

  const seenNames = new Set<string>();
  $("body *").each((_i, el) => {
    const tag = ((el as { tagName?: string }).tagName ?? "").toLowerCase();
    const text = squash($(el).text());
    if (!text) return;
    const level = /^h([1-6])$/.exec(tag)?.[1];
    if (level && Number(level) <= 3) {
      const lv = Number(level);
      while (stack.length && stack[stack.length - 1]!.level >= lv) done.push(stack.pop()!);
      if (text.length > 120 || INSTRUCTION_LIKE.test(text)) return;
      const parent = stack[stack.length - 1];
      if (parent) add(parent, text);
      stack.push({ level: lv, heading: text, items: [] });
      return;
    }
    if (!isName(el as { tagName?: string; attribs?: Record<string, string> }, text)) return;
    const section = stack[stack.length - 1];
    if (section) add(section, text);
    const key = text.toLowerCase();
    if (seenNames.has(key) || cards.length >= 24) return;
    const description = descriptionOf(el as Parameters<typeof $>[0], text);
    if (description && !INSTRUCTION_LIKE.test(description)) {
      seenNames.add(key);
      cards.push({ name: text, description });
    }
  });
  done.push(...stack.splice(0));
  // The page title's "section" is just the page's table of contents: left out.
  const sections = done
    .filter((s) => s.level >= 2 && s.items.length >= 2)
    .map((s) => ({ heading: s.heading, items: s.items }))
    .slice(0, 12);

  // Sentences that state platforms or counts, from visible text blocks (headings, paragraphs, lists).
  const statements: { kind: "platform" | "count"; text: string }[] = [];
  const pricing: string[] = [];
  const seen = new Set<string>();
  $("h1, h2, h3, h4, p, li, dd, td, figcaption, blockquote").each((_i, el) => {
    if ($(el).find("p, li").length) return; // the innermost block only
    for (const raw of squash($(el).text()).split(/(?<=[.!?])\s+/)) {
      const s = raw.trim();
      if (s.length < 8 || s.length > 280 || INSTRUCTION_LIKE.test(s) || seen.has(s.toLowerCase())) continue;
      seen.add(s.toLowerCase());
      if (s.length >= 12 && PRICING_WORDS.test(s)) pricing.push(s);
      const kind = PLATFORM_WORDS.test(s) ? "platform" : COUNT_PHRASE.test(s) ? "count" : null;
      if (kind) statements.push({ kind, text: s });
    }
  });
  return {
    sections,
    cards,
    statements: [...statements.filter((s) => s.kind === "platform").slice(0, 6), ...statements.filter((s) => s.kind === "count").slice(0, 8)],
    pricing: pricing.slice(0, 6),
  };
}

/** A website section as one literal fact: "Racing: Pocket GP, Mud Slingers, Garden Grand Prix". */
export function sectionFact(s: WebsiteSection): string {
  return `${s.heading.replace(/[\s.:;,–—-]+$/, "")}: ${s.items.join(", ")}`;
}

export function extractWebsite(html: string, url: string, fetchedAt: string): WebsiteExtract {
  const $ = load(html);
  spaceOut($);
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
    if (t.length >= 12 && t.length <= 240 && !bullets.includes(t) && !INSTRUCTION_LIKE.test(t)) bullets.push(t);
  });
  const structure = websiteStructure(html);
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
  return { listing, bullets: bullets.slice(0, 15), ...structure, iconUrl, appStoreUrl, playStoreUrl, text };
}

/** Split a listing description into short feature-like lines (bullets / short sentences). */
export function descriptionBullets(description: string, max = 20): string[] {
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
  return uniq(chosen.filter((l) => !INSTRUCTION_LIKE.test(l))).slice(0, max);
}

/** Sentences of a store description that state platforms or counts (verbatim), like the website's statements. */
export function descriptionStatements(description: string, max = 8): { kind: "platform" | "count"; text: string }[] {
  const out: { kind: "platform" | "count"; text: string }[] = [];
  const seen = new Set<string>();
  for (const raw of description.split(/\r?\n|(?<=[.!?])\s+/)) {
    const s = raw.replace(/^[\s•●▪◦·*\-–—✓✔︎✅►▶︎➤→]+/u, "").trim();
    if (s.length < 8 || s.length > 280 || INSTRUCTION_LIKE.test(s) || seen.has(s.toLowerCase())) continue;
    const kind = PLATFORM_WORDS.test(s) ? "platform" : COUNT_PHRASE.test(s) ? "count" : null;
    if (!kind) continue;
    seen.add(s.toLowerCase());
    out.push({ kind, text: s });
  }
  return out.slice(0, max);
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
    .filter((x) => x.length >= 12 && x.length <= 400 && PRICING_WORDS.test(x) && !INSTRUCTION_LIKE.test(x));
  return uniq(sentences).slice(0, max);
}
