import { formatAsTyped, hostOf, isHttpUrl, normalizeCode, parseQuery, parseScanned } from "./link-code";
import { routeForNotification } from "./notification-route";

describe("link codes", () => {
  it("accepts the 8 characters however they're typed", () => {
    expect(normalizeCode("ABCD-EFGH")).toBe("ABCDEFGH");
    expect(normalizeCode("abcd efgh")).toBe("ABCDEFGH");
    expect(normalizeCode(" 23Q4 5678 ")).toBe("23Q45678");
  });

  it("refuses the wrong length and look-alike characters the alphabet leaves out (0, O, 1, I, L)", () => {
    expect(normalizeCode("ABCDEFG")).toBeNull();
    expect(normalizeCode("ABCDEFGHJ")).toBeNull();
    for (const bad of ["ABCD0FGH", "ABCDOFGH", "ABCD1FGH", "ABCDIFGH", "ABCDLFGH", "ABCD!FGH"]) expect(normalizeCode(bad)).toBeNull();
  });

  it("formats as the person types: upper case, code characters only, a dash after four", () => {
    expect(formatAsTyped("ab")).toBe("AB");
    expect(formatAsTyped("abcde")).toBe("ABCD-E");
    expect(formatAsTyped("abcd-efgh-extra")).toBe("ABCD-EFGH");
    expect(formatAsTyped("a0b1c")).toBe("ABC");
  });

  it("reads the QR code's link (and only MuseLaunch's)", () => {
    expect(parseScanned("muselaunch://link?code=ABCDEFGH&api=https%3A%2F%2Fapi.example.com%2F")).toEqual({ code: "ABCDEFGH", api: "https://api.example.com" });
    expect(parseScanned("muselaunch://link?code=abcd-efgh")).toEqual({ code: "ABCDEFGH", api: null });
    expect(parseScanned("ABCD-EFGH")).toEqual({ code: "ABCDEFGH", api: null });
    expect(parseScanned("muselaunch://link?code=ABCDEFGH&api=javascript%3Aalert(1)")).toEqual({ code: "ABCDEFGH", api: null });
    expect(parseScanned("https://evil.example.com/link?code=ABCDEFGH")).toBeNull();
    expect(parseScanned("muselaunch://link?code=NOPE")).toBeNull();
  });

  it("parses queries without URLSearchParams", () => {
    expect(parseQuery("?a=1&b=x%20y&a=2&c")).toEqual({ a: "1", b: "x y", c: "" });
    expect(isHttpUrl("http://192.168.1.20:8080")).toBe(true);
    expect(isHttpUrl("ftp://x")).toBe(false);
    expect(hostOf("https://muselaunch-api.run.app/v1")).toBe("muselaunch-api.run.app");
  });
});

describe("notification taps", () => {
  it("open Home or Results on the app the push is about", () => {
    expect(routeForNotification({ url: "/?w=ws_1&a=app_2", kind: "posts_ready" })).toEqual({ path: "/", workspaceId: "ws_1", appId: "app_2" });
    expect(routeForNotification({ url: "/results?w=ws_1&a=app_2" })).toEqual({ path: "/results", workspaceId: "ws_1", appId: "app_2" });
    expect(routeForNotification({ url: "/results/", workspaceId: "ws_9", appId: "app_9" })).toEqual({ path: "/results", workspaceId: "ws_9", appId: "app_9" });
    expect(routeForNotification({ url: "muselaunch:///results?w=ws_1&a=app_2" })).toEqual({ path: "/results", workspaceId: "ws_1", appId: "app_2" });
    expect(routeForNotification({ url: "muselaunch://results" })).toEqual({ path: "/results" });
    // Anything else goes Home, never somewhere the push names.
    expect(routeForNotification({ url: "/settings" })).toEqual({ path: "/" });
    expect(routeForNotification({})).toBeNull();
    expect(routeForNotification(null)).toBeNull();
  });
});
