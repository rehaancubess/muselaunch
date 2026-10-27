import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile, readdir, copyFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Storage as GcsClient } from "@google-cloud/storage";
import type { Config } from "./config";
import { AppError } from "./errors";

export interface SignedUpload {
  url: string;
  method: "PUT";
  headers: Record<string, string>;
  expiresAt: string;
}

export interface ObjectStat {
  bytes: number;
  contentType: string;
  updatedAt: string;
}

/**
 * Object storage for media. All keys live under `workspaces/{workspaceId}/...` (tenant data)
 * or `system/...` (shared catalog assets). Browsers only ever get short-lived signed URLs.
 */
export interface ObjectStorage {
  readonly driver: "local" | "gcs";
  put(path: string, body: Buffer | Uint8Array | string, opts: { contentType: string; cacheControl?: string }): Promise<{ bytes: number; sha256: string }>;
  uploadFile(localPath: string, path: string, opts: { contentType: string }): Promise<{ bytes: number }>;
  get(path: string): Promise<Buffer>;
  getStream(path: string): Promise<Readable>;
  downloadToFile(path: string, localPath: string): Promise<void>;
  stat(path: string): Promise<ObjectStat | null>;
  delete(path: string): Promise<void>;
  deletePrefix(prefix: string): Promise<number>;
  signedUploadUrl(path: string, opts: { contentType: string; expiresSec?: number; maxBytes?: number }): Promise<SignedUpload>;
  signedDownloadUrl(path: string, opts?: { expiresSec?: number; downloadName?: string }): Promise<{ url: string; expiresAt: string }>;
}

const SAFE_SEGMENT = /^[A-Za-z0-9._-]{1,200}$/;

/** Build a tenant object key. Every segment is validated, so callers cannot traverse out of the workspace. */
export function workspaceKey(workspaceId: string, ...segments: string[]): string {
  for (const s of [workspaceId, ...segments]) {
    if (!SAFE_SEGMENT.test(s) || s === "." || s === "..") throw new AppError("BAD_REQUEST", `Unsafe storage path segment "${s}"`);
  }
  return ["workspaces", workspaceId, ...segments].join("/");
}

/** Throws unless `key` belongs to `workspaceId`. Call before minting any signed URL. */
export function assertKeyInWorkspace(workspaceId: string, key: string): void {
  const prefix = `workspaces/${workspaceId}/`;
  if (!key.startsWith(prefix) || key.includes("..") || key.includes("//")) {
    throw new AppError("FORBIDDEN", "Object does not belong to this workspace");
  }
}

export function safeFilename(name: string): string {
  const cleaned = name.normalize("NFKD").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120);
  return cleaned || "file";
}

function assertValidKey(key: string) {
  if (!/^(workspaces|system)\/[A-Za-z0-9._\/-]+$/.test(key) || key.includes("..") || key.includes("//")) {
    throw new AppError("BAD_REQUEST", `Invalid object key "${key}"`);
  }
}

// ---------------------------------------------------------------------------
// Local filesystem driver (dev + single-machine demos). Signed URLs are served by the API.
// ---------------------------------------------------------------------------

interface LocalToken {
  k: string; // key
  m: "GET" | "PUT";
  e: number; // expiry epoch seconds
  ct?: string; // content type (PUT must match)
  mx?: number; // max bytes (PUT)
  n?: string; // download filename
}

export class LocalStorage implements ObjectStorage {
  readonly driver = "local" as const;
  private readonly root: string;
  constructor(
    rootDir: string,
    private readonly publicBaseUrl: string,
    private readonly secret: string,
  ) {
    this.root = resolve(rootDir);
  }

  private file(key: string): string {
    assertValidKey(key);
    const p = resolve(this.root, ...key.split("/"));
    if (!p.startsWith(this.root + sep)) throw new AppError("BAD_REQUEST", "Path escapes storage root");
    return p;
  }

