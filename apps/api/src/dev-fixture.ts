/**
 * FIXTURE MODE API — local demos and the Playwright journey only. NEVER deploy this entrypoint.
 *
 * Runs the real API, job runner and every module's handlers (memory DB, local storage, inline jobs,
 * dev auth), but answers Meta / Glimmer / public-web calls from LABELLED fixtures under `fixtures/`
 * (documented response shapes with synthetic content). Rendering is real (HyperFrames + FFmpeg) when
 * RENDER_CHROME_PATH points at a chrome-headless-shell.
 *
 * `GET /health` reports `fixtureMode: true`; the web app shows a persistent "Fixture mode" banner and
 * labels providers as fixtures, so nothing here can be mistaken for live AI output.
 *
 *   pnpm dev:fixture            (API on :8080)
 *   Sample listing that imports: https://apps.apple.com/us/app/tidy-timer-focus-pomodoro/id1234567890
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

if (process.env.NODE_ENV === "production" || process.env.APP_ENV === "production") {
  console.error("Refusing to start: fixture mode is for local development only.");
  process.exit(1);
}

const defaults: Record<string, string> = {
  NODE_ENV: "development",
  APP_ENV: "local",
  DB_DRIVER: "memory",
  JOB_DISPATCH: "inline",
  AUTH_MODE: "dev",
  AUTH_DEV_TOKENS: "1",
  STORAGE_DRIVER: "local",
  LOCAL_STORAGE_DIR: ".data/fixture-storage",
  STORAGE_SIGNING_SECRET: "fixture-mode-local-signing-secret-not-for-production",
  PUBLIC_WEB_URL: "http://localhost:3000",
  API_PUBLIC_URL: "http://localhost:8080",
  META_API_KEY: "fixture-mode-no-real-key",
  GLIMMER_BASE_URL: "http://glimmer.fixture.local/v1",
  GLIMMER_LABEL: "Fixture (no model running)",
  SIGNUP_CREDITS: "2000",
  LOG_LEVEL: "warn",
  OPERATOR_COUNTRY: "IN",
};
for (const [k, v] of Object.entries(defaults)) if (!process.env[k]) process.env[k] = v;
process.env.MUSELAUNCH_FIXTURE_MODE = "1";

const { serve } = await import("@hono/node-server");
const { Hono } = await import("hono");
const { createPlatform, createRunner } = await import("@muselaunch/platform");
const { installMetaClient, MetaClient } = await import("@muselaunch/providers");
const agentsT = await import("@muselaunch/agents/testing");
const mediaT = await import("@muselaunch/media/testing");
const { installAnalyticsHooks } = await import("@muselaunch/analytics");
const { handlers } = await import("@muselaunch/worker/registry");
const { buildApp } = await import("./app");

const p = createPlatform();
installAnalyticsHooks(p);
createRunner(p, handlers, "fixture-inline");

// ---------------------------------------------------------------- fake public web (sample listing)
const RENDER_FX = fileURLToPath(new URL("../../../fixtures/render/", import.meta.url));
const today = readFileSync(`${RENDER_FX}screenshot-today.png`);
const stats = readFileSync(`${RENDER_FX}screenshot-stats.png`);
const icon = readFileSync(`${RENDER_FX}app-icon.png`);
agentsT.installFakeWeb(p, [
  { match: /^https:\/\/itunes\.apple\.com\/lookup\?id=1234567890/, contentType: "text/javascript", body: agentsT.fixture("itunes-lookup.json") },
  { match: /mzstatic\.com\/image\/thumb\/fixture\/icon/, contentType: "image/png", body: icon },
  { match: /mzstatic\.com\/image\/thumb\/fixture\/shot1/, contentType: "image/png", body: today },
  { match: /mzstatic\.com\/image\/thumb\/fixture\/shot2/, contentType: "image/png", body: stats },
  { match: /mzstatic\.com\/image\/thumb\/fixture\/shot3/, contentType: "image/png", body: today },
  { match: "https://calmstudy.example.com/about", contentType: "text/html", body: "<html><body><h1>CalmStudy</h1><p>Daily study-with-me Pomodoro streams. Business inquiries: hello@calmstudy.example.com</p></body></html>" },
]);

// ---------------------------------------------------------------- fake Meta (text + SAM + voice)
type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const { responsesBody, jsonRoute, resolvePlaceholders, fixtureJson, requestText, searchRoute, textRoute, toolNames, schemaName } = agentsT;
const growthFx = JSON.parse(readFileSync(fileURLToPath(new URL("../../../fixtures/growth/meta-responses.json", import.meta.url)), "utf8")) as J;
/** Scripted Wonder tool loop that restarts at turn 0 for every new loop (no previous_response_id). */
function loopRoute(turns: { name: string; args: unknown }[][], match: (req: J) => boolean) {
  let n = 0;
  return (req: J) => {
    if (!String(req.model).startsWith("muse-wonder") || !match(req)) return undefined;
    if (!req.previous_response_id) n = 0;
    const turn = turns[Math.min(n, turns.length - 1)]!;
    n += 1;
    return responsesBody({ model: "muse-wonder-1.0", functionCalls: turn.map((c) => ({ name: c.name, args: resolvePlaceholders(c.args, req) })) });
  };
}
const idsIn = (text: string, prefix: string) => [...new Set([...text.matchAll(new RegExp(`\\b${prefix}_[A-Za-z0-9_-]+`, "g"))].map((m) => m[0]))];

