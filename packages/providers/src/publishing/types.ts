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
  /**
   * Meta "Unified login" configuration for Instagram (Facebook Login for Business, system-user token).
   * Meta apps created since 2026 can't use Instagram Login; when this is set, Instagram connects with
   * the Meta app id/secret and this config_id instead.
   */
  instagramLoginConfigId?: string;
  /** Facebook Login for Business configuration for Page posting (new Meta apps reject `scope`). */
  facebookLoginConfigId?: string;
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
  /** Pixel size when known (some APIs limit it, e.g. LinkedIn images under 36,152,320 pixels). */
  width?: number;
  height?: number;
  read(): Promise<Buffer>;
  /** Short-lived URL reachable from the public internet (pull-based APIs such as Instagram). */
  publicUrl?(): Promise<string>;
}

export interface PublishRequest {
  /** The single media of the post (a video or one image). Unset when `items` is set. */
  media?: PublishMedia;
  /**
   * The ordered media of a multi-image post (a carousel's slides, 2 or more), in posting order.
   * Only set for 2+ media; a single video/image stays in `media`, a text-only post has neither.
   * Adapters that can't post several media refuse a request with `items` (never post just one).
   */
  items?: PublishMedia[];
  /** Custom cover for a video post, where the adapter can set one (`accepts.thumbnail`). */
  thumbnail?: PublishMedia;
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

/** What a post carries: nothing (text only), one video, one image, several images, or a mix. */
export type MediaShape = "text" | "video" | "image" | "carousel" | "mixed";

/** The media of a request in posting order (`items` when set, else the single `media`). */
export function requestMedia(req: Pick<PublishRequest, "media" | "items">): PublishMedia[] {
  if (req.items?.length) return req.items;
  return req.media ? [req.media] : [];
}

export function mediaShapeOf(media: readonly Pick<PublishMedia, "kind">[]): MediaShape {
  if (!media.length) return "text";
  const videos = media.filter((m) => m.kind === "video").length;
  if (media.length === 1) return videos ? "video" : "image";
  return videos ? "mixed" : "carousel";
}

/** What an adapter's `publish` takes (the web explains these limits in plain words). */
export interface AdapterAccepts {
  video: boolean;
  /** A single image. */
  image: boolean;
  textOnly: boolean;
  /** Several images in one post, in order (a carousel's slides); null when this API can't. */
  carousel: { min: number; max: number; mimeTypes: string[] } | null;
  /** Image formats a single image (and each carousel slide) may have; empty when images aren't taken. */
  imageMimeTypes: string[];
  /** Sets a custom cover image on a video post (`PublishRequest.thumbnail`). */
  thumbnail: boolean;
  /** Plain-words reason a shape isn't taken through this API (the post is then posted by hand). */
  manualReason?: Partial<Record<MediaShape, string>>;
}

/** Whether the adapter takes this shape at all (counts and formats are checked separately). */
export function acceptsShape(a: AdapterAccepts, shape: MediaShape): boolean {
  switch (shape) {
    case "text":
      return a.textOnly;
    case "video":
      return a.video;
    case "image":
      return a.image;
    case "carousel":
      return a.carousel !== null;
    case "mixed":
      return false;
  }
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
  /** Media accepted by `publish`. */
  accepts: AdapterAccepts;
  oauth: OAuthSpec;
  publish?(req: PublishRequest, ctx: PublishContext): Promise<PublishResult>;
  sendEmail?(req: SendEmailRequest, ctx: Omit<PublishContext, "state" | "saveState">): Promise<SendResult>;
}
