/**
 * Test harness for the Growth Autopilot (module B tests + integrator E2E): real agents/analytics
 * handlers, fixture-backed Meta, and stand-ins for other modules' heavy work (composition build
 * uses C's real builder; render.final writes a labelled stub MP4; brand.review follows a plan).
 * FIXTURES ONLY — never used by product code.
 */
import { handlers as agentHandlers } from "@muselaunch/agents";
import {
  fixtureJson,
  installFakeMeta,
  jsonRoute,
  requestText,
  resolvePlaceholders,
  responsesBody,
  searchRoute,
  seedApp,
  textRoute,
  toolNames,
  wonderRoute,
  type MetaRoute,
} from "@muselaunch/agents/testing";
import { handlers as analyticsHandlers } from "@muselaunch/analytics";
import { buildFromStoryboard } from "@muselaunch/compositions";
import { createComposition } from "@muselaunch/compositions/store";
import type { BrandFinding, BrandReview } from "@muselaunch/contracts";
import { createTestPlatform, workspaceKey, type JobContext } from "@muselaunch/platform";
import { installAutopilotHooks } from "./hooks";
import { handlers as autopilotHandlers } from "./index";
import { setAutopilotClock } from "./state";

export type ReviewPlan = (review: BrandReview) => { status: BrandReview["status"]; findings: BrandFinding[] } | "fail";

export interface AutopilotHarness {
  p: ReturnType<typeof createTestPlatform>;
  wid: string;
  appId: string;
  screenshotIds: string[];
  clock: { now: number };
  rendered: string[];
  reviews: string[];
}

const DECISIONS = () => fixtureJson<Record<string, unknown>>("wonder-autopilot-decisions.json");

/** Wonder answers each autopilot decision tool (pick_variants is computed from the concepts it is shown). */
export function autopilotDecisionRoute(overrides: Record<string, unknown> = {}): MetaRoute {
  return (req) => {
    if (!String(req.model).startsWith("muse-wonder")) return undefined;
    const names = toolNames(req);
    const tool = ["choose_audience", "set_hypothesis", "pick_variants", "plan_next_iteration"].find((n) => names.includes(n));
    if (!tool) return undefined;
    let args: unknown = overrides[tool] ?? DECISIONS()[tool];
    if (tool === "pick_variants" && !overrides[tool]) {
      const text = requestText(req);
      const want = Number(String(req.instructions ?? "").match(/Pick exactly (\d+)/)?.[1] ?? 2);
      const rows = [...text.matchAll(/- (var_[a-f0-9]+) \| (\w+) \|/g)].map((m) => ({ id: m[1]!, angle: m[2]! }));
      const picks: { variantId: string; experimentKey: string }[] = [];
      for (const r of rows) if (picks.length < want && !picks.some((x) => rows.find((y) => y.id === x.variantId)!.angle === r.angle)) picks.push({ variantId: r.id, experimentKey: `v${picks.length + 1}` });
      args = { picks, rationale: "Different angles test the hypothesis directly." };
    }
    return responsesBody({ model: "muse-wonder-1.0", functionCalls: [{ name: tool, args: resolvePlaceholders(args, req) }] });
  };
}

/** Spark scene-scoped fix: retitle the first text layer of the first requested scene. */
export const fixEditRoute = jsonRoute("CompositionEdit", (req) => {
  const text = requestText(req);
  const sceneId = text.match(/Edit ONLY these scenes: (\S+?)(?:,|\s|$)/)?.[1] ?? text.match(/scene id=(\S+)/)![1]!;
  const block = text.split(`scene id=${sceneId} `)[1]!.split(/\n\s+\d+\. scene id=/)[0]!;
  const layerId = block.match(/layer id=(\S+) text/)![1]!;
  return { summary: "Replaced the flagged headline", targetSceneIds: [sceneId], ops: [{ op: "update_layer", sceneId, layerId, set: { text: "Focus, one calm session at a time" } }] };
});

/** Research turns that restart for every new Wonder conversation (no previous_response_id), so several loops can share one platform. */
function researchRoute(): MetaRoute {
  const turns = fixtureJson<{ turns: { name: string; args: unknown }[][] }>("wonder-research-turns.json").turns;
  let route = wonderRoute(turns, (r) => toolNames(r).includes("save_finding"));
  return (req, index) => {
    if (String(req.model).startsWith("muse-wonder") && toolNames(req).includes("save_finding") && !req.previous_response_id) route = wonderRoute(turns, (r) => toolNames(r).includes("save_finding"));
    return route(req, index);
  };
}

export function standardRoutes(extra: MetaRoute[] = []): MetaRoute[] {
  const recs = fixtureJson<{ interpretation: unknown; proposal: unknown }>("spark-recommendations.json");
  return [
    ...extra,
    autopilotDecisionRoute(),
    researchRoute(),
    searchRoute(),
    textRoute("Summarise these research findings", "Sources report study-with-me timer videos recur on short-form platforms. This may mean the timer screen is a natural hook."),
    jsonRoute("CampaignConcepts", (req) => resolvePlaceholders(fixtureJson("spark-concepts.json"), req)),
    jsonRoute("Storyboard", (req) => resolvePlaceholders(fixtureJson("spark-storyboard-repaired.json"), req)),
    jsonRoute("CopyPacks", (req) => resolvePlaceholders(fixtureJson<{ repaired: unknown }>("spark-copy.json").repaired, req)),
    jsonRoute("ClaimValidation", (req) => ({ results: requestText(req).split("\n").filter((l) => l.startsWith('{"id":')).map((l) => ({ id: JSON.parse(l).id, issues: [] })) })),
    fixEditRoute,
    jsonRoute("GrowthInterpretation", () => recs.interpretation),
    jsonRoute("GrowthRecommendations", () => recs.proposal),
  ];
}

