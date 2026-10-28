import type { AttributionLink, CopyPack } from "@muselaunch/contracts";
import { describe, expect, it } from "vitest";
import { fillPackLinks } from "./package";

const pack = (channel: CopyPack["channel"], text: string) => ({ id: `cp_${channel}`, channel, locale: "en", items: [{ kind: "caption", text }] }) as unknown as CopyPack;
const link = (slug: string, extra: Partial<AttributionLink> = {}) => ({ id: `lnk_${slug}`, slug, active: true, ...extra }) as unknown as AttributionLink;
const url = (slug: string) => `https://go.example/r/${slug}`;

describe("export copy links", () => {
  it("uses the channel's tracked link, else the campaign's general link; never a post-specific or inactive one", () => {
    const out = fillPackLinks(
      [pack("tiktok", "Try it: [APP_LINK]"), pack("instagram", "Link: [APP_LINK]"), pack("youtube", "No placeholder here")],
      [link("post-only", { channel: "instagram", scheduledPostId: "pst_1" }), link("old", { channel: "instagram", active: false }), link("tt", { channel: "tiktok" }), link("general")],
      url,
    );
    expect(out.map((p) => p.items[0]!.text)).toEqual(["Try it: https://go.example/r/tt", "Link: https://go.example/r/general", "No placeholder here"]);
  });

  it("leaves the placeholder when the campaign has no usable link (nothing invented)", () => {
    expect(fillPackLinks([pack("tiktok", "Try it: [APP_LINK]")], [], url)[0]!.items[0]!.text).toBe("Try it: [APP_LINK]");
  });
});