const textRoutes = [
  jsonRoute("AppDna", (req) => resolvePlaceholders(fixtureJson("spark-app-dna.json"), req)),
  jsonRoute("CampaignConcepts", (req) => resolvePlaceholders(fixtureJson("spark-concepts.json"), req)),
  jsonRoute("Storyboard", (req) => resolvePlaceholders(fixtureJson("spark-storyboard-repaired.json"), req)),
  jsonRoute("CopyPacks", (req) => resolvePlaceholders(fixtureJson<{ repaired: unknown }>("spark-copy.json").repaired, req)),
  jsonRoute("ClaimValidation", (req) => ({ results: requestText(req).split("\n").filter((l) => l.startsWith('{"id":')).map((l) => ({ id: JSON.parse(l).id, issues: [] })) })),
  // Scene-scoped edit: retitle the first text layer of the first requested scene.
  jsonRoute("CompositionEdit", (req) => {
    const text = requestText(req);
    const sceneId = text.match(/Edit ONLY these scenes: (\S+)/)?.[1] ?? text.match(/scene id=(\S+)/)?.[1];
    const block = sceneId ? (text.split(`scene id=${sceneId} `)[1] ?? "").split(/\n\s+\d+\. scene id=/)[0]! : "";
    const layerId = block.match(/layer id=(\S+) text/)?.[1];
    if (!sceneId || !layerId) return { summary: "No text layer to change in that scene", targetSceneIds: sceneId ? [sceneId] : [], ops: [] };
    return { summary: "Sharper, question-led opening line", targetSceneIds: [sceneId], ops: [{ op: "update_layer", sceneId, layerId, set: { text: "Where did your focus go today?" } }] };
  }),
  loopRoute(fixtureJson<{ turns: { name: string; args: unknown }[][] }>("wonder-strategy-turns.json").turns, (r) => toolNames(r).includes("set_strategy")),
  loopRoute(fixtureJson<{ turns: { name: string; args: unknown }[][] }>("wonder-research-turns.json").turns, (r) => toolNames(r).includes("save_finding")),
  searchRoute(),
  textRoute("Summarise these research findings", "Sources report study-with-me timer videos recur on short-form platforms. This may mean the timer screen is a natural hook."),
  // Module E
  (req: J) => {
    const name = schemaName(req);
    if (name !== "TrackerResearch" && name !== "OutreachPitch") return undefined;
    const claimIds = idsIn(requestText(req), "clm");
    const data =
      name === "TrackerResearch"
        ? {
            found: true,
            displayName: "CalmStudy",
            observations: [
              { kind: "positioning", text: "Positions daily study-with-me streams as a calm way to stay accountable", sourceUrl: "https://www.example-competitor.com/", confidence: 0.8 },
              { kind: "hook", text: "Shorts open on a ticking timer with a quiet desk", sourceUrl: "https://www.youtube.com/@examplecompetitor/shorts", confidence: 0.7 },
            ],
            comparison: claimIds.length ? [{ topic: "Focus sessions", them: "Streams fixed 25-minute sessions", themSourceUrl: "https://www.example-competitor.com/", usClaimIds: claimIds.slice(0, 1) }] : [],
          }
        : {
            subject: "Your study-with-me sessions + a calm timer idea",
            body: "Hi! Your study-with-me sessions are some of the calmest on the platform. I build Tidy Timer, a Pomodoro timer for iPhone with custom session lengths. Would you like to try it in a session? Happy to set you up with full access, no strings attached. Thanks, the Tidy Labs team",
            offer: "A free year of Tidy Timer Pro",
            claimIdsUsed: claimIds.slice(0, 1),
            formatReference: "study-with-me sessions",
          };
    const template = name === "TrackerResearch" ? growthFx.trackerResearch : growthFx.outreachPitch;
    return JSON.parse(JSON.stringify(template).replace('"__JSON__"', JSON.stringify(JSON.stringify(data))));
  },
  // Module F (no measured claims are invented; only hypotheses about the provided data)
  jsonRoute("ExperimentAnalysis", () => ({
    summary: "Fixture analysis: the variants have too little attributed data to separate them yet.",
    measured: [],
    hypotheses: ["The question-led hook may hold attention longer; more tracked clicks are needed to tell."],
    limitations: ["Small sample", "Clicks are attributed through tracked links only"],
    confidence: "insufficient_data",
  })),
  jsonRoute("GrowthInterpretation", () => ({
    insights: [{ text: "Fixture interpretation: imported results are too sparse to compare channels.", basis: "hypothesis", observationIds: [], resultIds: [] }],
    dataGaps: ["No install attribution per post", "Fewer than 14 days of data"],
  })),
  jsonRoute("GrowthRecommendations", () => ({
    recommendations: [
      {
        title: "Test a question-led hook against the current opener",
        rationale: "Fixture recommendation: run a two-variant test with tracked links so the result is measurable.",
        kind: "next_experiment",
        observationIds: [],
        resultIds: [],
        preferenceIds: [],
        proposedExperiment: { title: "Question hook vs statement hook", hypothesis: "A question-led first line earns more link clicks", primaryMetric: "clicks", variants: ["Question hook", "Statement hook"] },
        confidence: "low",
      },
    ],
  })),
];

