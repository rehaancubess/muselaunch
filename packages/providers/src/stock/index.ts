import { StockItem, type StockProviderId, type StockSearchQuery } from "@muselaunch/contracts";
import { AppError, type Platform } from "@muselaunch/platform";
import type { CallContext } from "../meta/client";
import { httpError, meterExternal } from "../images/meter";

/**
 * Stock media adapters. Openverse (CC images, no key) is always available; Pexels and Pixabay are
 * used when their API keys exist. Every item carries licence + ready-to-show attribution. Imports
 * re-fetch item details server-side (never trusting client-sent licence data) and download via
 * `safeFetch` into workspace storage (Pixabay forbids permanent hotlinking). Uploads stay the
 * primary fallback when no stock provider fits.
 */

export interface StockDeps {
  /** Injected in tests; defaults to global fetch (fixed provider API hosts only). */
  fetch?: typeof fetch;
}

export interface StockDetail {
  item: StockItem;
  /** Direct file URL to download (validated again by safeFetch). */
  downloadUrl: string;
  mimeType: string;
}

export interface StockAdapter {
  readonly id: StockProviderId;
  readonly label: string;
  configured(p: Platform): boolean;
  supports(kind: "image" | "video"): boolean;
  search(p: Platform, q: StockSearchQuery, deps: StockDeps): Promise<{ items: StockItem[]; hasMore: boolean }>;
  get(p: Platform, id: string, kind: "image" | "video", deps: StockDeps): Promise<StockDetail>;
}

async function getJson<T>(deps: StockDeps, url: string, provider: string, headers: Record<string, string> = {}): Promise<T> {
  const res = await (deps.fetch ?? fetch)(url, { headers: { accept: "application/json", "user-agent": "MuseLaunch/0.1 (+https://muselaunch.app)", ...headers }, signal: AbortSignal.timeout(15_000) });
  if (res.status === 404) throw new AppError("NOT_FOUND", `${provider} item not found`);
  if (!res.ok) throw await httpError(res, provider);
  return (await res.json()) as T;
}

const valid = (raw: unknown): StockItem | null => {
  const r = StockItem.safeParse(raw);
  return r.success ? r.data : null;
};

// ---------------------------------------------------------------------------
// Openverse (https://api.openverse.org): openly licensed images, anonymous access (page_size ≤ 20)
// ---------------------------------------------------------------------------

interface OpenverseImage {
  id: string;
  title?: string | null;
  foreign_landing_url?: string | null;
  url?: string | null;
  thumbnail?: string | null;
  creator?: string | null;
  creator_url?: string | null;
  license: string;
  license_version?: string | null;
  license_url?: string | null;
  attribution?: string | null;
  width?: number | null;
  height?: number | null;
  filetype?: string | null;
  mature?: boolean;
}

/** Only licences that allow commercial use AND modification without share-alike obligations. */
export const OPENVERSE_LICENSES = ["cc0", "pdm", "by"] as const;

function openverseLicenseName(l: string, v?: string | null): string {
  if (l === "cc0") return "CC0 1.0";
  if (l === "pdm") return "Public Domain Mark 1.0";
  return `CC ${l.toUpperCase()}${v ? ` ${v}` : ""}`;
}

function openverseItem(r: OpenverseImage): StockItem | null {
  if (!(OPENVERSE_LICENSES as readonly string[]).includes(r.license) || r.mature) return null;
  const name = openverseLicenseName(r.license, r.license_version);
  const title = r.title ?? "Untitled";
  const attribution = r.attribution ?? `"${title}"${r.creator ? ` by ${r.creator}` : ""} is licensed under ${name}${r.license_url ? `. ${r.license_url}` : ""}`;
  return valid({
    provider: "openverse",
    id: r.id,
    kind: "image",
    title: title.slice(0, 300),
    previewUrl: r.thumbnail ?? r.url,
    pageUrl: r.foreign_landing_url ?? r.url,
    width: r.width ?? undefined,
    height: r.height ?? undefined,
    creator: r.creator ?? undefined,
    creatorUrl: r.creator_url ?? undefined,
    license: { type: "creative_commons", name, url: r.license_url ?? undefined, attribution: attribution.slice(0, 500), attributionRequired: r.license === "by" },
  });
}

