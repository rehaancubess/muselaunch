import { safeFetch, type Platform, type SafeFetchOptions, type SafeFetchResult } from "@muselaunch/platform";

/**
 * Outbound fetch for public pages (store listings, websites, research pages). Always SSRF-safe
 * `safeFetch` in the product; tests install a fake that serves labelled fixtures.
 */
export type Fetcher = (url: string, opts?: SafeFetchOptions) => Promise<SafeFetchResult>;

const fetchers = new WeakMap<Platform, Fetcher>();

export function installFetcher(p: Platform, f: Fetcher): void {
  fetchers.set(p, f);
}

export function fetcherFor(p: Platform): Fetcher {
  return fetchers.get(p) ?? safeFetch;
}

/** Helper for fakes: build a SafeFetchResult. */
export function fetchResult(url: string, body: string | Buffer, contentType: string, status = 200): SafeFetchResult {
  const buf = typeof body === "string" ? Buffer.from(body) : body;
  return { url, status, contentType, headers: { "content-type": contentType }, body: buf, text: () => buf.toString("utf8") };
}
