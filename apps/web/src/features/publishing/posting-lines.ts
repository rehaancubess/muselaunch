/**
 * Plain words for "Where do you post?" that depend only on data (no React), so they can be
 * unit-tested: each platform's honest state on this deployment, the one line saying what happens to
 * its posts, the Settings summary, and the Always on pace the plan suggests.
 */
import type { AlwaysOnPace, AlwaysOnStatus, App, ConnectedAccount, PostToChannel } from "@muselaunch/contracts";
import type { ConnectionsResponse, ProviderCatalogItem } from "./types";

export const POST_PLATFORMS: { channel: PostToChannel; label: string; reviewer: string }[] = [
  { channel: "instagram", label: "Instagram", reviewer: "Meta" },
  { channel: "youtube", label: "YouTube", reviewer: "Google" },
  { channel: "tiktok", label: "TikTok", reviewer: "TikTok" },
  { channel: "linkedin", label: "LinkedIn", reviewer: "LinkedIn" },
  { channel: "x", label: "X", reviewer: "X" },
];
export const PLATFORM_LABEL = Object.fromEntries(POST_PLATFORMS.map((p) => [p.channel, p.label])) as Record<PostToChannel, string>;

export type PlatformState = {
  channel: PostToChannel;
  label: string;
  provider?: ProviderCatalogItem;
  account?: Omit<ConnectedAccount, "secretId">;
  /** connected > available (can connect here) > pending_review / not_configured (post it yourself). */
  state: "connected" | "available" | "pending_review" | "not_configured";
};

/** Each platform's honest state on this deployment, for this app. */
export function platformStates(data: Pick<ConnectionsResponse, "items" | "providers"> | undefined, appId: string): PlatformState[] {
  return POST_PLATFORMS.map(({ channel, label }) => {
    const provider = data?.providers.find((p) => p.channels.includes(channel));
    const accounts = (data?.items ?? []).filter((a) => provider && a.provider === provider.provider && a.status === "connected" && (!a.appId || a.appId === appId));
    const account = accounts.find((a) => a.appId === appId) ?? accounts[0];
    const state: PlatformState["state"] = account ? "connected" : !provider ? "not_configured" : provider.state;
    return { channel, label, provider, account, state };
  });
}

/** One plain line per chosen platform: what happens to its posts. */
export function platformLine(s: PlatformState, canConnect: boolean): string {
  const reviewer = POST_PLATFORMS.find((p) => p.channel === s.channel)?.reviewer ?? s.label;
  switch (s.state) {
    case "connected":
      return `${s.label}: connected as ${s.account?.displayName ?? "your account"}. Posts go out there after you approve them.`;
    case "available":
      return canConnect ? `${s.label} isn’t connected yet. Connect it, or you’ll get the video and caption to post yourself.` : `${s.label} isn’t connected yet: ask the workspace owner to connect it. Until then you’ll get the video and caption to post yourself.`;
    case "pending_review":
      return `${s.label} posting is waiting for ${reviewer}’s review of MuseLaunch, so you’ll get the video and caption to post yourself.`;
    case "not_configured":
      return `Posting to ${s.label} isn’t set up on MuseLaunch yet, so you’ll get the video and caption to post yourself.`;
  }
}

/** "Instagram (connected) · TikTok (you post it)", or what happens when nothing is chosen. */
export function wherePostSummary(app: Pick<App, "postTo"> | null | undefined, states: PlatformState[]): string {
  const choice = app?.postTo;
  if (!choice) return "Not chosen yet. You get each video and caption to post yourself.";
  if (choice.manual || !choice.channels.length) return "You post yourself: each video comes with its caption.";
  return choice.channels.map((c) => `${PLATFORM_LABEL[c]} (${states.find((s) => s.channel === c)?.state === "connected" ? "connected" : "you post it"})`).join(" · ");
}

/** The plan's suggestion: the most posts a week the plan allows whose monthly credits it also covers. */
export function suggestedPace(s: Pick<AlwaysOnStatus, "options" | "plan">): AlwaysOnPace {
  const fits = s.options.filter((o) => o.allowed && o.postsPerWeek <= s.plan.postsPerWeek && Math.round((o.weeklyCredits * 30) / 7) <= s.plan.monthlyCredits);
  return fits.at(-1)?.postsPerWeek ?? 1;
}