export const openverse: StockAdapter = {
  id: "openverse",
  label: "Openverse (Creative Commons)",
  configured: () => true,
  supports: (kind) => kind === "image",
  async search(_p, q, deps) {
    const params = new URLSearchParams({ q: q.q, page: String(q.page), page_size: String(Math.min(20, q.perPage)), license: OPENVERSE_LICENSES.join(","), mature: "false" });
    if (q.orientation) params.set("aspect_ratio", q.orientation === "portrait" ? "tall" : q.orientation === "landscape" ? "wide" : "square");
    const data = await getJson<{ results?: OpenverseImage[]; page_count?: number; page?: number }>(deps, `https://api.openverse.org/v1/images/?${params}`, "Openverse");
    const items = (data.results ?? []).map(openverseItem).filter((x): x is StockItem => Boolean(x));
    return { items, hasMore: (data.page_count ?? 0) > q.page };
  },
  async get(_p, id, kind, deps) {
    if (kind !== "image") throw new AppError("BAD_REQUEST", "Openverse provides images only");
    if (!/^[0-9a-fA-F-]{8,64}$/.test(id)) throw new AppError("BAD_REQUEST", "Invalid Openverse id");
    const r = await getJson<OpenverseImage>(deps, `https://api.openverse.org/v1/images/${id}/`, "Openverse");
    const item = openverseItem(r);
    if (!item || !r.url) throw new AppError("BAD_REQUEST", "This Openverse image's licence doesn't allow commercial use with modification", { userMessage: "That image's licence doesn't allow use in ads. Pick another one." });
    const ext = (r.filetype ?? r.url.split(".").pop() ?? "jpg").toLowerCase();
    return { item, downloadUrl: r.url, mimeType: ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : ext === "gif" ? "image/gif" : "image/jpeg" };
  },
};

// ---------------------------------------------------------------------------
// Pexels (https://www.pexels.com/api/documentation/): photos + videos, key in Authorization header
// ---------------------------------------------------------------------------

interface PexelsPhoto {
  id: number;
  width: number;
  height: number;
  url: string;
  photographer: string;
  photographer_url: string;
  alt?: string;
  src: { original: string; large2x: string; large: string; medium: string; small: string; portrait?: string; tiny?: string };
}
interface PexelsVideo {
  id: number;
  width: number;
  height: number;
  url: string;
  image: string;
  duration: number;
  user: { name: string; url: string };
  video_files: { id: number; quality: string | null; file_type: string; width: number | null; height: number | null; link: string }[];
}

const PEXELS_LICENSE = { type: "stock_license" as const, name: "Pexels License", url: "https://www.pexels.com/license/", attributionRequired: false };

function pexelsPhotoItem(ph: PexelsPhoto): StockItem | null {
  return valid({
    provider: "pexels",
    id: String(ph.id),
    kind: "image",
    title: ph.alt || undefined,
    previewUrl: ph.src.medium,
    pageUrl: ph.url,
    width: ph.width,
    height: ph.height,
    creator: ph.photographer,
    creatorUrl: ph.photographer_url,
    license: { ...PEXELS_LICENSE, attribution: `Photo by ${ph.photographer} on Pexels` },
  });
}
/** Pexels videos have no title field; the page slug describes them ("/video/woman-typing-on-a-laptop-3195394/"). */
export function pexelsSlugTitle(pageUrl: string): string | undefined {
  try {
    const slug = new URL(pageUrl).pathname.split("/").filter(Boolean).pop() ?? "";
    const words = slug.replace(/-?\d+$/, "").replace(/-/g, " ").trim();
    return words ? words.charAt(0).toUpperCase() + words.slice(1) : undefined;
  } catch {
    return undefined;
  }
}

function pexelsVideoItem(v: PexelsVideo): StockItem | null {
  return valid({
    provider: "pexels",
    id: String(v.id),
    kind: "video",
    title: pexelsSlugTitle(v.url)?.slice(0, 300),
    previewUrl: v.image,
    pageUrl: v.url,
    width: v.width,
    height: v.height,
    durationSec: v.duration,
    creator: v.user?.name,
    creatorUrl: v.user?.url,
    license: { ...PEXELS_LICENSE, attribution: `Video by ${v.user?.name ?? "unknown"} on Pexels` },
  });
}
/** Best MP4 rendition for a 1080p composition (≤1920 on the long edge, largest available). */
function pickVideoFile<T extends { width: number | null; height: number | null }>(files: T[], mp4: (f: T) => boolean): T | undefined {
  const ok = files.filter((f) => mp4(f) && f.width && f.height);
  const within = ok.filter((f) => Math.max(f.width!, f.height!) <= 1920).sort((a, b) => b.width! * b.height! - a.width! * a.height!);
  return within[0] ?? ok.sort((a, b) => a.width! * a.height! - b.width! * b.height!)[0];
}

