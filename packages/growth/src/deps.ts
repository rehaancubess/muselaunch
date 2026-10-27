import { createHmac } from "node:crypto";
import type { ConnectionProvider } from "@muselaunch/contracts";
import type { Platform } from "@muselaunch/platform";
import { PROVIDER_ADAPTERS, type AdapterSettings, type ClientCredentials, type FetchLike } from "@muselaunch/providers";

/**
 * Module E settings. Provider OAuth credentials are deployment env vars (never per-user input);
 * read here rather than in platform Config so the integrator-owned schema stays unchanged.
 */
export interface GrowthSettings {
  creds: Partial<Record<ConnectionProvider, ClientCredentials>>;
  adapter: AdapterSettings;
  /** HMAC key for OAuth `state`. */
  oauthStateKey: Buffer;
  /** Max outreach messages (API or manually confirmed) per app in a rolling 24 h. */
  outreachDailyLimit: number;
  /** Minimum seconds between two outreach sends in a workspace (no bulk blasts). */
  outreachMinIntervalSec: number;
  /** Status polling inside one publish attempt (the job retries for longer processing). */
  publishMaxPolls: number;
  publishPollIntervalMs: number;
}

export interface ClaimValidationResult {
  ok: boolean;
  issues: { id: string; issue: string }[];
}

/** Signature of module B's `validateClaims` (docs/INTERFACES.md). */
export type ClaimValidator = (p: Platform, input: { workspaceId: string; appId: string; texts: { id: string; text: string }[]; jobId?: string }) => Promise<ClaimValidationResult>;

export interface GrowthDeps {
  fetch: FetchLike;
  settings: GrowthSettings;
  sleep(ms: number): Promise<void>;
  now(): number;
  /** Override for module B's validator (tests); default resolves `@muselaunch/agents`.validateClaims lazily. */
  claimValidator?: ClaimValidator | null;
}

const overrides = new WeakMap<Platform, Partial<GrowthDeps>>();
const cache = new WeakMap<Platform, GrowthDeps>();

export function loadGrowthSettings(p: Platform, env: NodeJS.ProcessEnv = process.env): GrowthSettings {
  const creds: GrowthSettings["creds"] = {};
  for (const [provider, adapter] of Object.entries(PROVIDER_ADAPTERS)) {
    const id = env[adapter!.env.clientId]?.trim();
    const secret = env[adapter!.env.clientSecret]?.trim();
    if (id && secret) creds[provider as ConnectionProvider] = { clientId: id, clientSecret: secret };
  }
  const secretSource = env.OAUTH_STATE_SECRET || p.cfg.TOKEN_ENCRYPTION_KEY || p.cfg.STORAGE_SIGNING_SECRET;
  return {
    creds,
    adapter: {
      graphApiVersion: env.META_GRAPH_API_VERSION || "v25.0",
      linkedinApiVersion: env.LINKEDIN_API_VERSION || "202605",
      tiktokAudited: ["1", "true", "yes"].includes((env.TIKTOK_AUDITED ?? "").toLowerCase()),
    },
    oauthStateKey: createHmac("sha256", "muselaunch.oauth-state.v1").update(secretSource).digest(),
    outreachDailyLimit: Number(env.OUTREACH_DAILY_SEND_LIMIT ?? 20) || 20,
    outreachMinIntervalSec: Number(env.OUTREACH_MIN_INTERVAL_SEC ?? 60) || 60,
    publishMaxPolls: 10,
    publishPollIntervalMs: 15_000,
  };
}

/** Resolve module E dependencies for a platform instance (tests inject fakes with `configureGrowth`). */
export function growthDeps(p: Platform): GrowthDeps {
  const hit = cache.get(p);
  if (hit) return hit;
  const o = overrides.get(p) ?? {};
  const base = loadGrowthSettings(p);
  const deps: GrowthDeps = {
    fetch: o.fetch ?? ((input, init) => fetch(input, init)),
    settings: { ...base, ...o.settings, adapter: { ...base.adapter, ...o.settings?.adapter }, creds: o.settings?.creds ?? base.creds },
    sleep: o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    now: o.now ?? (() => Date.now()),
    claimValidator: o.claimValidator,
  };
  cache.set(p, deps);
  return deps;
}

export function configureGrowth(p: Platform, o: Partial<Omit<GrowthDeps, "settings">> & { settings?: Partial<GrowthSettings> }): void {
  const prev = overrides.get(p) ?? {};
  overrides.set(p, { ...prev, ...o, settings: { ...prev.settings, ...o.settings } } as Partial<GrowthDeps>);
  cache.delete(p);
}

/** OAuth redirect URI registered with each provider. */
export const redirectUriFor = (p: Platform, provider: ConnectionProvider) => `${p.cfg.API_PUBLIC_URL.replace(/\/$/, "")}/v1/oauth/${provider}/callback`;
