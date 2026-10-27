import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { AppError, LocalStorage, safeFilename } from "@muselaunch/platform";
import { Hono } from "hono";
import type { AppEnv } from "../context";

/**
 * Serves signed URLs for the local storage driver (dev / single-machine). Tokens are HMAC-signed,
 * method-bound and expiring; there is no other way to read or write objects over HTTP.
 * Supports Range requests so video previews can seek.
 */
export const localStorageRoutes = new Hono<AppEnv>();

function localDriver(c: { get(k: "platform"): import("@muselaunch/platform").Platform }): LocalStorage {
  const s = c.get("platform").storage;
  if (!(s instanceof LocalStorage)) throw new AppError("NOT_FOUND", "Not found");
  return s;
}

localStorageRoutes.get("/:token", async (c) => {
  const storage = localDriver(c);
  const grant = storage.verify(c.req.param("token"), "GET");
  const stat = await storage.stat(grant.k);
  if (!stat) throw new AppError("NOT_FOUND", "Object not found");
  const filePath = (storage as unknown as { file(k: string): string }).file(grant.k);
  const headers: Record<string, string> = {
    "content-type": stat.contentType,
    "accept-ranges": "bytes",
    "cache-control": "private, max-age=300",
    "x-content-type-options": "nosniff",
    // SECURITY: objects are user-controlled (uploaded SVG/text, imported listing icons, stock files)
    // and are served from the API origin. A sandboxed, script-less CSP keeps an SVG or HTML-ish file
    // opened directly from running script on this origin; <img>/<video> embedding is unaffected.
    "content-security-policy": "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox",
  };
  if (grant.n) headers["content-disposition"] = `attachment; filename="${safeFilename(grant.n)}"`;
  const range = c.req.header("range")?.match(/^bytes=(\d*)-(\d*)$/);
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : stat.bytes - Number(range[2]);
    let end = range[1] && range[2] ? Number(range[2]) : stat.bytes - 1;
    start = Math.max(0, start);
    end = Math.min(end, stat.bytes - 1);
    if (start > end) return c.body(null, 416, { "content-range": `bytes */${stat.bytes}` });
    const stream = Readable.toWeb(createReadStream(filePath, { start, end })) as ReadableStream;
    return c.body(stream, 206, { ...headers, "content-range": `bytes ${start}-${end}/${stat.bytes}`, "content-length": String(end - start + 1) });
  }
  const stream = Readable.toWeb(createReadStream(filePath)) as ReadableStream;
  return c.body(stream, 200, { ...headers, "content-length": String(stat.bytes) });
});

localStorageRoutes.put("/:token", async (c) => {
  const storage = localDriver(c);
  const grant = storage.verify(c.req.param("token"), "PUT");
  const ct = c.req.header("content-type")?.split(";")[0]?.trim();
  if (grant.ct && ct !== grant.ct) throw new AppError("BAD_REQUEST", "Content-Type does not match the signed upload");
  const raw = c.req.raw.body;
  if (!raw) throw new AppError("BAD_REQUEST", "Empty upload");
  // Create-only: a signed upload URL can't overwrite an object (e.g. after it was probed and approved).
  const bytes = await storage.writeStream(grant.k, Readable.fromWeb(raw as import("node:stream/web").ReadableStream), grant.ct ?? "application/octet-stream", grant.mx, { exclusive: true });
  return c.json({ ok: true, bytes });
});
