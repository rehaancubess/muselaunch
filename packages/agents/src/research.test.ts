import { createTestPlatform } from "@muselaunch/platform";
import { describe, expect, it } from "vitest";
import { handlers } from "./index";
import { fixtureJson, installFakeMeta, installFakeWeb, searchRoute, seedApp, textRoute, wonderRoute } from "./testing";

type Turns = { turns: { name: string; args: unknown }[][] };

async function setup(budget?: Record<string, number>, turns = fixtureJson<Turns>("wonder-research-turns.json").turns) {
  const p = createTestPlatform({ META_API_KEY: "test-key" }, handlers);
  const wid = "ws_research";
  await p.credits.ensureAccount(wid, { grant: 500, reason: "test" });
  const seed = await seedApp(p, wid);
  const ws = p.db.ws(wid);
  const wonder = wonderRoute(turns);
  const meta = installFakeMeta(p, [wonder, searchRoute(), textRoute("Summarise these research findings", "Sources report that study-with-me timer videos recur on short-form platforms. This may mean Tidy Timer's timer screen is a natural hook.")]);
  installFakeWeb(p, [{ match: "https://calmstudy.example.com/about", contentType: "text/html", body: "<html><head><title>CalmStudy</title></head><body><h1>CalmStudy</h1><p>Daily Pomodoro study-with-me streams. Business inquiries: hello@calmstudy.example.com</p><script>steal()</script></body></html>" }]);
  const rr = await ws.collection("researchRuns").create({ appId: seed.appId, kinds: ["trends", "competitors", "creators", "opportunities"], status: "queued", inputs: { countries: ["US"], languages: ["en"], channels: [], competitorIds: [] } }, { actor: "u1" });
  if (budget) {
    const run = await ws.collection("agentRuns").create({ appId: seed.appId, kind: "research", model: "muse-wonder-1.0", status: "queued", goal: "research", budget: { ...budget } }, { actor: "u1" });
    await ws.collection("researchRuns").update(rr.id, { agentRunId: run.id }, { actor: "u1" });
  }
  const job = await p.jobs.create(wid, "research.run", { appId: seed.appId, researchRunId: rr.id, kinds: rr.kinds }, { actor: "u1", credits: { operation: "research.run" } });
  await p.inline!.drain();
  return { p, wid, ws, seed, rrId: rr.id, jobId: job.id, meta, wonder };
}

