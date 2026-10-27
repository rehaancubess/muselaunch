import type { AppEvidence, AppImport, MediaAsset, Platform as AppPlatform, StoreListing } from "@muselaunch/contracts";
import { AppError, toAppError, type JobContext, type JobResult } from "@muselaunch/platform";
import { fetcherFor } from "../fetcher";
import { clip, hashId, hostOf, isHttpUrl, nowIso } from "../util";
import { importListingImage } from "./media";
import {
  descriptionBullets,
  extractWebsite,
  firstParagraph,
  itunesLookupUrl,
  listingFromItunes,
  listingFromPlayHtml,
  parseAppStoreUrl,
  parsePlayUrl,
  playListingUrl,
  pricingSentences,
  type ItunesResult,
} from "./parsers";

const LABEL: Record<StoreListing["source"], string> = { app_store: "App Store", google_play: "Google Play", website: "website" };

type EvidenceInput = Pick<AppEvidence, "kind" | "fact" | "source"> & { assetId?: string };

/** Literal facts from a public listing, each with provenance. Never paraphrased. */
export function listingEvidence(listing: StoreListing, screenshots: MediaAsset[], extraBullets: string[] = []): EvidenceInput[] {
  const label = listing.source === "website" ? hostOf(listing.url) : LABEL[listing.source];
  const source = (excerpt?: string) => ({
    kind: listing.source === "website" ? ("url" as const) : ("store_listing" as const),
    url: listing.url,
    title: clip(`${listing.name ?? "App"} — ${label}`, 500),
    retrievedAt: listing.fetchedAt,
    contentHash: listing.contentHash,
    excerpt: excerpt ? clip(excerpt, 2000) : undefined,
  });
  const out: EvidenceInput[] = [];
  const add = (kind: EvidenceInput["kind"], fact: string, assetId?: string) => out.push({ kind, fact: clip(fact, 1000), source: source(fact), assetId });
  if (listing.name) add("other", `Listed as "${listing.name}"${listing.developer ? ` by ${listing.developer}` : ""} on ${label}`);
  if (listing.subtitle) add("positioning", listing.subtitle);
  if (listing.category) add("positioning", `${label} category: ${listing.category}`);
  if (listing.source === "app_store") add("platform", "Available for iOS on the App Store");
  if (listing.source === "google_play") add("platform", "Available for Android on Google Play");
  if (listing.price) add("pricing", `${label} price: ${listing.price}`);
  if (listing.hasInAppPurchases) add("pricing", `${label} listing states the app offers in-app purchases`);
  if (listing.ratingObserved !== undefined && listing.ratingCountObserved) {
    add("metric", `${label} average rating ${listing.ratingObserved} from ${listing.ratingCountObserved.toLocaleString("en-US")} ratings (observed ${listing.fetchedAt.slice(0, 10)})`);
  }
  if (listing.description) {
    add("positioning", firstParagraph(listing.description));
    const bullets = listing.source === "website" ? extraBullets : descriptionBullets(listing.description);
    const pricing = pricingSentences(listing.description).filter((x) => !bullets.includes(x));
    for (const b of bullets) add(pricingSentences(b).length ? "pricing" : "feature", b);
    for (const x of pricing) add("pricing", x);
  }
  if (listing.releaseNotes) add("other", `Latest release notes: ${listing.releaseNotes}`);
  screenshots.forEach((a, i) => add("visual", `Screenshot ${i + 1} of ${screenshots.length} from the ${label} listing`, a.id));
  return out.slice(0, 40);
}

