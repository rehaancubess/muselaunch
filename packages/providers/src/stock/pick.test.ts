import type { StockItem } from "@muselaunch/contracts";
import { createTestPlatform } from "@muselaunch/platform";
import { describe, expect, it } from "vitest";
import { findStock, orientationFor, pexelsSlugTitle, queryTerms, rankStock, simplerQueries, stockProvidersFor } from "./index";

const item = (id: string, o: Partial<StockItem> = {}): StockItem => ({
  provider: "pexels",
  id,
  kind: "video",
  previewUrl: `https://images.pexels.com/videos/${id}/p.jpg`,
  pageUrl: `https://www.pexels.com/video/clip-${id}/`,
  width: 1080,
  height: 1920,
  durationSec: 10,
  license: { type: "stock_license", name: "Pexels License", url: "https://www.pexels.com/license/", attribution: "Video by X on Pexels", attributionRequired: false },
  ...o,
});

describe("stock ranking for b-roll", () => {
  it("prefers matching orientation, enough length and relevant words over provider order alone", () => {
    const input = { query: "Student studying at a desk with headphones", kind: "video" as const, orientation: "portrait" as const, minDurationSec: 5 };
    const ranked = rankStock(
      [
        [
          item("1", { width: 1920, height: 1080, pageUrl: "https://www.pexels.com/video/student-studying-at-a-desk-1/" }), // landscape
          item("2", { durationSec: 2, pageUrl: "https://www.pexels.com/video/student-studying-with-headphones-2/" }), // too short
          item("3", { pageUrl: "https://www.pexels.com/video/student-at-a-desk-with-headphones-3/" }),
        ],
        [item("4", { provider: "pixabay", width: 360, height: 640, title: "student, desk" })], // low resolution
      ],
      input,
    );
    // Portrait, long enough and relevant first; a landscape crop next; low resolution and a clip shorter than the scene last.
    expect(ranked.map((r) => r.item.id)).toEqual(["3", "1", "4", "2"]);
    // Wrong kinds and duplicates are dropped.
    expect(rankStock([[item("5"), item("5"), item("6", { kind: "image" })]], input).map((r) => r.item.id)).toEqual(["5"]);
  });

  it("derives query terms, shorter fallbacks, Pexels titles and orientation", () => {
    expect(queryTerms("A student at a calm desk with headphones, warm evening light")).toEqual(["student", "desk", "headphone", "evening"]);
    expect(simplerQueries("A student at a calm desk with headphones, warm evening light")).toEqual(["student desk headphone", "student desk"]);
    expect(simplerQueries("phone on desk")).toEqual(["phone desk"]);
    expect(simplerQueries("coffee")).toEqual([]);
    expect(pexelsSlugTitle("https://www.pexels.com/video/woman-typing-on-a-laptop-3195394/")).toBe("Woman typing on a laptop");
    expect([orientationFor("9:16"), orientationFor("4:5"), orientationFor("16:9"), orientationFor("1:1")]).toEqual(["portrait", "portrait", "landscape", "square"]);
  });

  it("searches every configured provider, retries shorter queries, keeps going when one fails, and is honest when none can serve", async () => {
    const p = createTestPlatform({ PEXELS_API_KEY: "k", PIXABAY_API_KEY: "k2" });
    expect(stockProvidersFor(p, "video")).toEqual(["pexels", "pixabay"]);
    expect(stockProvidersFor(p, "image")).toEqual(["pexels", "pixabay", "openverse"]);
    const urls: string[] = [];
    const fetchImpl = (async (u: string) => {
      urls.push(u);
      if (u.includes("pexels")) return new Response(JSON.stringify({ error: "down" }), { status: 503 });
      const q = new URL(u).searchParams.get("q");
      const hits = q === "student desk" ? [{ id: 7, pageURL: "https://pixabay.com/videos/student-desk-7/", tags: "student, desk", duration: 12, user: "u", user_id: 1, videos: { medium: { url: "https://cdn.pixabay.com/v/7.mp4", width: 720, height: 1280, thumbnail: "https://cdn.pixabay.com/v/7.jpg" } } }] : [];
      return new Response(JSON.stringify({ hits, totalHits: hits.length }), { status: 200 });
    }) as typeof fetch;
    const ctx = { workspaceId: "ws_s", task: "stock.search" };
    const r = await findStock(p, ctx, { query: "a student at a calm desk with headphones", kind: "video", orientation: "portrait", minDurationSec: 4 }, { fetch: fetchImpl });
    expect(r.candidates.map((c) => `${c.item.provider}:${c.item.id}`)).toEqual(["pixabay:7"]);
    expect(r.errors).toEqual([expect.objectContaining({ provider: "pexels", code: "PROVIDER_UNAVAILABLE" })]);
    // Pixabay: full query, then 3 terms, then 2 terms (which matched).
    expect(urls.filter((u) => u.includes("pixabay")).map((u) => new URL(u).searchParams.get("q"))).toEqual(["a student at a calm desk with headphones", "student desk headphone", "student desk"]);
    expect(urls.every((u) => !u.includes("openverse"))).toBe(true); // Openverse has no video

    const bare = createTestPlatform({});
    await expect(findStock(bare, ctx, { query: "x", kind: "video", orientation: "portrait" }, { fetch: fetchImpl })).rejects.toMatchObject({ code: "PROVIDER_NOT_CONFIGURED" });
    const down = (async () => new Response("{}", { status: 503 })) as unknown as typeof fetch;
    await expect(findStock(p, ctx, { query: "x", kind: "video", orientation: "portrait" }, { fetch: down })).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
  });
});
