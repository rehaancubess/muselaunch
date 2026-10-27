import type { Channel, ConnectedAccount, ConnectionProvider } from "@muselaunch/contracts";
import type { HttpClient } from "./http";

/**
 * Publishing / outreach provider adapters (owner: module E).
 *
 * Every adapter follows the provider's documented API. An adapter never reports success
 * without a real remote id/receipt returned by that API; anything uncertain is surfaced as an
 * error so the post can fall back to manual confirmation.
 */

export type AdapterCapability = ConnectedAccount["capabilities"][number];

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  /** Epoch milliseconds. */
  expiresAt?: number;
  refreshExpiresAt?: number;
  scope: string[];
  /** Provider-specific identifiers/tokens (e.g. Facebook page token, LinkedIn person URN). Stored encrypted with the tokens. */
  extra?: Record<string, string>;
}

export interface AccountIdentity {
  externalAccountId: string;
  displayName: string;
  /** Merged into tokens.extra (e.g. page access token, username). */
  extra?: Record<string, string>;
  /** Honest limits discovered while connecting (missing scopes, no channel, etc.). */
  limitations?: string[];
}

export interface ClientCredentials {
  clientId: string;
  clientSecret: string;
}

/** Deployment-level settings adapters need (API versions, review status). */
export interface AdapterSettings {
  graphApiVersion: string;
  linkedinApiVersion: string;
  /** TikTok client passed the Content Posting audit (public posts allowed). */
  tiktokAudited: boolean;
}

export interface OAuthSpec {
  /** PKCE (S256) is used when the provider supports it for confidential web clients. */
  pkce: boolean;
  scopes: string[];
  authorizeUrl(input: { clientId: string; redirectUri: string; state: string; codeChallenge?: string; settings: AdapterSettings }): string;
  exchangeCode(input: { code: string; redirectUri: string; codeVerifier?: string; creds: ClientCredentials; settings: AdapterSettings }, http: HttpClient): Promise<OAuthTokens>;
  refresh?(tokens: OAuthTokens, creds: ClientCredentials, http: HttpClient, settings: AdapterSettings): Promise<OAuthTokens>;
  revoke?(tokens: OAuthTokens, creds: ClientCredentials, http: HttpClient, settings: AdapterSettings): Promise<void>;
  identity(tokens: OAuthTokens, http: HttpClient, settings: AdapterSettings, creds: ClientCredentials): Promise<AccountIdentity>;
}

export interface PublishMedia {
  kind: "video" | "image";
  mimeType: string;
  bytes: number;
  filename: string;
  read(): Promise<Buffer>;
  /** Short-lived URL reachable from the public internet (pull-based APIs such as Instagram). */
  publicUrl?(): Promise<string>;
}

export interface PublishRequest {
  media?: PublishMedia;
  title?: string;
  caption: string;
  tags: string[];
  visibility: "public" | "unlisted" | "private";
  containsSyntheticMedia: boolean;
  /** Future time for channels with native scheduling (YouTube publishAt). */
  scheduledAt?: string;
}

export interface PublishContext {
  http: HttpClient;
  tokens: OAuthTokens;
  externalAccountId: string;
  settings: AdapterSettings;
  creds: ClientCredentials;
  /** Resume state saved by a previous attempt of the same post. */
  state: Record<string, unknown>;
  /** Persist resume state BEFORE each non-idempotent remote step. */
  saveState(patch: Record<string, unknown>): Promise<void>;
  sleep(ms: number): Promise<void>;
  signal?: AbortSignal;
  /** Poll budget for async processing (status checks). */
  maxPolls?: number;
  pollIntervalMs?: number;
}

export interface PublishResult {
  remoteId: string;
  remoteUrl?: string;
  /** Sanitised provider response(s): ids, statuses, timestamps. Never tokens. */
  receipt: Record<string, unknown>;
  /** Effective visibility after provider constraints (e.g. TikTok unaudited → private). */
  effectiveVisibility?: "public" | "unlisted" | "private";
  notes?: string[];
}

export interface SendEmailRequest {
  from?: string;
  to: string;
  subject: string;
  body: string;
}

export interface SendResult {
  messageId: string;
  receipt: Record<string, unknown>;
}

export interface ProviderAdapter {
  provider: ConnectionProvider;
  label: string;
  /** Channels this adapter can publish to (empty for outreach-only providers). */
  channels: Channel[];
  purposes: ("publishing" | "outreach" | "analytics")[];
  capabilities: AdapterCapability[];
  /** Env vars holding the OAuth client credentials. */
  env: { clientId: string; clientSecret: string };
  /** What the owner must do before arbitrary users can connect. */
  review: { required: boolean; summary: string; docsUrl: string };
  /** Media kinds accepted by `publish`. */
  accepts: { video: boolean; image: boolean; textOnly: boolean };
  oauth: OAuthSpec;
  publish?(req: PublishRequest, ctx: PublishContext): Promise<PublishResult>;
  sendEmail?(req: SendEmailRequest, ctx: Omit<PublishContext, "state" | "saveState">): Promise<SendResult>;
}