async function fetchListing(ctx: JobContext, kind: AppImport["sources"][number]["kind"], url: string, defaultCountry: string): Promise<{ listing: StoreListing; bullets?: string[]; iconUrl?: string; discovered?: { ios?: string; android?: string } }> {
  const fetcher = fetcherFor(ctx.platform);
  const fetchedAt = nowIso();
  if (kind === "app_store") {
    const parsed = parseAppStoreUrl(url);
    if (!parsed) throw new AppError("BAD_REQUEST", "Not an App Store app link", { userMessage: "That doesn't look like an App Store app link (it should contain /id123…)." });
    const res = await fetcher(itunesLookupUrl(parsed.id, parsed.country ?? defaultCountry), { maxBytes: 3 * 1024 * 1024, signal: ctx.signal, headers: { accept: "application/json, text/javascript" } });
    if (res.status !== 200) throw new AppError(res.status >= 500 ? "PROVIDER_UNAVAILABLE" : "PROVIDER_ERROR", `iTunes Lookup returned ${res.status}`);
    let body: { resultCount?: number; results?: (ItunesResult & { wrapperType?: string })[] };
    try {
      body = JSON.parse(res.text());
    } catch {
      throw new AppError("PROVIDER_ERROR", "iTunes Lookup returned invalid JSON");
    }
    const r = (body.results ?? []).find((x) => x.kind === "software" || x.wrapperType === "software" || x.trackId !== undefined);
    if (!r) throw new AppError("NOT_FOUND", `No App Store app with id ${parsed.id} in ${(parsed.country ?? defaultCountry).toUpperCase()}`, { userMessage: "We couldn't find that app on the App Store for this country." });
    return { listing: listingFromItunes(r, url, fetchedAt) };
  }
  if (kind === "google_play") {
    const parsed = parsePlayUrl(url);
    if (!parsed) throw new AppError("BAD_REQUEST", "Not a Google Play app link", { userMessage: "That doesn't look like a Google Play app link (it should contain ?id=…)." });
    const pageUrl = playListingUrl(parsed.packageId, parsed.hl ?? "en", parsed.gl ?? defaultCountry.toUpperCase());
    const res = await fetcher(pageUrl, { accept: ["text/html"], maxBytes: 4 * 1024 * 1024, signal: ctx.signal, headers: { "accept-language": "en-US,en;q=0.8" } });
    if (res.status === 404) throw new AppError("NOT_FOUND", `Google Play app ${parsed.packageId} not found`, { userMessage: "We couldn't find that app on Google Play." });
    if (res.status !== 200) throw new AppError(res.status >= 500 ? "PROVIDER_UNAVAILABLE" : "PROVIDER_ERROR", `Google Play returned ${res.status}`);
    const listing = listingFromPlayHtml(res.text(), pageUrl, fetchedAt);
    if (!listing.name && !listing.description) throw new AppError("PROVIDER_ERROR", "Could not read the Google Play listing page");
    return { listing };
  }
  const res = await fetcher(url, { accept: ["text/html", "application/xhtml"], maxBytes: 3 * 1024 * 1024, signal: ctx.signal });
  if (res.status !== 200) throw new AppError(res.status >= 500 ? "PROVIDER_UNAVAILABLE" : "PROVIDER_ERROR", `Website returned ${res.status}`);
  const site = extractWebsite(res.text(), res.url, fetchedAt);
  return { listing: site.listing, bullets: site.bullets, iconUrl: site.iconUrl, discovered: { ios: site.appStoreUrl, android: site.playStoreUrl } };
}

/**
 * app.import: public listing import (App Store via iTunes Lookup, Google Play listing page,
 * website). Stores listings, downloads icon + screenshots as product-truth assets, records
 * literal listing facts as AppEvidence, updates the App and enqueues app.analyze.
 * Partial failures become warnings (status `partial`); nothing is invented.
 */