export const pexels: StockAdapter = {
  id: "pexels",
  label: "Pexels",
  configured: (p) => Boolean(p.cfg.PEXELS_API_KEY),
  supports: () => true,
  async search(p, q, deps) {
    const key = p.cfg.PEXELS_API_KEY!;
    const params = new URLSearchParams({ query: q.q, page: String(q.page), per_page: String(q.perPage) });
    if (q.orientation) params.set("orientation", q.orientation);
    if (q.kind === "video") {
      const data = await getJson<{ videos?: PexelsVideo[]; next_page?: string }>(deps, `https://api.pexels.com/videos/search?${params}`, "Pexels", { authorization: key });
      return { items: (data.videos ?? []).map(pexelsVideoItem).filter((x): x is StockItem => Boolean(x)), hasMore: Boolean(data.next_page) };
    }
    const data = await getJson<{ photos?: PexelsPhoto[]; next_page?: string }>(deps, `https://api.pexels.com/v1/search?${params}`, "Pexels", { authorization: key });
    return { items: (data.photos ?? []).map(pexelsPhotoItem).filter((x): x is StockItem => Boolean(x)), hasMore: Boolean(data.next_page) };
  },
  async get(p, id, kind, deps) {
    if (!/^\d{1,20}$/.test(id)) throw new AppError("BAD_REQUEST", "Invalid Pexels id");
    const key = p.cfg.PEXELS_API_KEY!;
    if (kind === "video") {
      const v = await getJson<PexelsVideo>(deps, `https://api.pexels.com/videos/videos/${id}`, "Pexels", { authorization: key });
      const item = pexelsVideoItem(v);
      const file = pickVideoFile(v.video_files ?? [], (f) => f.file_type === "video/mp4");
      if (!item || !file) throw new AppError("PROVIDER_ERROR", "Pexels video has no usable MP4 rendition");
      return { item, downloadUrl: file.link, mimeType: "video/mp4" };
    }
    const ph = await getJson<PexelsPhoto>(deps, `https://api.pexels.com/v1/photos/${id}`, "Pexels", { authorization: key });
    const item = pexelsPhotoItem(ph);
    if (!item) throw new AppError("PROVIDER_ERROR", "Pexels photo response was incomplete");
    return { item, downloadUrl: ph.src.large2x || ph.src.original, mimeType: "image/jpeg" };
  },
};

// ---------------------------------------------------------------------------
// Pixabay (https://pixabay.com/api/docs/): images + videos, key as query param; no hotlinking
// ---------------------------------------------------------------------------

interface PixabayImage {
  id: number;
  pageURL: string;
  tags?: string;
  previewURL: string;
  webformatURL: string;
  largeImageURL: string;
  imageWidth: number;
  imageHeight: number;
  user: string;
  user_id: number;
}
interface PixabayVideo {
  id: number;
  pageURL: string;
  tags?: string;
  duration: number;
  videos: Record<"large" | "medium" | "small" | "tiny", { url: string; width: number; height: number; size?: number; thumbnail?: string } | undefined>;
  user: string;
  user_id: number;
}

const PIXABAY_LICENSE = { type: "stock_license" as const, name: "Pixabay Content License", url: "https://pixabay.com/service/license-summary/", attributionRequired: false };
const pixabayUser = (user: string, id: number) => `https://pixabay.com/users/${encodeURIComponent(user)}-${id}/`;

function pixabayImageItem(h: PixabayImage): StockItem | null {
  return valid({
    provider: "pixabay",
    id: String(h.id),
    kind: "image",
    title: h.tags || undefined,
    previewUrl: h.webformatURL || h.previewURL,
    pageUrl: h.pageURL,
    width: h.imageWidth,
    height: h.imageHeight,
    creator: h.user,
    creatorUrl: pixabayUser(h.user, h.user_id),
    license: { ...PIXABAY_LICENSE, attribution: `Image by ${h.user} on Pixabay` },
  });
}
function pixabayVideoItem(h: PixabayVideo): StockItem | null {
  const any = h.videos.medium ?? h.videos.small ?? h.videos.large ?? h.videos.tiny;
  return valid({
    provider: "pixabay",
    id: String(h.id),
    kind: "video",
    title: h.tags || undefined,
    previewUrl: any?.thumbnail ?? any?.url,
    pageUrl: h.pageURL,
    width: any?.width,
    height: any?.height,
    durationSec: h.duration,
    creator: h.user,
    creatorUrl: pixabayUser(h.user, h.user_id),
    license: { ...PIXABAY_LICENSE, attribution: `Video by ${h.user} on Pixabay` },
  });
}

