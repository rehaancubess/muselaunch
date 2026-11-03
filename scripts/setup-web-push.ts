/**
 * Makes the key pair MuseLaunch signs browser notifications with (Web Push, VAPID: a P-256 key pair)
 * and saves it in the root .env as WEB_PUSH_VAPID_PUBLIC_KEY / WEB_PUSH_VAPID_PRIVATE_KEY. The private
 * key goes straight into .env and is never printed. deploy.ts passes it to Cloud Run as a Secret
 * Manager secret (and makes the pair itself, the same way, if .env has none).
 *
 *   pnpm setup:web-push            # once; keeps a pair that's already there
 *   pnpm setup:web-push --force    # a new pair (every browser then has to turn notifications on again)
 *
 * Windows: double-click setup-web-push.cmd.
 */
import { createECDH } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const PUBLIC_KEY = "WEB_PUSH_VAPID_PUBLIC_KEY";
export const PRIVATE_KEY = "WEB_PUSH_VAPID_PRIVATE_KEY";

/** A new pair: the public key uncompressed (65 bytes), the private key 32 bytes, both base64url (what browsers and `web-push` expect). */
export function generateVapidKeys(): { publicKey: string; privateKey: string } {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const pub = ecdh.getPublicKey();
  let priv = ecdh.getPrivateKey();
  if (priv.length < 32) priv = Buffer.concat([Buffer.alloc(32 - priv.length), priv]);
  return { publicKey: pub.toString("base64url"), privateKey: priv.toString("base64url") };
}

/** Both keys present and a real pair (the private key's public point is the public key). */
export function validVapidPair(publicKey: string | undefined, privateKey: string | undefined): boolean {
  if (!publicKey || !privateKey || !/^[A-Za-z0-9_-]+$/.test(publicKey) || !/^[A-Za-z0-9_-]+$/.test(privateKey)) return false;
  const priv = Buffer.from(privateKey, "base64url");
  if (priv.length !== 32) return false;
  try {
    const ecdh = createECDH("prime256v1");
    ecdh.setPrivateKey(priv);
    return ecdh.getPublicKey().toString("base64url") === publicKey;
  } catch {
    return false;
  }
}

/** The value of KEY in .env text (last one wins, like dotenv), unquoted. */
export function envValue(text: string, key: string): string | undefined {
  let out: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (m && m[1] === key) out = m[2]!.trim().replace(/^(['"])(.*)\1$/, "$2");
  }
  return out?.trim() || undefined;
}

/**
 * Set KEY=VALUE lines in .env text, keeping every other line and the file's line endings: an existing
 * line (also an empty `KEY=` copied from .env.example) is replaced in place, a missing one is added
 * after `after` (or at the end).
 */
export function setEnvValues(text: string, values: Record<string, string>, after?: string): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.length ? text.split(/\r?\n/) : [];
  const missing: string[] = [];
  for (const [k, v] of Object.entries(values)) {
    const re = new RegExp(`^\\s*(?:export\\s+)?${k}\\s*=`);
    let found = false;
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i]!)) {
        // Keep only one line per key (dotenv reads the last one).
        if (found) lines.splice(i--, 1);
        else lines[i] = `${k}=${v}`;
        found = true;
      }
    }
    if (!found) missing.push(`${k}=${v}`);
  }
  if (missing.length) {
    const at = after ? lines.findIndex((l) => new RegExp(`^\\s*${after}\\s*=`).test(l)) : -1;
    if (at >= 0) lines.splice(at + 1, 0, ...missing);
    else {
      while (lines.length && lines.at(-1) === "") lines.pop();
      lines.push("", "# Browser notifications (Web Push): made by setup-web-push.cmd. Keep them: new keys mean every browser turns notifications on again.", ...missing, "");
    }
  }
  return lines.join(eol);
}

/** A short, harmless fingerprint of the public key for messages ("BOr8…Qx4"). */
export const fingerprint = (publicKey: string) => `${publicKey.slice(0, 6)}…${publicKey.slice(-4)}`;

/**
 * Make sure .env holds a key pair; returns what happened. Used by this script and by deploy.ts.
 * `force` replaces a pair that's already there.
 */
export function ensureWebPushKeys(envPath: string, opts: { force?: boolean; dryRun?: boolean } = {}): { created: boolean; publicKey: string } {
  const text = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  const pub = envValue(text, PUBLIC_KEY);
  const priv = envValue(text, PRIVATE_KEY);
  if (!opts.force && validVapidPair(pub, priv)) return { created: false, publicKey: pub! };
  const pair = generateVapidKeys();
  if (!opts.dryRun) writeFileSync(envPath, setEnvValues(text, { [PUBLIC_KEY]: pair.publicKey, [PRIVATE_KEY]: pair.privateKey }, "EXPO_ACCESS_TOKEN"), "utf8");
  return { created: true, publicKey: pair.publicKey };
}

function main() {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const envPath = join(root, ".env");
  if (!existsSync(envPath)) {
    copyFileSync(join(root, ".env.example"), envPath);
    console.log("Made .env from .env.example.");
  }
  const force = process.argv.includes("--force");
  const before = readFileSync(envPath, "utf8");
  const hadSome = Boolean(envValue(before, PUBLIC_KEY) || envValue(before, PRIVATE_KEY));
  const r = ensureWebPushKeys(envPath, { force });
  if (!r.created) {
    console.log(`Browser notification keys are already in .env (public key ${fingerprint(r.publicKey)}): nothing to do.`);
    console.log("To replace them, run it again with --force (every browser then has to turn notifications on again).");
    return;
  }
  console.log(`${hadSome ? (force ? "Replaced" : "Fixed") : "Saved"} the browser notification keys in .env:`);
  console.log(`  ${PUBLIC_KEY}   (public key ${fingerprint(r.publicKey)})`);
  console.log(`  ${PRIVATE_KEY}  (secret, not shown)`);
  console.log("");
  console.log("Next: run deploy.cmd. The private key goes to Google Secret Manager, never into the web app.");
  console.log("Local runs (start-live.cmd) use the same keys from now on, so browsers stay subscribed after a restart.");
  console.log("Keep these keys: making new ones means every browser has to turn notifications on again.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
