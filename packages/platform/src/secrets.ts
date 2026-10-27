import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { nowIso, type Db } from "@muselaunch/db";
import { z } from "zod";
import type { Config } from "./config";
import { AppError } from "./errors";

const SecretDoc = z.object({ iv: z.string(), tag: z.string(), data: z.string(), kind: z.string(), updatedAt: z.string() });

/**
 * Encrypted per-workspace secrets (OAuth tokens, third-party API keys the user connects).
 * AES-256-GCM with TOKEN_ENCRYPTION_KEY. Stored at `workspaces/{wid}/state/secret.{id}`
 * which is never exposed through any API route.
 */
export class SecretStore {
  private readonly key: Buffer | null;
  constructor(
    private readonly db: Db,
    cfg: Config,
  ) {
    if (cfg.TOKEN_ENCRYPTION_KEY) {
      const k = Buffer.from(cfg.TOKEN_ENCRYPTION_KEY, "base64");
      if (k.length !== 32) throw new Error("TOKEN_ENCRYPTION_KEY must be 32 bytes base64");
      this.key = k;
    } else {
      // Local dev only (production config validation requires a key).
      this.key = cfg.NODE_ENV === "production" ? null : Buffer.alloc(32, 7);
    }
  }

  private requireKey(): Buffer {
    if (!this.key) throw new AppError("PROVIDER_NOT_CONFIGURED", "Secret encryption is not configured");
    return this.key;
  }

  async put(workspaceId: string, id: string, kind: string, value: unknown): Promise<void> {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.requireKey(), iv);
    cipher.setAAD(Buffer.from(`${workspaceId}:${id}`));
    const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    await this.db.ws(workspaceId).state(`secret.${id}`, SecretDoc).set({ iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64"), kind, updatedAt: nowIso() });
  }

  async get<T = unknown>(workspaceId: string, id: string): Promise<T | null> {
    const doc = await this.db.ws(workspaceId).state(`secret.${id}`, SecretDoc).get();
    if (!doc) return null;
    const decipher = createDecipheriv("aes-256-gcm", this.requireKey(), Buffer.from(doc.iv, "base64"));
    decipher.setAAD(Buffer.from(`${workspaceId}:${id}`));
    decipher.setAuthTag(Buffer.from(doc.tag, "base64"));
    const plain = Buffer.concat([decipher.update(Buffer.from(doc.data, "base64")), decipher.final()]).toString("utf8");
    return JSON.parse(plain) as T;
  }

  async delete(workspaceId: string, id: string): Promise<void> {
    await this.db.ws(workspaceId).state(`secret.${id}`, SecretDoc).set({ iv: "", tag: "", data: "", kind: "deleted", updatedAt: nowIso() });
  }
}