export const pixabay: StockAdapter = {
  id: "pixabay",
  label: "Pixabay",
  configured: (p) => Boolean(p.cfg.PIXABAY_API_KEY),
  supports: () => true,
  async search(p, q, deps) {
    const params = new URLSearchParams({ key: p.cfg.PIXABAY_API_KEY!, q: q.q.slice(0, 100), page: String(q.page), per_page: String(Math.max(3, q.perPage)), safesearch: "true" });
    if (q.orientation && q.orientation !== "square") params.set("orientation", q.orientation === "portrait" ? "vertical" : "horizontal");
    if (q.kind === "video") {
      const data = await getJson<{ hits?: PixabayVideo[]; totalHits?: number }>(deps, `https://pixabay.com/api/videos/?${params}`, "Pixabay");
      return { items: (data.hits ?? []).map(pixabayVideoItem).filter((x): x is StockItem => Boolean(x)), hasMore: (data.totalHits ?? 0) > q.page * q.perPage };
    }
    params.set("image_type", "photo");
    const data = await getJson<{ hits?: PixabayImage[]; totalHits?: number }>(deps, `https://pixabay.com/api/?${params}`, "Pixabay");
    return { items: (data.hits ?? []).map(pixabayImageItem).filter((x): x is StockItem => Boolean(x)), hasMore: (data.totalHits ?? 0) > q.page * q.perPage };
  },
  async get(p, id, kind, deps) {
    if (!/^\d{1,20}$/.test(id)) throw new AppError("BAD_REQUEST", "Invalid Pixabay id");
    const params = new URLSearchParams({ key: p.cfg.PIXABAY_API_KEY!, id });
    if (kind === "video") {
      const data = await getJson<{ hits?: PixabayVideo[] }>(deps, `https://pixabay.com/api/videos/?${params}`, "Pixabay");
      const h = data.hits?.[0];
      const item = h ? pixabayVideoItem(h) : null;
      const files = h ? Object.values(h.videos).filter((v): v is NonNullable<typeof v> => Boolean(v?.url)) : [];
      const file = pickVideoFile(files, () => true);
      if (!item || !file) throw new AppError("NOT_FOUND", "Pixabay video not found");
      return { item, downloadUrl: file.url, mimeType: "video/mp4" };
    }
    const data = await getJson<{ hits?: PixabayImage[] }>(deps, `https://pixabay.com/api/?${params}`, "Pixabay");
    const h = data.hits?.[0];
    const item = h ? pixabayImageItem(h) : null;
    if (!item || !h) throw new AppError("NOT_FOUND", "Pixabay image not found");
    return { item, downloadUrl: h.largeImageURL, mimeType: "image/jpeg" };
  },
};

export const STOCK_ADAPTERS: Record<StockProviderId, StockAdapter> = { openverse, pexels, pixabay };

export function stockProviderStates(p: Platform): { id: StockProviderId; label: string; state: "live" | "not_configured"; kinds: ("image" | "video")[] }[] {
  return Object.values(STOCK_ADAPTERS).map((a) => ({
    id: a.id,
    label: a.label,
    state: a.configured(p) ? "live" : "not_configured",
    kinds: (["image", "video"] as const).filter((k) => a.supports(k)),
  }));
}

/**
 * Search one provider (or the best configured one for the kind: Pexels → Pixabay → Openverse).
 * Metered as a zero-cost `stock` usage event for the audit trail.
 */
export async function searchStock(p: Platform, ctx: CallContext, q: StockSearchQuery, deps: StockDeps = {}): Promise<{ provider: StockProviderId; items: StockItem[]; hasMore: boolean }> {
  const order: StockProviderId[] = q.provider ? [q.provider] : q.kind === "video" ? ["pexels", "pixabay"] : ["pexels", "pixabay", "openverse"];
  const adapter = order.map((id) => STOCK_ADAPTERS[id]).find((a) => a.configured(p) && a.supports(q.kind));
  if (!adapter) {
    throw new AppError("PROVIDER_NOT_CONFIGURED", `No stock provider configured for ${q.kind}${q.provider ? ` (${q.provider})` : ""}`, {
      userMessage: q.kind === "video" ? "Stock video needs a Pexels or Pixabay key on this deployment. Upload your own footage instead." : "That stock provider isn't connected. Try Openverse or upload your own images.",
    });
  }
  const { value } = await meterExternal(p, ctx, { provider: "stock", model: adapter.id, operation: "search", estimatedUsd: 0 }, async () => {
    const r = await adapter.search(p, q, deps);
    return { value: r, usage: { costUsdEstimate: 0 }, trace: { request: { provider: adapter.id, q: q.q, kind: q.kind, page: q.page }, response: { count: r.items.length } } };
  });
  return { provider: adapter.id, ...value };
}

export async function getStockDetail(p: Platform, provider: StockProviderId, id: string, kind: "image" | "video", deps: StockDeps = {}): Promise<StockDetail> {
  const adapter = STOCK_ADAPTERS[provider];
  if (!adapter.configured(p)) throw new AppError("PROVIDER_NOT_CONFIGURED", `${adapter.label} is not configured`);
  if (!adapter.supports(kind)) throw new AppError("BAD_REQUEST", `${adapter.label} does not provide ${kind}s`);
  return adapter.get(p, id, kind, deps);
}

// Ranking + multi-provider search for storyboard b-roll (storyboard.resolve_media).
export * from "./pick";