export async function appImportHandler(ctx: JobContext<"app.import">): Promise<JobResult> {
  const { appId, importId } = ctx.payload;
  const ws = ctx.ws;
  const apps = ws.collection("apps");
  const imports = ws.collection("appImports");
  const app = await apps.getOrThrow(appId);
  const imp = await imports.getOrThrow(importId);
  if (imp.appId !== appId) throw new AppError("BAD_REQUEST", "Import does not belong to this app");

  await ctx.progress(5, "fetching listings");
  await imports.update(importId, { status: "fetching", jobId: ctx.job.id, error: undefined }, { actor: ctx.actor });

  const warnings: string[] = [];
  const listings: StoreListing[] = [];
  const assets: MediaAsset[] = [];
  const evidenceIds: string[] = [];
  const sources = [...imp.sources];
  const discovered: { ios?: string; android?: string } = {};
  const country = (app.targetCountries[0] ?? "us").toLowerCase();
  let iconAsset: MediaAsset | undefined;
  let lastRetryable: AppError | undefined;

  for (let i = 0; i < sources.length; i++) {
    const src = sources[i]!;
    if (!src.url || src.kind === "manual" || src.kind === "upload") continue;
    ctx.throwIfCancelled();
    await ctx.progress(10 + Math.round((60 * i) / sources.length), `reading ${src.kind.replace("_", " ")}`);
    try {
      const got = await fetchListing(ctx, src.kind, src.url, country);
      const { listing } = got;
      listings.push(listing);
      if (got.discovered?.ios && !app.storeUrls.ios && !sources.some((s) => s.kind === "app_store")) {
        discovered.ios = got.discovered.ios;
        sources.push({ kind: "app_store", url: got.discovered.ios });
      }
      if (got.discovered?.android && !app.storeUrls.android && !sources.some((s) => s.kind === "google_play")) {
        discovered.android = got.discovered.android;
        sources.push({ kind: "google_play", url: got.discovered.android });
      }
      const provider = listing.source === "website" ? hostOf(listing.url) : LABEL[listing.source];
      const origin = listing.source === "website" ? ("website_import" as const) : ("store_import" as const);
      const shots: MediaAsset[] = [];
      const iconUrl = listing.iconUrl ?? got.iconUrl;
      if (iconUrl && (!iconAsset || listing.source !== "website")) {
        try {
          const a = await importListingImage(ctx, { appId, url: iconUrl, role: "icon", origin, provider, attribution: listing.developer, title: `${listing.name ?? app.name} icon (${provider})`, label: listing.source });
          if (!iconAsset || (iconAsset.origin === "website_import" && origin === "store_import")) iconAsset = a;
          assets.push(a);
        } catch (err) {
          warnings.push(`${provider}: could not download the app icon (${toAppError(err).message})`);
        }
      }
      for (const [n, url] of listing.screenshotUrls.entries()) {
        ctx.throwIfCancelled();
        try {
          const a = await importListingImage(ctx, { appId, url, role: "screenshot", origin, provider, attribution: listing.developer, title: `${listing.name ?? app.name} screenshot ${n + 1} (${provider})`, label: listing.source });
          shots.push(a);
          assets.push(a);
        } catch (err) {
          warnings.push(`${provider}: could not download screenshot ${n + 1} (${toAppError(err).message})`);
        }
      }
      for (const e of listingEvidence(listing, shots, got.bullets)) {
        const id = hashId("evd", appId, listing.url, e.kind, e.fact);
        await ws.collection("appEvidence").createIfAbsent({ id, appId, kind: e.kind, fact: e.fact, source: e.source, assetId: e.assetId, observedAt: listing.fetchedAt, reviewState: "verified" }, { actor: ctx.actor });
        evidenceIds.push(id);
      }
      if (listing.source === "app_store" && !listing.screenshotUrls.length) warnings.push("App Store: the public listing returned no iPhone/iPad screenshots. Upload screenshots so videos can show your real app.");
    } catch (raw) {
      const err = toAppError(raw);
      if (err.code === "CANCELLED") throw err;
      if (err.retryable) lastRetryable = err;
      warnings.push(`${src.kind.replace("_", " ")}: ${err.opts.userMessage ?? err.message}`);
    }
  }

  const manualEvidence = (await ws.collection("appEvidence").list({ where: [["appId", "==", appId]], limit: 200 })).items.filter((e) => e.source.kind === "user_input");
  if (!listings.length && !manualEvidence.length) {
    if (lastRetryable && ctx.job.attempts < ctx.job.maxAttempts) throw lastRetryable;
    await imports.update(importId, { status: "failed", warnings: warnings.map((w) => clip(w, 500)).slice(0, 50), error: clip(warnings.join("; ") || "Nothing could be imported", 2000) }, { actor: ctx.actor });
    await apps.update(appId, { status: "draft" }, { actor: ctx.actor });
    throw new AppError("PROVIDER_ERROR", `Import failed: ${warnings.join("; ") || "no sources"}`, { retryable: false, userMessage: "We couldn't read your app's listing. Check the link, or describe your app and upload screenshots instead." });
  }

  // Update the App with listing facts the user hasn't set themselves.
  const first = listings.find((l) => l.source !== "website") ?? listings[0];
  const platforms = new Set<AppPlatform>(app.platforms);
  for (const l of listings) {
    if (l.source === "app_store") platforms.add("ios");
    if (l.source === "google_play") platforms.add("android");
  }
  if (!platforms.size && listings.some((l) => l.source === "website")) platforms.add("web");
  await apps.update(
    appId,
    {
      name: app.name === "New app" && first?.name ? clip(first.name, 120) : app.name,
      platforms: [...platforms],
      category: app.category ?? first?.category,
      iconAssetId: app.iconAssetId ?? iconAsset?.id,
      storeUrls: { ios: app.storeUrls.ios ?? (isHttpUrl(discovered.ios) ? discovered.ios : undefined), android: app.storeUrls.android ?? (isHttpUrl(discovered.android) ? discovered.android : undefined) },
      status: "draft",
      lastImportId: importId,
    },
    { actor: ctx.actor },
  );

  const importedAssetIds = [...new Set(assets.map((a) => a.id))];
  await imports.update(
    importId,
    { status: "analyzing", sources: sources.slice(0, 10), listings, importedAssetIds, warnings: warnings.map((w) => clip(w, 500)).slice(0, 50) },
    { actor: ctx.actor },
  );
  await ctx.progress(85, "queueing App DNA analysis");

  let analyzeJobId: string | undefined;
  try {
    const job = await ctx.enqueue("app.analyze", { appId, importId, assetIds: [] }, { idempotencyKey: `app.analyze:${importId}`, credits: { operation: "app.analyze" } });
    analyzeJobId = job.id;
    await apps.update(appId, { dnaStatus: "drafting" }, { actor: ctx.actor });
  } catch (raw) {
    const err = toAppError(raw);
    if (err.code !== "INSUFFICIENT_CREDITS" && err.code !== "QUOTA_EXCEEDED") throw err;
    warnings.push(`App DNA analysis not started: ${err.opts.userMessage ?? err.message}`);
    await imports.update(importId, { status: "partial", warnings: warnings.map((w) => clip(w, 500)).slice(0, 50) }, { actor: ctx.actor });
  }

  return {
    refs: [{ entity: "appImports", id: importId }, ...importedAssetIds.map((id) => ({ entity: "mediaAssets", id }))],
    data: { listings: listings.length, assets: importedAssetIds.length, evidence: evidenceIds.length, warnings, analyzeJobId },
  };
}
