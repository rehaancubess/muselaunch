import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureWebPushKeys, envValue, generateVapidKeys, setEnvValues, validVapidPair } from "./setup-web-push";

/** setup-web-push.cmd / deploy.ts: one Web Push key pair in .env, written in place, other lines untouched. */
describe("Browser notification keys in .env", () => {
  it("makes a real P-256 pair in the shape browsers expect", () => {
    const k = generateVapidKeys();
    expect(Buffer.from(k.publicKey, "base64url")).toHaveLength(65);
    expect(Buffer.from(k.publicKey, "base64url")[0]).toBe(4);
    expect(Buffer.from(k.privateKey, "base64url")).toHaveLength(32);
    expect(validVapidPair(k.publicKey, k.privateKey)).toBe(true);
    expect(validVapidPair(k.publicKey, generateVapidKeys().privateKey)).toBe(false);
    expect(validVapidPair(k.publicKey, undefined)).toBe(false);
  });

  it("fills the empty lines from .env.example in place, keeps CRLF and every other line", () => {
    const text = ["# header", "EXPO_ACCESS_TOKEN=", "WEB_PUSH_VAPID_PUBLIC_KEY=", "WEB_PUSH_VAPID_PRIVATE_KEY=", "META_API_KEY=abc", ""].join("\r\n");
    const out = setEnvValues(text, { WEB_PUSH_VAPID_PUBLIC_KEY: "PUB", WEB_PUSH_VAPID_PRIVATE_KEY: "PRIV" }, "EXPO_ACCESS_TOKEN");
    expect(out).toBe(["# header", "EXPO_ACCESS_TOKEN=", "WEB_PUSH_VAPID_PUBLIC_KEY=PUB", "WEB_PUSH_VAPID_PRIVATE_KEY=PRIV", "META_API_KEY=abc", ""].join("\r\n"));
    // Missing lines go after the anchor; duplicates collapse to one.
    const added = setEnvValues("A=1\nEXPO_ACCESS_TOKEN=x\nWEB_PUSH_VAPID_PUBLIC_KEY=old\nWEB_PUSH_VAPID_PUBLIC_KEY=older\n", { WEB_PUSH_VAPID_PUBLIC_KEY: "PUB", WEB_PUSH_VAPID_PRIVATE_KEY: "PRIV" }, "EXPO_ACCESS_TOKEN");
    expect(added).toBe("A=1\nEXPO_ACCESS_TOKEN=x\nWEB_PUSH_VAPID_PRIVATE_KEY=PRIV\nWEB_PUSH_VAPID_PUBLIC_KEY=PUB\n");
    expect(envValue('X="quoted"\nX=last\n', "X")).toBe("last");
  });

  it("keeps a valid pair, repairs a broken one, and replaces only when forced", () => {
    const dir = mkdtempSync(join(tmpdir(), "ml-webpush-"));
    const env = join(dir, ".env");
    writeFileSync(env, "EXPO_ACCESS_TOKEN=\nWEB_PUSH_VAPID_PUBLIC_KEY=\nWEB_PUSH_VAPID_PRIVATE_KEY=\nOTHER=1\n");
    const first = ensureWebPushKeys(env);
    expect(first.created).toBe(true);
    const text = readFileSync(env, "utf8");
    expect(validVapidPair(envValue(text, "WEB_PUSH_VAPID_PUBLIC_KEY"), envValue(text, "WEB_PUSH_VAPID_PRIVATE_KEY"))).toBe(true);
    expect(text).toContain("OTHER=1\n");
    expect(ensureWebPushKeys(env)).toEqual({ created: false, publicKey: first.publicKey });
    expect(ensureWebPushKeys(env, { force: true }).publicKey).not.toBe(first.publicKey);
    writeFileSync(env, readFileSync(env, "utf8").replace(/WEB_PUSH_VAPID_PRIVATE_KEY=.*/, "WEB_PUSH_VAPID_PRIVATE_KEY=broken"));
    expect(ensureWebPushKeys(env).created).toBe(true);
    const dry = join(dir, "dry.env");
    writeFileSync(dry, "A=1\n");
    expect(ensureWebPushKeys(dry, { dryRun: true }).created).toBe(true);
    expect(readFileSync(dry, "utf8")).toBe("A=1\n");
  });
});
