import { describe, expect, it } from "vitest";
import { shellStateFor } from "./shell-state";

const app = (rest: string) => `/w/ws_1/a/app_1${rest}`;

describe("shellStateFor", () => {
  it("maps Home, Create and Results", () => {
    expect(shellStateFor(app("/home")).tab).toBe("home");
    expect(shellStateFor(app("")).tab).toBe("home");
    expect(shellStateFor(app("/create")).tab).toBe("create");
    expect(shellStateFor(app("/results")).tab).toBe("results");
  });

  it("puts Creator's deep pages and Discover under Create", () => {
    for (const p of ["/creator", "/creator/make", "/creator/videos", "/creator/scheduled", "/creator/new", "/creator/campaigns/c1", "/creator/studio/comp1", "/discover", "/discover/all", "/library", "/calendar"]) {
      expect(shellStateFor(app(p)).tab, p).toBe("create");
    }
  });

  it("puts Insights and its details under Results", () => {
    expect(shellStateFor(app("/insights")).tab).toBe("results");
    expect(shellStateFor(app("/insights/details")).tab).toBe("results");
  });

  it("gives other pages no tab, with their section", () => {
    expect(shellStateFor(app("/brand"))).toEqual({ tab: null, section: "brand", fullBleed: false });
    expect(shellStateFor(app("/runs/r1"))).toMatchObject({ tab: null, section: "runs" });
    expect(shellStateFor(app("/autopilot"))).toMatchObject({ tab: null, section: "autopilot" });
    expect(shellStateFor("/w/ws_1/settings/team")).toEqual({ tab: null, section: "team", fullBleed: false });
    expect(shellStateFor("/w/ws_1/settings")).toMatchObject({ tab: null, section: "settings" });
    expect(shellStateFor("/w/ws_1/needs-you")).toMatchObject({ tab: null, section: "needs-you" });
  });

  it("lets only the Studio fill the window", () => {
    expect(shellStateFor(app("/creator/studio/comp1")).fullBleed).toBe(true);
    expect(shellStateFor(app("/creator/videos")).fullBleed).toBe(false);
    expect(shellStateFor(app("/home")).fullBleed).toBe(false);
  });
});