const samFx = mediaT.loadFixture<{ rawOutput: string }>("sam-video-moving-box.json");
const samImageFx = mediaT.loadFixture<{ rawOutput: string }>("sam-image-box.json");
const voiceFx = mediaT.loadFixture<{ response: unknown }>("voice-transcribe-documented.json").response;
const media = mediaT.fakeMetaFetch({
  samOutput: (body) => (JSON.stringify(body).includes('"input_image"') ? samImageFx.rawOutput : samFx.rawOutput),
  transcribe: () => voiceFx,
});

const metaFetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const path = new URL(url).pathname;
  if (path.endsWith("/responses") && typeof init.body === "string") {
    const req = JSON.parse(init.body) as J;
    if (String(req.model ?? "").startsWith("sam")) return media.fetch(input, init);
    for (const r of textRoutes) {
      const body = r(req, 0);
      if (body !== undefined) return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ error: { message: `fixture mode: no fixture for ${schemaName(req) ?? "this request"}`, type: "invalid_request_error" } }), { status: 400, headers: { "content-type": "application/json" } });
  }
  return media.fetch(input, init);
}) as typeof fetch;
installMetaClient(p, new MetaClient(p, { fetch: metaFetch, apiKey: "fixture-mode-no-real-key" }));

// ---------------------------------------------------------------- fake Glimmer (memory ranking)
agentsT.installFakeGlimmer(p, (messages) => {
  const text = messages.map((m) => m.content).join("\n");
  const prefs = [...text.matchAll(/"id":"(prf_[A-Za-z0-9_-]+)"[^}]*?"text":"([^"]+)"/g)].slice(0, 3);
  return JSON.stringify({ selectedIds: prefs.map((m) => m[1]), summary: prefs.map((m) => `- ${m[2]}`).join("\n") || "- No saved preferences apply." });
});

// ---------------------------------------------------------------- serve (health advertises fixture mode)
const inner = buildApp(p);
const outer = new Hono();
outer.get("/health", async (c) => {
  const res = await inner.fetch(c.req.raw);
  const body = { ...((await res.json()) as object), fixtureMode: true, sampleListing: "https://apps.apple.com/us/app/tidy-timer-focus-pomodoro/id1234567890" };
  const headers = new Headers(res.headers);
  headers.delete("content-length");
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(body), { status: res.status, headers });
});
outer.all("*", (c) => inner.fetch(c.req.raw));

const port = Number(process.env.PORT ?? p.cfg.API_PORT);
serve({ fetch: outer.fetch, port }, () => {
  console.log(`\n  MuseLaunch API in FIXTURE MODE on :${port} (labelled fixtures, not live AI)\n  Render: ${process.env.RENDER_CHROME_PATH ? "real HyperFrames via " + process.env.RENDER_CHROME_PATH : "set RENDER_CHROME_PATH to render videos"}\n`);
});
