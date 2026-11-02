import type { AlwaysOnStatus, ConnectedAccount } from "@muselaunch/contracts";
import { describe, expect, it } from "vitest";
import { platformLine, platformStates, suggestedPace, wherePostSummary } from "./posting-lines";
import type { ConnectionsResponse, ProviderCatalogItem } from "./types";

const provider = (p: Partial<ProviderCatalogItem> & Pick<ProviderCatalogItem, "provider" | "channels" | "state">): ProviderCatalogItem => ({
  label: p.provider,
  purposes: ["publishing"],
  capabilities: ["publish_video"],
  configured: p.state !== "not_configured",
  review: { required: p.state === "pending_review", summary: "", docsUrl: "https://example.com" },
  env: [],
  redirectUri: "https://api.example.com/cb",
  detail: "",
  ...p,
});
const account = (over: Partial<ConnectedAccount>): ConnectedAccount => ({ id: "acc_1", workspaceId: "ws", provider: "x", purposes: ["publishing"], externalAccountId: "1", displayName: "@tidy", scopes: [], status: "connected", capabilities: ["publish_video"], limitations: [], connectedBy: "u", createdAt: "", updatedAt: "", createdBy: "u", ...over }) as ConnectedAccount;

const data: ConnectionsResponse = {
  items: [account({ provider: "x", appId: "app_1" }), account({ id: "acc_2", provider: "linkedin", status: "revoked" })],
  providers: [
    provider({ provider: "instagram", channels: ["instagram"], state: "not_configured" }),
    provider({ provider: "youtube", channels: ["youtube"], state: "pending_review" }),
    provider({ provider: "linkedin", channels: ["linkedin"], state: "available" }),
    provider({ provider: "x", channels: ["x"], state: "available" }),
  ],
};

describe("Where do you post? (posting-lines.ts)", () => {
  it("each platform's honest state: connected accounts first, then what this deployment can do", () => {
    const s = platformStates(data, "app_1");
    expect(s.map((x) => [x.channel, x.state])).toEqual([
      ["instagram", "not_configured"],
      ["youtube", "pending_review"],
      ["tiktok", "not_configured"], // no adapter listed at all: never offered as connectable
      ["linkedin", "available"], // its only account was revoked
      ["x", "connected"],
    ]);
    // Another app's account isn't this app's.
    expect(platformStates(data, "app_2").find((x) => x.channel === "x")?.state).toBe("available");
  });

  it("one plain line each; anything that can't post falls back to posting it yourself", () => {
    const [ig, yt, , li, x] = platformStates(data, "app_1");
    expect(platformLine(x!, true)).toBe("X: connected as @tidy. Posts go out there after you approve them.");
    expect(platformLine(yt!, true)).toBe("YouTube is waiting for Google’s review of MuseLaunch. Until then only test accounts can connect (try Connect if yours is one); otherwise you’ll get the video and caption to post yourself.");
    expect(platformLine(yt!, false)).not.toMatch(/try Connect/);
    expect(platformLine(ig!, true)).toBe("Posting to Instagram isn’t set up on MuseLaunch yet, so you’ll get the video and caption to post yourself.");
    expect(platformLine(li!, true)).toContain("Connect it, or you’ll get the video and caption to post yourself.");
    expect(platformLine(li!, false)).toContain("ask the workspace owner to connect it");
  });

  it("the Settings summary", () => {
    const s = platformStates(data, "app_1");
    expect(wherePostSummary({}, s)).toBe("Not chosen yet. You get each video and caption to post yourself.");
    expect(wherePostSummary({ postTo: { channels: [], manual: true } }, s)).toBe("You post yourself: each video comes with its caption.");
    expect(wherePostSummary({ postTo: { channels: ["x", "youtube"], manual: false } }, s)).toBe("X (connected) · YouTube (you post it)");
  });

  it("the pace the plan suggests: the most it allows that its monthly credits also cover", () => {
    const options = [
      { postsPerWeek: 1, label: "Once a week", allowed: true, weeklyCredits: 142 },
      { postsPerWeek: 3, label: "3 times a week", allowed: true, weeklyCredits: 313 },
      { postsPerWeek: 5, label: "5 times a week", allowed: false, weeklyCredits: 484 },
      { postsPerWeek: 7, label: "Every day", allowed: false, weeklyCredits: 655 },
    ] as AlwaysOnStatus["options"];
    expect(suggestedPace({ options, plan: { id: "starter", name: "Starter", postsPerWeek: 3, monthlyCredits: 1500 } })).toBe(3);
    // 3 a week would need ~1,341 credits a month: more than this plan has, so once a week.
    expect(suggestedPace({ options, plan: { id: "starter", name: "Starter", postsPerWeek: 3, monthlyCredits: 1000 } })).toBe(1);
    // Nothing fits (Free): still once a week, the smallest pace.
    expect(suggestedPace({ options: options.map((o) => ({ ...o, allowed: o.postsPerWeek === 1 })), plan: { id: "free", name: "Free", postsPerWeek: 1, monthlyCredits: 300 } })).toBe(1);
  });
});
