import type { MediaAsset, ScheduledPost } from "@muselaunch/contracts";
import { describe, expect, it } from "vitest";
import { autopilotHarness } from "./testing";
import { today } from "./today";

describe("Home's posts (today.ts): carousels, single media and text-only posts", () => {
  it("a carousel post lists every slide in posting order; a video stays single; a text post has no media", async () => {
    const h = await autopilotHarness();
    const ws = h.p.db.ws(h.wid);
    const campaign = await ws.collection("campaigns").create(
      { appId: h.appId, name: "Slides", goal: "awareness", status: "review", channels: ["instagram"], deliverables: [{ kind: "carousel", channel: "instagram", aspectRatio: "4:5", count: 1, slides: 3 }], opportunityIds: [], selectedVariantIds: [] } as never,
      { actor: "u1" },
    );
    const image = (n: number) =>
      ws.collection("mediaAssets").create(
        { appId: h.appId, campaignId: campaign.id, kind: "image", role: "render", origin: "render", storagePath: `workspaces/${h.wid}/renders/c/slide${n}.jpg`, mimeType: "image/jpeg", bytes: 1000, width: 1080, height: 1350, status: "ready", isProductTruth: false, labels: [`slide:${n}`], license: { type: "owned" } } as Partial<MediaAsset> as never,
        { actor: "u1" },
      );
    const slides = [await image(1), await image(2), await image(3)];
    const video = await ws.collection("mediaAssets").create(
      { appId: h.appId, campaignId: campaign.id, kind: "video", role: "render", origin: "render", storagePath: `workspaces/${h.wid}/renders/c/v.mp4`, mimeType: "video/mp4", bytes: 1000, width: 1080, height: 1920, durationSec: 15, status: "ready", isProductTruth: false, labels: [], license: { type: "owned" } } as Partial<MediaAsset> as never,
      { actor: "u1" },
    );
    const post = (over: Partial<ScheduledPost>) =>
      ws.collection("scheduledPosts").create(
        { appId: h.appId, campaignId: campaign.id, channel: "instagram", mode: "manual", caption: "Hello", tags: [], visibility: "public", containsSyntheticMedia: false, timezone: "UTC", status: "manual_post_needed", manualInstructions: [], attempts: 0, assetIds: [], ...over } as never,
        { actor: "u1" },
      );
    const carousel = await post({ assetIds: slides.map((s) => s.id) });
    const single = await post({ assetIds: [video.id] });
    const text = await post({ channel: "x", assetIds: [], caption: "Just text" });

    const member = { role: "owner", canPublish: true, canManageAccounts: true, status: "active" } as const;
    const res = await today(h.p, h.wid, member as never, h.appId);
    const byId = new Map(res.posts.map((x) => [x.id, x]));

    expect(byId.get(carousel.id)?.video).toMatchObject({ assetId: slides[0]!.id, kind: "image" });
    expect(byId.get(carousel.id)?.images?.map((i) => i.assetId)).toEqual(slides.map((s) => s.id));
    expect(byId.get(single.id)?.video).toMatchObject({ assetId: video.id, kind: "video" });
    expect(byId.get(single.id)?.images).toBeUndefined();
    expect(byId.get(text.id)?.video).toBeNull();
    expect(byId.get(text.id)?.images).toBeUndefined();
  });
});
