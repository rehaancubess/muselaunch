import { createTestPlatform } from "@muselaunch/platform";
import { describe, expect, it } from "vitest";
import { handlers } from "./index";
import { fixtureJson, installFakeMeta, installFakeWeb, type MetaRoute, searchRoute, seedApp, textRoute, wonderRoute } from "./testing";

type Turns = { turns: { name: string; args: unknown }[][] };

async function setup(budget?: Record<string, number>, turns = fixtureJson<Turns>("wonder-research-turns.json").turns, search: MetaRoute = searchRoute(), first?: MetaRoute) {
  const p = createTestPlatform({ META_API_KEY: "test-key" }, handlers);
  const wid = "ws_research";
  await p.credits.ensureAccount(wid, { grant: 500, reason: "test" });
  const seed = await seedApp(p, wid);
  const ws = p.db.ws(wid);
  const wonder = wonderRoute(turns);
  const meta = installFakeMeta(p, [...(first ? [first] : []), wonder, search, textRoute("Summarise these research findings", "Sources report that study-with-me timer videos recur on short-form platforms. This may mean Tidy Timer's timer screen is a natural hook.")]);
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

  it("at the search budget, gets one wrap-up turn to save what it found, then stops with a budget_stop step (status partial)", async () => {
    const search = (q: string) => ({ name: "search_web", args: { query: q } });
    const finding = { kind: "format", statement: "Study-with-me videos with an on-screen timer are a recurring short-form format.", sourceUrls: ["https://trends.example.com/2026/study-with-me-format"], confidence: 0.8 };
    const s = await setup({ maxSearchCalls: 1 }, [
      [{ name: "set_plan", args: { goal: "g", tasks: [{ title: "t", role: "research", objective: "o" }] } }, search("study with me trend"), search("second search over budget")],
      [search("third search, still over budget"), { name: "save_finding", args: finding }],
    ]);
    expect((await s.p.jobs.get(s.wid, s.jobId))?.status).toBe("succeeded");
    const rr = await s.ws.collection("researchRuns").getOrThrow(s.rrId);
    expect(rr.status).toBe("partial");
    expect(rr.summary).toContain("Stopped early: search limit (1)");
    expect(rr.findingCount).toBe(1); // saved in the wrap-up turn from the first search's results
    const run = await s.ws.collection("agentRuns").getOrThrow(rr.agentRunId!);
    expect(run.usage.searchCalls).toBe(1);
    const steps = (await s.ws.collection("agentSteps").list({ where: [["runId", "==", run.id]], orderBy: { field: "index", dir: "asc" }, limit: 100 })).items;
    expect(steps.filter((x) => x.kind === "budget_stop").map((x) => x.title)).toEqual(["Stopped: search limit (1)"]);
    expect(steps.at(-1)).toMatchObject({ kind: "model_call", title: "Summarise findings (Muse Spark)" });
    expect(s.wonder.turns).toBe(2); // exactly one wrap-up turn after the budget hit
    const wrapUp = s.meta.requests.filter((r) => r.model === "muse-wonder-1.0")[1]!;
    expect(JSON.stringify(wrapUp.input)).toContain("No more searches");
  });

  it("counts one search per search_web call, however many web searches Spark runs inside it", async () => {
    // Live Muse Spark ran 5–10 web searches inside one grounded call.
    const base = searchRoute();
    const multi: MetaRoute = (req, i) => {
      const body = base(req, i) as { output: unknown[] } | undefined;
      if (body) body.output.unshift(...Array.from({ length: 8 }, (_, n) => ({ type: "web_search_call", id: `ws_extra_${n}`, status: "completed" })));
      return body;
    };
    const s = await setup(undefined, undefined, multi);
    expect((await s.ws.collection("researchRuns").getOrThrow(s.rrId)).status).toBe("succeeded");
    const run = await s.ws.collection("agentRuns").getOrThrow((await s.ws.collection("researchRuns").getOrThrow(s.rrId)).agentRunId!);
    expect(run.usage.searchCalls).toBe(1);
  });

  it("when Meta has dropped the stored response, resends the full conversation and carries on", async () => {
    // Live 30 Oct: "400 referenced response not found or expired" in the fourth turn of a research loop.
    let refused = 0;
    const expired: MetaRoute = (req) => {
      if (String(req.model).startsWith("muse-wonder") && req.previous_response_id && refused === 0) {
        refused++;
        return new Response(JSON.stringify({ error: { message: "referenced response not found or expired", type: "invalid_request_error" } }), { status: 400, headers: { "content-type": "application/json" } });
      }
      return undefined;
    };
    const s = await setup(undefined, undefined, undefined, expired);
    expect(refused).toBe(1);
    const rr = await s.ws.collection("researchRuns").getOrThrow(s.rrId);
    expect(rr.status).toBe("succeeded");
    expect(rr.findingCount).toBe(1);
    const wonderReqs = s.meta.requests.filter((r) => r.model === "muse-wonder-1.0");
    // turn 1, refused turn 2, resent turn 2 (full history, no previous_response_id), turn 3 also in full
    expect(wonderReqs).toHaveLength(4);
    expect(wonderReqs[2]!.previous_response_id).toBeUndefined();
    expect(wonderReqs[2]!.input[0].role).toBe("user");
    expect(wonderReqs[2]!.input.some((x: { type?: string }) => x.type === "function_call")).toBe(true);
    expect(wonderReqs[2]!.input.some((x: { type?: string }) => x.type === "function_call_output")).toBe(true);
    expect(wonderReqs[3]!.previous_response_id).toBeUndefined();
    expect(wonderReqs[3]!.input.length).toBeGreaterThan(wonderReqs[2]!.input.length);
    const steps = (await s.ws.collection("agentSteps").list({ where: [["runId", "==", rr.agentRunId!]], orderBy: { field: "index", dir: "asc" }, limit: 100 })).items;
    expect(steps.some((x) => x.title === "Conversation resent in full")).toBe(true);
  });

  it("tenancy: another workspace cannot read the run's outputs", async () => {
    const s = await setup();
    expect((await s.p.db.ws("ws_other").collection("researchFindings").list({ limit: 10 })).items).toHaveLength(0);
    await expect(s.p.db.ws("ws_other").collection("researchRuns").getOrThrow(s.rrId)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