  async put(key: string, body: Buffer | Uint8Array | string, opts: { contentType: string }) {
    const p = this.file(key);
    await mkdir(dirname(p), { recursive: true });
    const buf = typeof body === "string" ? Buffer.from(body) : Buffer.from(body);
    await writeFile(p, buf);
    await writeFile(`${p}.meta.json`, JSON.stringify({ contentType: opts.contentType }));
    return { bytes: buf.length, sha256: createHash("sha256").update(buf).digest("hex") };
  }
  async uploadFile(localPath: string, key: string, opts: { contentType: string }) {
    const p = this.file(key);
    await mkdir(dirname(p), { recursive: true });
    await copyFile(localPath, p);
    await writeFile(`${p}.meta.json`, JSON.stringify({ contentType: opts.contentType }));
    return { bytes: (await stat(p)).size };
  }
  async get(key: string) {
    try {
      return await readFile(this.file(key));
    } catch {
      throw new AppError("NOT_FOUND", `Object ${key} not found`);
    }
  }
  async getStream(key: string) {
    await this.stat(key).then((s) => {
      if (!s) throw new AppError("NOT_FOUND", `Object ${key} not found`);
    });
    return createReadStream(this.file(key));
  }
  async downloadToFile(key: string, localPath: string) {
    await mkdir(dirname(localPath), { recursive: true });
    await copyFile(this.file(key), localPath);
  }
  async stat(key: string): Promise<ObjectStat | null> {
    try {
      const p = this.file(key);
      const s = await stat(p);
      let contentType = "application/octet-stream";
      try {
        contentType = JSON.parse(await readFile(`${p}.meta.json`, "utf8")).contentType;
      } catch {
        /* no meta */
      }
      return { bytes: s.size, contentType, updatedAt: s.mtime.toISOString() };
    } catch {
      return null;
    }
  }
  async delete(key: string) {
    const p = this.file(key);
    await rm(p, { force: true });
    await rm(`${p}.meta.json`, { force: true });
  }
  async deletePrefix(prefix: string) {
    assertValidKey(prefix.replace(/\/$/, ""));
    const dir = resolve(this.root, ...prefix.replace(/\/$/, "").split("/"));
    if (!dir.startsWith(this.root + sep)) return 0;
    let n = 0;
    try {
      n = (await readdir(dir, { recursive: true })).length;
    } catch {
      return 0;
    }
    await rm(dir, { recursive: true, force: true });
    return n;
  }

  private sign(token: LocalToken): string {
    const payload = Buffer.from(JSON.stringify(token)).toString("base64url");
    const mac = createHmac("sha256", this.secret).update(payload).digest("base64url");
    return `${payload}.${mac}`;
  }

  /** Verify a token from `/v1/storage/local/:token`. Returns the decoded grant or throws. */
  verify(token: string, method: "GET" | "PUT"): LocalToken {
    const [payload, mac] = token.split(".");
    if (!payload || !mac) throw new AppError("FORBIDDEN", "Malformed storage token");
    const expected = createHmac("sha256", this.secret).update(payload).digest();
    const got = Buffer.from(mac, "base64url");
    if (got.length !== expected.length || !timingSafeEqual(got, expected)) throw new AppError("FORBIDDEN", "Invalid storage token");
    const t = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as LocalToken;
    if (t.m !== method) throw new AppError("FORBIDDEN", "Token not valid for this method");
    if (t.e < Date.now() / 1000) throw new AppError("FORBIDDEN", "Storage token expired");
    assertValidKey(t.k);
    return t;
  }

  /** Stream an incoming PUT body to disk with a size cap. */
  async writeStream(key: string, body: Readable, contentType: string, maxBytes?: number): Promise<number> {
    const p = this.file(key);
    await mkdir(dirname(p), { recursive: true });
    let bytes = 0;
    const limiter = async function* (src: AsyncIterable<Buffer>) {
      for await (const chunk of src) {
        bytes += chunk.length;
        if (maxBytes && bytes > maxBytes) throw new AppError("BAD_REQUEST", "Upload exceeds declared size");
        yield chunk;
      }
    };
    await pipeline(body, limiter, createWriteStream(p));
    await writeFile(`${p}.meta.json`, JSON.stringify({ contentType }));
    return bytes;
  }

  async signedUploadUrl(key: string, opts: { contentType: string; expiresSec?: number; maxBytes?: number }): Promise<SignedUpload> {
    assertValidKey(key);
    const e = Math.floor(Date.now() / 1000) + (opts.expiresSec ?? 900);
    const token = this.sign({ k: key, m: "PUT", e, ct: opts.contentType, mx: opts.maxBytes });
    return {
      url: `${this.publicBaseUrl}/v1/storage/local/${token}`,
      method: "PUT",
      headers: { "Content-Type": opts.contentType },
      expiresAt: new Date(e * 1000).toISOString(),
    };
  }
  async signedDownloadUrl(key: string, opts: { expiresSec?: number; downloadName?: string } = {}) {
    assertValidKey(key);
    const e = Math.floor(Date.now() / 1000) + (opts.expiresSec ?? 3600);
    const token = this.sign({ k: key, m: "GET", e, n: opts.downloadName });
    return { url: `${this.publicBaseUrl}/v1/storage/local/${token}`, expiresAt: new Date(e * 1000).toISOString() };
  }
}

// ---------------------------------------------------------------------------
// Google Cloud Storage / Firebase Storage driver
// ---------------------------------------------------------------------------

