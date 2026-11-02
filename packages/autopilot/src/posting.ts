/**
 * Where Autopilot drafts its posts: the person's "Where do you post?" answer (`apps.postTo`, from the
 * first-run quick setup or Settings › The basics), else the campaign's channels as before.
 *
 * With platforms chosen, a chosen platform that has a connected account goes first (its posts can go
 * out once approved), then the first one chosen. The connected account is attached so the post is
 * ready to publish after approval; `createPost` still decides API vs manual honestly (configured on
 * this deployment, connected, allowed to publish). "I'll post myself" never attaches an account:
 * those posts come as the video and caption to post by hand. Every post waits for its approval.
 */
import type { App, Channel, ConnectedAccount } from "@muselaunch/contracts";
import { publishingAdapterForChannel } from "@muselaunch/providers";

export interface PostingTarget {
  channel: Channel;
  /** The connected account to publish with once approved (absent → the post is posted by hand). */
  accountId?: string;
  /** Plain words for the run's log (empty when nothing was chosen: the run behaves as before). */
  note: string;
}

/** A connected account that can publish to `channel` for this app (the app's own first, then a workspace-wide one). */
export function publishingAccountFor(accounts: readonly ConnectedAccount[], appId: string, channel: Channel): ConnectedAccount | undefined {
  const adapter = publishingAdapterForChannel(channel);
  if (!adapter) return undefined;
  const usable = accounts.filter((a) => a.provider === adapter.provider && a.status === "connected" && a.capabilities.some((c) => c.startsWith("publish_")) && (!a.appId || a.appId === appId));
  return usable.find((a) => a.appId === appId) ?? usable[0];
}

export function postingTarget(app: Pick<App, "id" | "postTo"> | null | undefined, campaignChannels: readonly Channel[], accounts: readonly ConnectedAccount[]): PostingTarget {
  const fallback: Channel = campaignChannels[0] ?? "instagram";
  const choice = app?.postTo;
  if (!app || !choice) return { channel: fallback, note: "" };
  if (choice.manual || !choice.channels.length) return { channel: fallback, note: "You post these yourself: each post comes with its video and caption." };
  for (const channel of choice.channels) {
    const acc = publishingAccountFor(accounts, app.id, channel);
    if (acc) return { channel, accountId: acc.id, note: `Drafted for ${acc.displayName}, your connected account; it goes out only after you approve it.` };
  }
  return { channel: choice.channels[0]!, note: "Drafted for where you post. No account is connected for it, so you post it yourself." };
}
