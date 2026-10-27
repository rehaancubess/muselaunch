import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { Agent, fetch as undiciFetch, type Response } from "undici";
import { AppError } from "./errors";

/**
 * SSRF-safe fetch for user-supplied URLs (store listings, websites, competitor pages).
 * - http(s) only, default ports only
 * - resolves DNS and rejects private, loopback, link-local, metadata and reserved ranges
 * - pins the connection to the validated address (no DNS rebinding between check and connect)
 * - re-validates every redirect hop (max 5), caps body size and total time
 */
const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blocked.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
  ["::", 128],
  ["::1", 128],
  // Deprecated IPv4-compatible (::a.b.c.d), 6to4 (2002::/16) and Teredo (2001::/32) addresses embed
  // an IPv4 address (e.g. ::7f00:1, 2002:a9fe:a9fe::), and fec0::/10 is old site-local space.
  ["::", 96],
  ["2002::", 16],
  ["2001::", 32],
  ["fec0::", 10],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
  ["64:ff9b::", 96],
  ["2001:db8::", 32],
  ["100::", 64],
] as const) {
  blocked.addSubnet(net, prefix, "ipv6");
}

export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return true;
  if (family === 6) {
    const mapped = address.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return blocked.check(mapped[1]!, "ipv4");
    return blocked.check(address, "ipv6");
  }
  return blocked.check(address, "ipv4");
}

export function assertSafeUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AppError("UNSAFE_URL", "Invalid URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new AppError("UNSAFE_URL", "Only http(s) URLs are allowed");
  if (url.username || url.password) throw new AppError("UNSAFE_URL", "Credentials in URLs are not allowed");
  if (url.port && !["80", "443"].includes(url.port)) throw new AppError("UNSAFE_URL", "Non-standard ports are not allowed");
  // A trailing dot is the same DNS name ("localhost." / "metadata.google.internal.").
  const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.+$/, "").toLowerCase();
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) {
    throw new AppError("UNSAFE_URL", "Internal hostnames are not allowed");
  }
  if (isIP(host) && isBlockedAddress(host)) throw new AppError("UNSAFE_URL", "Private addresses are not allowed");
  return url;
}

async function resolveSafe(hostname: string): Promise<{ address: string; family: 4 | 6 }> {
  const host = hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) {
    if (isBlockedAddress(host)) throw new AppError("UNSAFE_URL", "Private addresses are not allowed");
    return { address: host, family: isIP(host) as 4 | 6 };
  }
  const addrs = await lookup(host, { all: true, verbatim: true }).catch(() => {
    throw new AppError("UNSAFE_URL", `Could not resolve ${host}`);
  });
  if (!addrs.length || addrs.some((a) => isBlockedAddress(a.address))) throw new AppError("UNSAFE_URL", `${host} resolves to a disallowed address`);
  return { address: addrs[0]!.address, family: addrs[0]!.family as 4 | 6 };
}

export interface SafeFetchOptions {
  method?: "GET" | "HEAD";
  headers?: Record<string, string>;
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  /** Allowed response content types (prefix match). */
  accept?: string[];
  signal?: AbortSignal;
}

export interface SafeFetchResult {
  url: string;
  status: number;
  contentType: string;
  headers: Record<string, string>;
  body: Buffer;
  text(): string;
}

export const DEFAULT_USER_AGENT = "MuseLaunchBot/0.1 (+https://muselaunch.app/bot; app marketing research for the app owner)";

export async function safeFetch(rawUrl: string, opts: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;
  const deadline = AbortSignal.timeout(opts.timeoutMs ?? 20_000);
  const signal = opts.signal ? AbortSignal.any([opts.signal, deadline]) : deadline;
  let url = assertSafeUrl(rawUrl);
  for (let hop = 0; hop <= (opts.maxRedirects ?? 5); hop++) {
    const target = await resolveSafe(url.hostname);
    const agent = new Agent({
      connect: {
        lookup: (_host, _opts, cb) => cb(null, [{ address: target.address, family: target.family }] as never, target.family),
      },
      headersTimeout: opts.timeoutMs ?? 20_000,
      bodyTimeout: opts.timeoutMs ?? 20_000,
    });
    let res: Response;
    try {
      res = await undiciFetch(url, {
        method: opts.method ?? "GET",
        headers: { "user-agent": DEFAULT_USER_AGENT, accept: "text/html,application/json,image/*;q=0.8,*/*;q=0.5", ...opts.headers },
        redirect: "manual",
        dispatcher: agent,
        signal,
      });
    } catch (err) {
      await agent.close().catch(() => {});
      if ((err as Error).name === "TimeoutError" || (err as Error).name === "AbortError") throw new AppError("TIMEOUT", `Timed out fetching ${url.host}`);
      throw new AppError("PROVIDER_UNAVAILABLE", `Could not fetch ${url.host}: ${(err as Error).message}`, { retryable: true });
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      await res.body?.cancel().catch(() => {});
      await agent.close().catch(() => {});
      url = assertSafeUrl(new URL(res.headers.get("location")!, url).toString());
      continue;
    }
    const contentType = res.headers.get("content-type") ?? "application/octet-stream";
    if (opts.accept && !opts.accept.some((a) => contentType.startsWith(a))) {
      await res.body?.cancel().catch(() => {});
      await agent.close().catch(() => {});
      throw new AppError("UNSAFE_URL", `Unexpected content type ${contentType}`);
    }
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > maxBytes) {
      await res.body?.cancel().catch(() => {});
      await agent.close().catch(() => {});
      throw new AppError("UNSAFE_URL", `Response too large (${declared} bytes)`);
    }
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      for await (const chunk of res.body ?? []) {
        total += (chunk as Uint8Array).length;
        if (total > maxBytes) throw new AppError("UNSAFE_URL", "Response too large");
        chunks.push(Buffer.from(chunk as Uint8Array));
      }
    } finally {
      await agent.close().catch(() => {});
    }
    const body = Buffer.concat(chunks);
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => (headers[k] = v));
    return { url: url.toString(), status: res.status, contentType, headers, body, text: () => body.toString("utf8") };
  }
  throw new AppError("UNSAFE_URL", "Too many redirects");
}