export class GcsStorage implements ObjectStorage {
  readonly driver = "gcs" as const;
  private readonly bucket;
  constructor(bucketName: string, projectId?: string) {
    this.bucket = new GcsClient({ projectId }).bucket(bucketName);
  }
  async put(key: string, body: Buffer | Uint8Array | string, opts: { contentType: string; cacheControl?: string }) {
    assertValidKey(key);
    const buf = typeof body === "string" ? Buffer.from(body) : Buffer.from(body);
    await this.bucket.file(key).save(buf, { contentType: opts.contentType, resumable: false, metadata: { cacheControl: opts.cacheControl ?? "private, max-age=0" } });
    return { bytes: buf.length, sha256: createHash("sha256").update(buf).digest("hex") };
  }
  async uploadFile(localPath: string, key: string, opts: { contentType: string }) {
    assertValidKey(key);
    await this.bucket.upload(localPath, { destination: key, contentType: opts.contentType, resumable: true });
    return { bytes: (await stat(localPath)).size };
  }
  async get(key: string) {
    assertValidKey(key);
    try {
      const [buf] = await this.bucket.file(key).download();
      return buf;
    } catch (err) {
      if ((err as { code?: number }).code === 404) throw new AppError("NOT_FOUND", `Object ${key} not found`);
      throw err;
    }
  }
  async getStream(key: string) {
    assertValidKey(key);
    return this.bucket.file(key).createReadStream();
  }
  async downloadToFile(key: string, localPath: string) {
    assertValidKey(key);
    await mkdir(dirname(localPath), { recursive: true });
    await this.bucket.file(key).download({ destination: localPath });
  }
  async stat(key: string): Promise<ObjectStat | null> {
    assertValidKey(key);
    try {
      const [m] = await this.bucket.file(key).getMetadata();
      return { bytes: Number(m.size ?? 0), contentType: String(m.contentType ?? "application/octet-stream"), updatedAt: String(m.updated ?? new Date().toISOString()) };
    } catch (err) {
      if ((err as { code?: number }).code === 404) return null;
      throw err;
    }
  }
  async delete(key: string) {
    assertValidKey(key);
    await this.bucket.file(key).delete({ ignoreNotFound: true });
  }
  async deletePrefix(prefix: string) {
    const [files] = await this.bucket.getFiles({ prefix });
    await Promise.all(files.map((f) => f.delete({ ignoreNotFound: true })));
    return files.length;
  }
  async signedUploadUrl(key: string, opts: { contentType: string; expiresSec?: number; maxBytes?: number }): Promise<SignedUpload> {
    assertValidKey(key);
    const expires = Date.now() + (opts.expiresSec ?? 900) * 1000;
    const extensionHeaders: Record<string, string> = {};
    if (opts.maxBytes) extensionHeaders["x-goog-content-length-range"] = `0,${opts.maxBytes}`;
    const [url] = await this.bucket.file(key).getSignedUrl({ version: "v4", action: "write", expires, contentType: opts.contentType, extensionHeaders });
    return { url, method: "PUT", headers: { "Content-Type": opts.contentType, ...extensionHeaders }, expiresAt: new Date(expires).toISOString() };
  }
  async signedDownloadUrl(key: string, opts: { expiresSec?: number; downloadName?: string } = {}) {
    assertValidKey(key);
    const expires = Date.now() + (opts.expiresSec ?? 3600) * 1000;
    const [url] = await this.bucket.file(key).getSignedUrl({
      version: "v4",
      action: "read",
      expires,
      responseDisposition: opts.downloadName ? `attachment; filename="${safeFilename(opts.downloadName)}"` : undefined,
    });
    return { url, expiresAt: new Date(expires).toISOString() };
  }
}

export function createStorage(cfg: Config): ObjectStorage {
  if (cfg.STORAGE_DRIVER === "gcs") {
    if (!cfg.STORAGE_BUCKET) throw new AppError("PROVIDER_NOT_CONFIGURED", "STORAGE_BUCKET is required for STORAGE_DRIVER=gcs");
    return new GcsStorage(cfg.STORAGE_BUCKET, cfg.FIREBASE_PROJECT_ID);
  }
  return new LocalStorage(cfg.LOCAL_STORAGE_DIR, cfg.API_PUBLIC_URL, cfg.STORAGE_SIGNING_SECRET);
}

/** Convert a fetch body to a Node stream. */
export function toNodeStream(body: ReadableStream<Uint8Array>): Readable {
  return Readable.fromWeb(body as unknown as import("node:stream/web").ReadableStream<Uint8Array>);
}

export const _test = { join };
