import type { ConnectedAccount } from "@muselaunch/contracts";
import { describe, expect, it } from "vitest";
import { postingTarget, publishingAccountFor, startAutopilot } from "./index";
import { autopilotHarness } from "./testing";

const acc = (over: Partial<ConnectedAccount>): ConnectedAccount =>
  ({
    id: "acc_1",
    workspaceId: "ws",
    provider: "youtube",
    purposes: ["publishing"],
    externalAccountId: "UC1",
    displayName: "Tidy Labs",
    scopes: [],
    status: "connected",
    capabilities: ["publish_video"],
    limitations: [],
    connectedBy: "u1",
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    createdBy: "u1",
    ...over,
  }) as ConnectedAccount;

describe("Where Autopilot drafts posts (posting.ts)", () => {
  it("nothing chosen: the campaign's channel, no account, and nothing new in the log", () => {
    expect(postingTarget({ id: "app_1" }, ["tiktok"], [acc({})])).toEqual({ channel: "tiktok", note: "" });
    expect(postingTarget(null, [], [])).toEqual({ channel: "instagram", note: "" });
  });

  it("a chosen platform with a connected account goes first, with the account attached", () => {
    const t = postingTarget({ id: "app_1", postTo: { channels: ["instagram", "youtube"], manual: false } }, ["tiktok"], [acc({})]);
    expect(t).toMatchObject({ channel: "youtube", accountId: "acc_1" });
    expect(t.note).toContain("only after you approve it");
  });

  it("chosen but nothing connected: the first choice, posted by hand", () => {
    const t = postingTarget({ id: "app_1", postTo: { channels: ["linkedin", "x"], manual: false } }, ["tiktok"], [acc({ status: "revoked" })]);
    expect(t).toEqual({ channel: "linkedin", note: expect.stringContaining("you post it yourself") });
  });

  it("“I'll post myself” never attaches an account, even when one is connected", () => {
    const t = postingTarget({ id: "app_1", postTo: { channels: [], manual: true } }, ["instagram"], [acc({ provider: "instagram" })]);
    expect(t).toEqual({ channel: "instagram", note: expect.stringContaining("You post these yourself") });
  });

  it("only usable accounts: connected, able to publish, this app's or workspace-wide", () => {
    expect(publishingAccountFor([acc({ capabilities: ["read_insights"] })], "app_1", "youtube")).toBeUndefined();
    expect(publishingAccountFor([acc({ appId: "app_other" })], "app_1", "youtube")).toBeUndefined();
    expect(publishingAccountFor([acc({ id: "acc_ws" }), acc({ id: "acc_app", appId: "app_1" })], "app_1", "youtube")?.id).toBe("acc_app");
    expect(publishingAccountFor([acc({})], "app_1", "reddit")).toBeUndefined();
  });

  it("a run drafts its posts where the person said they post, with their connected account", async () => {
    const h = await autopilotHarness();
    const ws = h.p.db.ws(h.wid);
    await ws.collection("apps").update(h.appId, { postTo: { channels: ["tiktok", "youtube"], manual: false } }, { actor: "u1" });
    const yt = await ws.collection("connectedAccounts").create(
      { provider: "youtube", purposes: ["publishing"], externalAccountId: "UC1", displayName: "Tidy Labs", scopes: [], status: "connected", capabilities: ["publish_video"], limitations: [], connectedBy: "u1" },
      { actor: "u1" },
    );
    const { autopilot } = await startAutopilot(h.p, h.wid, h.appId, { goal: "More App Store installs from students before exams", maxCredits: 400, maxIterations: 1, autoApproveCredits: 100, variants: 2 }, "u1");
    await h.p.inline!.drain();
    const ap = await ws.collection("autopilots").getOrThrow(autopilot.id);
    expect(ap.scheduledPostIds.length).toBeGreaterThan(0);
    const campaign = await ws.collection("campaigns").getOrThrow(ap.campaignId!);
    expect(campaign.channels).toEqual(["tiktok", "youtube"]);
    const posts = await ws.collection("scheduledPosts").getMany(ap.scheduledPostIds);
    for (const post of posts) {
      expect(post.channel).toBe("youtube");
      expect(post.accountId).toBe(yt.id);
      // Still waiting for a person: nothing is published by the run.
      expect(post.status, JSON.stringify(ap.log.filter((e) => e.summary.includes("draft")).map((e) => e.summary))).toBe("awaiting_approval");
    }
    expect(ap.log.some((e) => e.summary.includes("Drafted for Tidy Labs, your connected account"))).toBe(true);
  });
});