export interface PlatformOptions {
  reviewPlan?: ReviewPlan;
  routes?: MetaRoute[];
  reviewHandler?: boolean;
}

/** Platform with every handler the loop delegates to (real B + F, C's builder, stubs for render/review), hooks and fake Meta. */
export function autopilotPlatform(opts: PlatformOptions = {}): Omit<AutopilotHarness, "wid" | "appId" | "screenshotIds"> {
  const rendered: string[] = [];
  const reviews: string[] = [];
  const reviewPlan: ReviewPlan = opts.reviewPlan ?? (() => ({ status: "passed", findings: [] }));
  const p = createTestPlatform({ META_API_KEY: "test-key" }, {
    ...agentHandlers,
    ...analyticsHandlers,
    ...autopilotHandlers,
    "composition.build": async (ctx: JobContext<"composition.build">) => {
      const sb = await ctx.ws.collection("storyboards").getOrThrow(ctx.payload.storyboardId);
      if (await ctx.ws.collection("compositions").get(ctx.payload.compositionId)) return { creditsUsed: 2 };
      const app = await ctx.ws.collection("apps").getOrThrow(sb.appId);
      const brand = await ctx.ws.collection("brandProfiles").get(sb.appId);
      const assets = (await ctx.ws.collection("mediaAssets").list({ where: [["appId", "==", sb.appId]], orderBy: { field: "createdAt", dir: "desc" }, limit: 100 })).items;
      const doc = buildFromStoryboard({ storyboard: sb, app, brand, assets });
      await createComposition(ctx.ws, { id: ctx.payload.compositionId, appId: sb.appId, campaignId: sb.campaignId, variantId: sb.variantId, storyboardId: sb.id, title: sb.title, doc }, ctx.actor);
      return { refs: [{ entity: "compositions", id: ctx.payload.compositionId }], creditsUsed: 2 };
    },
    "render.preview": async () => ({ creditsUsed: 0 }),
    // Stand-in for module C's renderer: a labelled stub file, never shown as a real render.
    "render.final": async (ctx: JobContext<"render.final">) => {
      const comp = await ctx.ws.collection("compositions").getOrThrow(ctx.payload.compositionId);
      const id = `ast_render_${ctx.payload.compositionId.slice(-12)}_v${ctx.payload.version}`;
      const key = workspaceKey(ctx.workspaceId, "renders", `${id}.mp4`);
      const put = await ctx.platform.storage.put(key, "FIXTURE: stub render (test only)", { contentType: "video/mp4" });
      await ctx.ws.collection("mediaAssets").createIfAbsent(
        { id, appId: comp.appId, campaignId: comp.campaignId, kind: "video", role: "render", origin: "render", storagePath: key, mimeType: "video/mp4", bytes: put.bytes, status: "ready", width: 1080, height: 1920, durationSec: 15, render: { compositionId: comp.id, version: ctx.payload.version, quality: "final" } },
        { actor: ctx.actor },
      );
      rendered.push(comp.id);
      return { refs: [{ entity: "mediaAssets", id }], creditsUsed: 8 };
    },
    ...(opts.reviewHandler === false
      ? {}
      : {
          // Stand-in for module G's Brand Guardian (follows a scripted plan).
          "brand.review": async (ctx: JobContext<"brand.review">) => {
            const review = await ctx.ws.collection("brandReviews").getOrThrow(ctx.payload.reviewId);
            const plan = reviewPlan(review);
            reviews.push(`${review.subject.id}@v${review.subjectVersion}:${plan === "fail" ? "fail" : plan.status}`);
            if (plan === "fail") {
              await ctx.ws.collection("brandReviews").update(review.id, { status: "failed", error: "Guardian offline (test)" }, { actor: ctx.actor });
              return { creditsUsed: 0 };
            }
            await ctx.ws.collection("brandReviews").update(review.id, { status: plan.status, findings: plan.findings, summary: `${plan.findings.length} finding(s)`, checkedAt: new Date().toISOString() }, { actor: ctx.actor });
            return { refs: [{ entity: "brandReviews", id: review.id }], creditsUsed: 1 };
          },
        }),
  });
  installAutopilotHooks(p);
  const clock = { now: Date.now() };
  setAutopilotClock(p, () => clock.now);
  installFakeMeta(p, standardRoutes(opts.routes));
  return { p, clock, rendered, reviews };
}

/** Platform + a workspace with a seeded app (App DNA, claims, real screenshot files). */
export async function autopilotHarness(opts: PlatformOptions & { workspaceId?: string } = {}): Promise<AutopilotHarness> {
  const base = autopilotPlatform(opts);
  const { p } = base;
  const wid = opts.workspaceId ?? "ws_autopilot";
  const now = new Date().toISOString();
  await p.db.top("workspaces").set(wid, {
    id: wid,
    workspaceId: wid,
    name: "Autopilot test",
    slug: `autopilot-${wid}`,
    ownerId: "u1",
    planId: "free",
    spendCeilingUsd: 25,
    settings: { defaultTimezone: "UTC", defaultLocale: "en", metaDataMode: "standard" },
    createdAt: now,
    updatedAt: now,
    createdBy: "u1",
  });
  await p.credits.ensureAccount(wid, { grant: 2000, reason: "test" });
  const seed = await seedApp(p, wid);
  return { ...base, wid, appId: seed.appId, screenshotIds: seed.screenshotIds };
}