describe("research.run (Muse Wonder tool loop + Spark search grounding)", () => {
  it("saves only findings/opportunities/competitors/prospects backed by URLs retrieved in the run", async () => {
    const s = await setup();
    expect((await s.p.jobs.get(s.wid, s.jobId))?.status).toBe("succeeded");
    const rr = await s.ws.collection("researchRuns").getOrThrow(s.rrId);
    expect(rr.status).toBe("succeeded");
    expect(rr.summary).toContain("study-with-me");
    expect(rr.findingCount).toBe(1);

    const findings = (await s.ws.collection("researchFindings").list({ where: [["runId", "==", s.rrId]], orderBy: { field: "createdAt", dir: "desc" } })).items;
    expect(findings).toHaveLength(1); // the "10 million users" finding cited an unretrieved URL → rejected
    expect(findings[0]).toMatchObject({ kind: "format", corroboration: 1, interpretation: expect.stringContaining("timer screen") });
    expect(findings[0]!.evidence[0]).toMatchObject({ kind: "search_result", url: "https://trends.example.com/2026/study-with-me-format" });
    expect(findings[0]!.evidence[0]!.retrievedAt).toMatch(/^\d{4}-/);

    const opps = (await s.ws.collection("opportunities").list({ where: [["appId", "==", s.seed.appId]], orderBy: { field: "createdAt", dir: "desc" } })).items;
    expect(opps).toHaveLength(1);
    expect(opps[0]).toMatchObject({ score: 78, effort: "low", contentType: "short_video", geography: ["US"], findingIds: [findings[0]!.id], status: "new" });

    const comps = (await s.ws.collection("competitors").list({ where: [["appId", "==", s.seed.appId]], orderBy: { field: "createdAt", dir: "desc" } })).items;
    expect(comps).toHaveLength(1);
    expect(comps[0]).toMatchObject({ name: "Forest", origin: "research" });
    expect(comps[0]!.websiteUrl).toBeUndefined(); // forestapp.cc was never retrieved → not stored
    expect(comps[0]!.sources[0]!.url).toBe("https://blog.example.org/focus-apps-compared");

    const prospects = (await s.ws.collection("outreachProspects").list({ where: [["appId", "==", s.seed.appId]], orderBy: { field: "createdAt", dir: "desc" } })).items;
    expect(prospects).toHaveLength(1); // @inventedcreator does not appear in any source → rejected
    expect(prospects[0]).toMatchObject({ handle: "@calmstudy", status: "suggested", url: "https://calmstudy.example.com/about" });
    expect(prospects[0]!.publicContacts.map((c) => c.value)).toEqual(["hello@calmstudy.example.com"]); // guessed ceo@ dropped

    const run = await s.ws.collection("agentRuns").getOrThrow(rr.agentRunId!);
    expect(run).toMatchObject({ kind: "research", status: "succeeded", model: "muse-wonder-1.0" });
    expect(run.plan?.tasks).toHaveLength(2);
    expect(run.usage.searchCalls).toBe(1);
    expect(run.usage.toolCalls).toBe(10);
    expect(run.usage.costUsd).toBeGreaterThan(0);
    const steps = (await s.ws.collection("agentSteps").list({ where: [["runId", "==", run.id]], orderBy: { field: "index", dir: "asc" }, limit: 100 })).items;
    expect(steps.some((x) => x.kind === "tool_call" && x.title === "search_web" && x.citations.length > 0)).toBe(true);
    expect(steps.filter((x) => x.status === "failed").map((x) => x.title)).toEqual(["save_finding failed", "save_creator_prospect failed"]);
    const tools = (await s.ws.collection("toolInvocations").list({ where: [["runId", "==", run.id]], orderBy: { field: "createdAt", dir: "asc" }, limit: 100 })).items;
    expect(tools.map((t) => t.tool)).toContain("fetch_page");

    // Wonder used function tools + previous_response_id; Spark did the grounded search.
    const wonderReqs = s.meta.requests.filter((r) => r.model === "muse-wonder-1.0");
    expect(wonderReqs).toHaveLength(3);
    expect(wonderReqs[1]!.previous_response_id).toMatch(/^resp_fixture_/);
    expect(wonderReqs[1]!.input[0].type).toBe("function_call_output");
    expect(wonderReqs[0]!.tools.map((t: { name: string }) => t.name)).toEqual(expect.arrayContaining(["search_web", "save_finding", "save_creator_prospect", "finish"]));
    const searchReq = s.meta.requests.find((r) => (r.tools ?? []).some((t: { type: string }) => t.type === "web_search"))!;
    expect(searchReq.model).toBe("muse-spark-1.3");
    expect(searchReq.tools[0].user_location).toEqual({ type: "approximate", country: "US" });
    // Every model call metered against the run
    const usage = (await s.ws.collection("modelUsage").list({ where: [["agentRunId", "==", run.id]], orderBy: { field: "createdAt", dir: "desc" }, limit: 50 })).items;
    expect(usage.map((u) => u.model).sort()).toEqual(["muse-spark-1.3", "muse-spark-1.3", "muse-wonder-1.0", "muse-wonder-1.0", "muse-wonder-1.0"]);
  });

  it("stops at the search budget with a budget_stop step instead of crashing (status partial)", async () => {
    const search = (q: string) => ({ name: "search_web", args: { query: q } });
    const s = await setup({ maxSearchCalls: 1 }, [[{ name: "set_plan", args: { goal: "g", tasks: [{ title: "t", role: "research", objective: "o" }] } }, search("study with me trend"), search("second search over budget")]]);
    expect((await s.p.jobs.get(s.wid, s.jobId))?.status).toBe("succeeded");
    const rr = await s.ws.collection("researchRuns").getOrThrow(s.rrId);
    expect(rr.status).toBe("partial");
    expect(rr.summary).toContain("Stopped early: search limit (1)");
    const run = await s.ws.collection("agentRuns").getOrThrow(rr.agentRunId!);
    expect(run.usage.searchCalls).toBe(1);
    const steps = (await s.ws.collection("agentSteps").list({ where: [["runId", "==", run.id]], orderBy: { field: "index", dir: "asc" }, limit: 100 })).items;
    expect(steps.at(-1)).toMatchObject({ kind: "budget_stop", title: "Stopped: search limit (1)" });
    expect(s.wonder.turns).toBe(1); // no further Wonder turn after the budget stop
  });

  it("tenancy: another workspace cannot read the run's outputs", async () => {
    const s = await setup();
    expect((await s.p.db.ws("ws_other").collection("researchFindings").list({ limit: 10 })).items).toHaveLength(0);
    await expect(s.p.db.ws("ws_other").collection("researchRuns").getOrThrow(s.rrId)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
