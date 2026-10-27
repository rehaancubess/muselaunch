import type { Channel, ConnectionProvider } from "@muselaunch/contracts";
import { gmailAdapter, youtubeAdapter } from "./google";
import { facebookAdapter, instagramAdapter } from "./meta-social";
import { linkedinAdapter } from "./linkedin";
import { tiktokAdapter } from "./tiktok";
import type { ProviderAdapter } from "./types";
import { xAdapter } from "./x";

export * from "./types";
export * from "./http";
export { buildRawEmail, gmailAdapter, youtubeAdapter, youtubeMetadata, GMAIL_SEND_URL, YOUTUBE_UPLOAD_URL, YOUTUBE_CHANNELS_URL, GOOGLE_TOKEN_URL, GOOGLE_AUTHORIZE_URL } from "./google";
export { facebookAdapter, instagramAdapter, IG_GRAPH } from "./meta-social";
export { linkedinAdapter, linkedinCommentary, LINKEDIN_REST } from "./linkedin";
export { tiktokAdapter, tiktokChunks, TIKTOK_API } from "./tiktok";
export { xAdapter, X_API } from "./x";

/** Every OAuth provider MuseLaunch can connect for publishing or outreach. */
export const PROVIDER_ADAPTERS: Partial<Record<ConnectionProvider, ProviderAdapter>> = {
  youtube: youtubeAdapter,
  instagram: instagramAdapter,
  facebook: facebookAdapter,
  tiktok: tiktokAdapter,
  linkedin: linkedinAdapter,
  x: xAdapter,
  gmail: gmailAdapter,
};

export function providerAdapter(provider: ConnectionProvider): ProviderAdapter | undefined {
  return PROVIDER_ADAPTERS[provider];
}

/** The adapter that can publish to a channel via API, if any. */
export function publishingAdapterForChannel(channel: Channel): ProviderAdapter | undefined {
  return Object.values(PROVIDER_ADAPTERS).find((a) => a?.publish && a.channels.includes(channel));
}

/**
 * Channels that are always manual: no official posting API, or policy forbids automated posting
 * (Reddit/communities: drafts + manual only, never implicit auto-posting).
 */
export const MANUAL_ONLY_CHANNELS: readonly Channel[] = ["threads", "reddit", "producthunt", "hackernews", "newsletter", "website", "app_store", "google_play", "other"];

/** Test utilities (scripted fetch + documented fixtures); not used by product code. */
export { FakeFetch, growthFixture, type RecordedRequest } from "./fake-fetch";
