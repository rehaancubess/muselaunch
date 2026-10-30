import type { Claim, Opportunity, ResearchFinding, SourceRef, TrackedCreator } from "@muselaunch/contracts";
import { describe, expect, it } from "vitest";
import { pkcePair, signState, verifyState } from "./connections";
import { buildFeed, freshnessOf } from "./discover/feed";
import { groundObservations } from "./discover/refresh";
import { ruleCheck } from "./outreach/claims";
import { pickContact, sanitizeContacts } from "./outreach/contacts";
import { xWeightedLength } from "./publishing/posts";
import { suggestTimes, zonedToUtc } from "./publishing/schedule";
import { hashOf } from "./util";

const NOW = Date.parse("2026-10-27T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();
const src = (url: string, kind: SourceRef["kind"] = "search_result"): SourceRef => ({ kind, url, retrievedAt: daysAgo(0), title: url });
const base = { workspaceId: "ws1", createdAt: daysAgo(0), updatedAt: daysAgo(0), createdBy: "u" };

const opp = (id: string, over: Partial<Opportunity> = {}): Opportunity => ({
  ...base,
  id,
  appId: "app1",
  title: `Opportunity ${id}`,
  topic: "Students planning exams",
  audience: "university students",
  whyRelevant: "x",
  proposedAngle: "y",
  confidence: 0.7,
  evidence: [src(`https://example.com/${id}`)],
  findingIds: [],
  channels: ["tiktok"],
  contentType: "short_video",
  effort: "low",
  geography: ["IN"],
  observedAt: daysAgo(1),
  score: 70,
  status: "new",
  investigationRunIds: [],
  ...over,
});
const finding = (id: string, over: Partial<ResearchFinding> = {}): ResearchFinding => ({
  ...base,
  id,
  appId: "app1",
  runId: "run1",
  kind: "trend",
  statement: `Finding ${id} statement`,
  evidence: [src(`https://news.example.com/${id}`)],
  confidence: 0.8,
  corroboration: 1,
  channels: [],
  tags: [],
  observedAt: daysAgo(2),
  dedupKey: id,
  ...over,
});

describe("Discover feed", () => {
  it("ranks by score × freshness, excludes unsourced/model-inference-only items, folds findings into opportunities and dedupes", () => {
    const feed = buildFeed(
      {
        opportunities: [
          opp("o1", { score: 90, observedAt: daysAgo(40), findingIds: ["f1"] }),
          opp("o2", { score: 60, observedAt: daysAgo(0) }),
          opp("o3", { evidence: [{ kind: "model_inference", retrievedAt: daysAgo(0) }] }),
          opp("o4", { title: "Opportunity o2", score: 50, evidence: [src("https://other.example.com/x")] }),
          opp("o5", { status: "dismissed" }),
        ],
        findings: [finding("f1"), finding("f2"), finding("f3", { dedupKey: "f2", confidence: 0.5 })],
        trackers: [],
      },
      {},
      NOW,
    );
    const ids = feed.items.map((i) => i.id);
    expect(ids).not.toContain("opportunity:o3"); // model inference only
    expect(ids).not.toContain("opportunity:o5"); // dismissed
    expect(ids).not.toContain("finding:f1"); // folded into o1
    expect(ids).not.toContain("opportunity:o4"); // duplicate title of o2
    expect(feed.excluded).toMatchObject({ unsourced: 1, duplicates: 2 });
    const o2 = feed.items.find((i) => i.id === "opportunity:o2")!;
    expect(o2.sources.map((s) => s.url)).toEqual(["https://example.com/o2", "https://other.example.com/x"]);
    // o2: 60 × 1.0; f2: 56 (single source) × 0.906; o1: 90 × 0.267 (40 days old) → freshness matters
    expect(ids.slice(0, 3)).toEqual(["opportunity:o2", "finding:f2", "opportunity:o1"]);
    for (const i of feed.items) {
      expect(i.sources.length).toBeGreaterThan(0);
      expect(i.retrievedAt).toBeTruthy();
      expect(i.confidence).toBeGreaterThan(0);
      expect(i.rank).toBeCloseTo(i.score * i.freshness, 2);
    }
  });

  it("filters by channel, geography, content type, effort, age and audience", () => {
    const input = { opportunities: [opp("a", { channels: ["youtube"], geography: ["US"], effort: "high" }), opp("b"), opp("c", { observedAt: daysAgo(30), audience: "freelance designers" })], findings: [], trackers: [] };
    expect(buildFeed(input, { channel: "youtube" }, NOW).items.map((i) => i.refId)).toEqual(["a"]);
    expect(buildFeed(input, { geography: "IN" }, NOW).items.map((i) => i.refId).sort()).toEqual(["b", "c"]);
    expect(buildFeed(input, { effort: "high" }, NOW).items.map((i) => i.refId)).toEqual(["a"]);
    expect(buildFeed(input, { maxAgeDays: 7 }, NOW).items.map((i) => i.refId).sort()).toEqual(["a", "b"]);
    expect(buildFeed(input, { audience: "designers" }, NOW).items.map((i) => i.refId)).toEqual(["c"]);
    expect(freshnessOf(daysAgo(21), 21, NOW)).toBeCloseTo(0.5, 3);
  });

  it("includes tracked-account observations only with sources", () => {
    const t: TrackedCreator = {
      ...base,
      id: "trk1",
      appId: "app1",
      channel: "youtube",
      handle: "rival",
      kind: "competitor",
      notes: "",
      observations: [
        { text: "Opens every Short with a before/after", kind: "hook", source: src("https://www.youtube.com/@rival"), observedAt: daysAgo(1), confidence: 0.8 },
        { text: "Unsourced", source: { kind: "model_inference", retrievedAt: daysAgo(0) } },
      ],
      comparison: [],
    };
    const feed = buildFeed({ opportunities: [], findings: [], trackers: [t] }, {}, NOW);
    expect(feed.items).toHaveLength(1);
    expect(feed.items[0]).toMatchObject({ type: "tracker_update", provenance: "tracked_account", trackerId: "trk1" });
  });
});

describe("discover.refresh grounding", () => {
  it("keeps only observations whose URL was a search citation, and comparisons tied to verified claims", () => {
    const out = groundObservations(
      {
        found: true,
        observations: [
          { kind: "hook", text: "Hook A", sourceUrl: "https://www.example-competitor.com", confidence: 0.8 },
          { kind: "format", text: "Made up", sourceUrl: "https://not-cited.example.com/", confidence: 0.9 },
        ],
        comparison: [
          { topic: "Offline", them: "Works offline", themSourceUrl: "https://www.example-competitor.com/", usClaimIds: ["clm_ok"] },
          { topic: "Price", them: "Free", themSourceUrl: "https://www.example-competitor.com/", usClaimIds: ["clm_unverified"] },
        ],
      },
      [src("https://www.example-competitor.com/")],
      new Map([["clm_ok", "Works fully offline"]]),
      daysAgo(0),
    );
    expect(out.observations.map((o) => o.text)).toEqual(["Hook A"]);
    expect(out.comparison).toEqual([expect.objectContaining({ topic: "Offline", us: "Works fully offline", usClaimIds: ["clm_ok"] })]);
    expect(out.dropped).toHaveLength(2);
  });

  it("accepts a URL from the call's web search results when the JSON answer carries no citations (live Muse Spark)", () => {
    const out = groundObservations(
      { found: true, observations: [{ kind: "format", text: "Short tutorials", sourceUrl: "https://www.youtube.com/watch?v=--GOwV4Z3UQ", confidence: 0.7 }], comparison: [] },
      [{ ...src("https://www.youtube.com/watch?v=--GOwV4Z3UQ"), kind: "search_result" }],
      new Map(),
      daysAgo(0),
    );
    expect(out.observations).toHaveLength(1);
    expect(out.observations[0]!.source.url).toBe("https://www.youtube.com/watch?v=--GOwV4Z3UQ");
  });
});

describe("OAuth state", () => {
  const key = Buffer.alloc(32, 3);
  const st = { v: 1 as const, w: "ws1", u: "alice", p: "youtube" as const, n: "nonce_nonce_nonce_1234", e: NOW + 60_000 };
  it("round-trips and rejects tampering, wrong keys and expiry", () => {
    const token = signState(key, st);
    expect(verifyState(key, token, NOW)).toEqual(st);
    const [body, sig] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ ...st, w: "ws2" })).toString("base64url");
    expect(() => verifyState(key, `${forged}.${sig}`, NOW)).toThrow(/signature/);
    expect(() => verifyState(Buffer.alloc(32, 4), token, NOW)).toThrow(/signature/);
    expect(() => verifyState(key, `${body}.${sig}.x`, NOW)).toThrow(/Malformed/);
    expect(() => verifyState(key, token, NOW + 120_000)).toThrow(/expired/);
  });
  it("PKCE challenge is S256 of the verifier", () => {
    const { verifier, challenge } = pkcePair();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe("Outreach guardrails", () => {
  const contact = (kind: "email" | "dm" | "contact_form", value: string, source: Partial<SourceRef>) => ({ kind, value, verified: false, source: { kind: "search_result" as const, retrievedAt: daysAgo(0), ...source } });
  it("only keeps publicly listed, sourced contacts; never guessed emails", () => {
    const { contacts, removed } = sanitizeContacts([
      contact("email", "hello@creator.com", { url: "https://creator.com/contact", excerpt: "Business: hello@creator.com" }),
      contact("email", "firstname@creator.com", { url: "https://creator.com/about", excerpt: "I make videos" }), // not on the page → guessed
      contact("email", "x@creator.com", { kind: "model_inference", url: "https://creator.com" }),
      contact("dm", "@creator", { url: undefined }),
      contact("contact_form", "https://creator.com/contact", { url: "https://creator.com/contact" }),
    ]);
    expect(contacts.map((c) => c.value)).toEqual(["hello@creator.com", "https://creator.com/contact"]);
    expect(removed).toBe(3);
    expect(pickContact({ publicContacts: contacts } as never)?.kind).toBe("email");
  });

  it("flags unverified superlatives/figures and prohibited claims; allows the user's own offer figures", () => {
    const claims = [{ id: "clm1", text: "Syncs across iPhone and Mac" }] as Claim[];
    const issues = ruleCheck([{ id: "body", text: "The #1 planner, used by 10k users. Syncs across iPhone and Mac. Get 3 months free. Cures procrastination." }], claims, ["cures procrastination"], ["clm1", "clm_bad"], "3 months free");
    const text = issues.map((i) => i.issue).join(" | ");
    expect(text).toMatch(/clm_bad/);
    expect(text).toMatch(/"#1"/);
    expect(text).toMatch(/10k users/);
    expect(text).toMatch(/prohibited/);
    expect(text).not.toMatch(/3 months/);
    expect(ruleCheck([{ id: "body", text: "It syncs across iPhone and Mac." }], claims, [], ["clm1"])).toEqual([]);
  });
});

describe("Publishing helpers", () => {
  it("X weighted length counts URLs as 23 and CJK as 2", () => {
    expect(xWeightedLength("hi https://example.com/very/long/path")).toBe(3 + 23);
    expect(xWeightedLength("日本")).toBe(4);
  });
  it("zonedToUtc handles offsets", () => {
    expect(zonedToUtc(2026, 10, 27, 9, 0, "Asia/Kolkata").toISOString()).toBe("2026-10-27T03:30:00.000Z");
    expect(zonedToUtc(2026, 7, 1, 0, 1, "America/Los_Angeles").toISOString()).toBe("2026-07-01T07:01:00.000Z");
  });
  it("snapshot hashes are key-order independent", () => {
    expect(hashOf({ a: 1, b: [1, { c: 2, d: undefined }] })).toBe(hashOf({ b: [1, { c: 2 }], a: 1 }));
  });
  it("suggested times are labelled heuristics without own data", async () => {
    const empty = { collection: () => ({ list: async () => ({ items: [], nextCursor: null }) }) } as never;
    const out = await suggestTimes(empty, "app1", { channel: "producthunt", count: 2 }, "Asia/Kolkata", NOW);
    expect(out.basis).toBe("general_heuristic");
    expect(out.items).toHaveLength(2);
    for (const i of out.items) {
      expect(i.basis).toBe("general_heuristic");
      expect(i.reason).toMatch(/not based on research/);
      // Product Hunt launches at 00:01 Pacific
      expect(new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(i.at))).toBe("00:01");
    }
  });
});
