/**
 * Test harness for module B (and integrator E2E tests): fake Meta Responses API and fake public
 * web serving documented-shape FIXTURES from `fixtures/agents/`. Never used by product code.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Platform, SafeFetchOptions } from "@muselaunch/platform";
import { GlimmerClient, installGlimmerClient, installMetaClient, installSparkOpenClient, MetaClient, SparkOpenClient } from "@muselaunch/providers";
import sharp from "sharp";
import { fetchResult, installFetcher } from "./fetcher";

export const FIXTURES_DIR = fileURLToPath(new URL("../../../fixtures/agents/", import.meta.url));

export function fixture(name: string): string {
  return readFileSync(`${FIXTURES_DIR}${name}`, "utf8");
}

export function fixtureJson<T = Record<string, unknown>>(name: string): T {
  const data = JSON.parse(fixture(name)) as Record<string, unknown>;
  delete data._fixture;
  return data as T;
}

// ---------------------------------------------------------------------------
// Fake Meta Responses API
// ---------------------------------------------------------------------------

// biome-ignore lint: test helper uses loose request typing
export type MetaRequest = Record<string, any>;
export type MetaRoute = (req: MetaRequest, index: number) => unknown;

let respSeq = 0;

/** Documented Responses API response object. */
export function responsesBody(opts: {
  text?: string;
  functionCalls?: { name: string; args: unknown; callId?: string }[];
  citations?: { url: string; title?: string }[];
  searchResults?: { url: string; title?: string; snippet?: string }[];
  model?: string;
  usage?: { input_tokens: number; output_tokens: number; cached?: number };
}): Record<string, unknown> {
  const output: Record<string, unknown>[] = [];
  if (opts.searchResults || opts.citations) {
    output.push({ type: "web_search_call", id: `ws_${++respSeq}`, status: "completed", ...(opts.searchResults ? { results: opts.searchResults.map((r) => ({ type: "text_result", ...r })) } : {}) });
  }
  for (const fc of opts.functionCalls ?? []) {
    output.push({ type: "function_call", id: `fc_${++respSeq}`, call_id: fc.callId ?? `call_${++respSeq}`, name: fc.name, arguments: JSON.stringify(fc.args), status: "completed" });
  }
  if (opts.text !== undefined) {
    const text = opts.text;
    output.push({
      type: "message",
      role: "assistant",
      status: "completed",
      content: [
        {
          type: "output_text",
          text,
          annotations: (opts.citations ?? []).map((c, i) => ({ type: "url_citation", url: c.url, title: c.title ?? c.url, start_index: 0, end_index: Math.min(text.length, 40 + i) })),
        },
      ],
    });
  }
  return {
    id: `resp_fixture_${++respSeq}`,
    object: "response",
    created_at: 1792000000,
    status: "completed",
    model: opts.model ?? "muse-spark-1.3",
    output,
    usage: {
      input_tokens: opts.usage?.input_tokens ?? 1500,
      output_tokens: opts.usage?.output_tokens ?? 400,
      total_tokens: (opts.usage?.input_tokens ?? 1500) + (opts.usage?.output_tokens ?? 400),
      input_tokens_details: { cached_tokens: opts.usage?.cached ?? 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
  };
}

/** All text the model was sent in a request (input_text parts + function_call_output payloads). */
export function requestText(req: MetaRequest): string {
  const parts: string[] = [];
  for (const item of (req.input ?? []) as MetaRequest[]) {
    if (item.type === "function_call_output") parts.push(String(item.output));
    for (const c of (item.content ?? []) as MetaRequest[]) if (c.type === "input_text") parts.push(String(c.text));
  }
  return parts.join("\n");
}

export const schemaName = (req: MetaRequest): string | undefined => req.text?.format?.name;
export const toolNames = (req: MetaRequest): string[] => ((req.tools ?? []) as MetaRequest[]).filter((t) => t.type === "function").map((t) => String(t.name));

/**
 * Install a fake Meta client: routes are tried in order; the first non-undefined result is the response
 * body. A route may return a `Response` to simulate an HTTP error (e.g. a documented 429).
 */
export function installFakeMeta(p: Platform, routes: MetaRoute[]): { requests: MetaRequest[] } {
  const requests: MetaRequest[] = [];
  const f = (async (_url: string, init: RequestInit) => {
    const req = JSON.parse(String(init.body)) as MetaRequest;
    requests.push(req);
    for (const r of routes) {
      const body = r(req, requests.length - 1);
      if (body instanceof Response) return body;
      if (body !== undefined) return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ error: { message: `no fake route for ${schemaName(req) ?? toolNames(req).join(",") ?? "request"}`, type: "invalid_request_error" } }), { status: 400, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  installMetaClient(p, new MetaClient(p, { fetch: f, apiKey: "test-key" }));
  return { requests };
}

/** Route that answers structured-output calls for `name` with JSON built from the request. */
export function jsonRoute(name: string, build: (req: MetaRequest) => unknown): MetaRoute {
  return (req) => (schemaName(req) === name ? responsesBody({ text: JSON.stringify(build(req)) }) : undefined);
}

/**
 * Resolve fixture placeholders against ids that really appear in the request:
 * `$EV:<text>` evidence id whose fact contains text; `$IMAGE<n>` n-th attached image asset;
 * `$ID:<prefix>:<n>` n-th distinct id with that prefix in the request text.
 */
export function resolvePlaceholders<T>(template: T, req: MetaRequest): T {
  const text = requestText(req);
  const evidence = [...text.matchAll(/(evd_[a-f0-9]{24}) \| [^|\n]+ \| [^|\n]+ \| ([^\n]*)/g)].map((m) => ({ id: m[1]!, fact: m[2]! }));
  const images = [...text.matchAll(/Image \d+: asset (\S+)/g)].map((m) => m[1]!);
  const idsByPrefix = (prefix: string) => [...new Set([...text.matchAll(new RegExp(`\\b${prefix}_[A-Za-z0-9_-]+`, "g"))].map((m) => m[0]))];
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      if (v.startsWith("$EV:")) return evidence.find((e) => e.fact.includes(v.slice(4)))?.id ?? "evd_missing_in_request";
      const img = v.match(/^\$IMAGE(\d+)$/);
      if (img) return images[Number(img[1])] ?? "ast_missing_in_request";
      const id = v.match(/^\$ID:([a-z]+):(\d+)$/);
      if (id) return idsByPrefix(id[1]!)[Number(id[2])] ?? `${id[1]}_missing_in_request`;
      return v;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(template) as T;
}

// ---------------------------------------------------------------------------
// Fake Muse Spark Open (Baseten Chat Completions)
// ---------------------------------------------------------------------------

type ChatContentPart = { type: string; text?: string; image_url?: { url?: string } };

/**
 * A Spark Open Chat Completions request seen as the Responses-shaped request the fake-Meta routes
 * understand (instructions, input_text parts, `text.format.name` from the prompted `<json_schema name>`),
 * so the SAME fixture builders answer both engines.
 */
export function chatAsResponsesRequest(req: MetaRequest): MetaRequest {
  const messages = (req.messages ?? []) as { role: string; content: string | ChatContentPart[] }[];
  const textOf = (c: string | ChatContentPart[]) => (typeof c === "string" ? c : c.map((x) => x.text ?? "").join("\n"));
  const system = messages.filter((m) => m.role === "system").map((m) => textOf(m.content)).join("\n");
  const name = system.match(/<json_schema name="([^"]+)">/)?.[1];
  const user = messages
    .filter((m) => m.role === "user")
    .flatMap((m) => (typeof m.content === "string" ? [{ type: "input_text", text: m.content }] : m.content.map((x) => (x.type === "text" ? { type: "input_text", text: x.text ?? "" } : { type: "input_image", image_url: x.image_url?.url }))));
  return { model: req.model, instructions: system.replace(/\n\nOutput format: reply with ONLY[\s\S]*?<\/json_schema>/, ""), input: [{ role: "user", content: user }], ...(name ? { text: { format: { type: "json_schema", name } } } : {}) };
}

/** Answer text of a Responses body built by a fake-Meta route. */
function responsesAnswer(body: MetaRequest): string {
  return ((body.output ?? []) as MetaRequest[])
    .filter((o) => o.type === "message")
    .flatMap((o) => (o.content ?? []) as MetaRequest[])
    .map((c) => String(c.text ?? ""))
    .join("");
}

/**
 * Install a fake Muse Spark Open client. Routes are fake-Meta routes (jsonRoute, textRoute, …) applied to
 * `chatAsResponsesRequest(req)`; a route may return a `Response` to simulate a Baseten HTTP error. Replies
 * use the documented Chat Completions shape (reasoning_content apart from content; SSE when streaming)
 * and are labelled fixtures, not live output.
 */
export function installFakeSparkOpen(p: Platform, routes: MetaRoute[]): { requests: MetaRequest[] } {
  const requests: MetaRequest[] = [];
  const f = (async (_url: string, init: RequestInit) => {
    const req = JSON.parse(String(init.body)) as MetaRequest;
    requests.push(req);
    const asResponses = chatAsResponsesRequest(req);
    for (const r of routes) {
      const body = r(asResponses, requests.length - 1);
      if (body instanceof Response) return body;
      if (body === undefined) continue;
      return sparkOpenReply(responsesAnswer(body as MetaRequest), String(req.model), Boolean(req.stream));
    }
    return new Response(JSON.stringify({ error: `fixture mode: no Muse Spark Open fixture for ${schemaName(asResponses) ?? "this request"}` }), { status: 400, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  installSparkOpenClient(p, new SparkOpenClient(p, { fetch: f, apiKey: p.cfg.BASETEN_API_KEY || "test-baseten-key", sleep: async () => {} }));
  return { requests };
}

/** Documented Chat Completions reply (fixture): private reasoning in `reasoning_content`, answer in `content`. */
export function sparkOpenReply(content: string, model = "meta-models/muse-spark-open-1026", stream = false): Response {
  const id = `chatcmpl_fixture_${++respSeq}`;
  const reasoning = "Fixture: private reasoning placeholder (not live output).";
  const usage = { prompt_tokens: 1500, completion_tokens: 500, total_tokens: 2000, prompt_tokens_details: { cached_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 120 } };
  if (!stream) {
    return new Response(JSON.stringify({ id, object: "chat.completion", created: 1792000000, model, choices: [{ index: 0, message: { role: "assistant", reasoning_content: reasoning, content }, finish_reason: "stop" }], usage }), { status: 200, headers: { "content-type": "application/json" } });
  }
  const chunks = [
    { id, object: "chat.completion.chunk", model, choices: [{ index: 0, delta: { role: "assistant", reasoning_content: reasoning } }] },
    { id, object: "chat.completion.chunk", model, choices: [{ index: 0, delta: { content }, finish_reason: "stop" }] },
    { id, object: "chat.completion.chunk", model, choices: [], usage },
  ];
  return new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
}

// ---------------------------------------------------------------------------
// Fake public web (safeFetch replacement)
// ---------------------------------------------------------------------------

export type WebRoute = { match: string | RegExp; status?: number; contentType: string; body: string | Buffer | ((url: string) => string | Buffer | Promise<string | Buffer>) };

export function installFakeWeb(p: Platform, routes: WebRoute[]): { fetched: string[] } {
  const fetched: string[] = [];
  installFetcher(p, async (url: string, _opts?: SafeFetchOptions) => {
    fetched.push(url);
    const r = routes.find((x) => (typeof x.match === "string" ? url === x.match || url.startsWith(x.match) : x.match.test(url)));
    if (!r) return fetchResult(url, "not found", "text/plain", 404);
    const body = typeof r.body === "function" ? await r.body(url) : r.body;
    return fetchResult(url, body, r.contentType, r.status ?? 200);
  });
  return { fetched };
}

/** Solid-colour PNG with a contrasting bar (stands in for a screenshot/icon in tests). */
export async function png(rgb: [number, number, number], size: [number, number] = [90, 160], bar: [number, number, number] = [20, 20, 20]): Promise<Buffer> {
  const [w, h] = size;
  const barImg = await sharp({ create: { width: w, height: Math.max(4, Math.round(h / 8)), channels: 3, background: { r: bar[0], g: bar[1], b: bar[2] } } }).png().toBuffer();
  return sharp({ create: { width: w, height: h, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } } })
    .composite([{ input: barImg, top: Math.round(h / 3), left: 0 }])
    .png()
    .toBuffer();
}

// ---------------------------------------------------------------------------
// Fake Glimmer (llama.cpp-style SSE)
// ---------------------------------------------------------------------------

export function installFakeGlimmer(p: Platform, reply: (messages: { role: string; content: string }[]) => string): { requests: MetaRequest[] } {
  const requests: MetaRequest[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    if (String(url).endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "muse-glimmer" }] }), { status: 200, headers: { "content-type": "application/json" } });
    const req = JSON.parse(String(init?.body)) as MetaRequest;
    requests.push(req);
    const content = reply(req.messages);
    const chunks = [
      { model: "muse-glimmer", choices: [{ delta: { reasoning_content: "(private reasoning)" } }] },
      { model: "muse-glimmer", choices: [{ delta: { content }, finish_reason: "stop" }] },
      { model: "muse-glimmer", choices: [], usage: { prompt_tokens: 500, completion_tokens: 80 } },
    ];
    return new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as unknown as typeof fetch;
  installGlimmerClient(p, new GlimmerClient(p, { fetch: f, baseUrl: "http://glimmer.test:8080" }));
  return { requests };
}

// ---------------------------------------------------------------------------
// Seeds and scripted agents
// ---------------------------------------------------------------------------

/** Wonder tool-loop route: answers each Wonder turn with the next scripted function calls (placeholders resolved). */
export function wonderRoute(turns: { name: string; args: unknown }[][], match: (req: MetaRequest) => boolean = (req) => toolNames(req).includes("finish")): MetaRoute & { turns: number } {
  let n = 0;
  const route = ((req: MetaRequest) => {
    if (!String(req.model).startsWith("muse-wonder") || !match(req)) return undefined;
    const turn = turns[Math.min(n, turns.length - 1)]!;
    n++;
    route.turns = n;
    return responsesBody({ model: "muse-wonder-1.0", functionCalls: turn.map((c) => ({ name: c.name, args: resolvePlaceholders(c.args, req) })) });
  }) as unknown as MetaRoute & { turns: number };
  route.turns = 0;
  return route;
}

/** Spark search-grounded calls (web_search tool present). */
export function searchRoute(name = "spark-search.json"): MetaRoute {
  return (req) => {
    if (!((req.tools ?? []) as MetaRequest[]).some((t) => t.type === "web_search")) return undefined;
    const f = fixtureJson<{ text: string; citations: { url: string; title?: string }[]; searchResults: { url: string; title?: string; snippet?: string }[] }>(name);
    return responsesBody({ text: f.text, citations: f.citations, searchResults: f.searchResults });
  };
}

/** Plain text answers for instructions containing `needle`. */
export function textRoute(needle: string, text: string): MetaRoute {
  return (req) => (String(req.instructions ?? "").includes(needle) && !schemaName(req) ? responsesBody({ text }) : undefined);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const hasWord = (text: string, word: string) => new RegExp(`(?:^|[^\\p{L}\\p{N}])${escapeRe(word)}(?:$|[^\\p{L}\\p{N}])`, "iu").test(text);

/**
 * Claim-validator stand-in (FIXTURE ONLY) that behaves like the model on a small vocabulary: a word
 * from `vocabulary` used in a text is flagged unless the confirmed facts or the listing evidence
 * sent with the request contain it. `lenient()` true = flag nothing (a model that misses it).
 */
export function factCheckRoute(opts: { vocabulary: string[]; statement?: (terms: string[]) => string; lenient?: () => boolean }): MetaRoute {
  return jsonRoute("ClaimValidation", (req) => {
    const text = requestText(req);
    const at = text.indexOf("Texts to check");
    const support = at >= 0 ? text.slice(0, at) : "";
    const lines = text
      .slice(Math.max(0, at))
      .split("\n")
      .filter((l) => l.startsWith('{"id":'))
      .map((l) => JSON.parse(l) as { id: string; text: string });
    return {
      results: lines.map((t) => {
        const terms = opts.lenient?.() ? [] : opts.vocabulary.filter((w) => hasWord(t.text, w) && !hasWord(support, w));
        return {
          id: t.id,
          issues: terms.length ? [{ quote: terms.join(", "), terms, statement: opts.statement?.(terms) ?? `The app has ${terms.join(" and ")}.`, problem: `no confirmed fact or listing evidence mentions ${terms.join(" or ")}` }] : [],
        };
      }),
    };
  });
}

/**
 * "Remove it" stand-in (FIXTURE ONLY) for the CopyRevision schema: deletes the flagged words from
 * each item to fix and tidies the punctuation, or returns the items unchanged when `keep()` is true
 * (a rewrite that didn't remove them).
 */
export function copyRevisionRoute(opts: { keep?: () => boolean } = {}): MetaRoute {
  return jsonRoute("CopyRevision", (req) => {
    const text = requestText(req);
    const flagged = text.split("What the fact check flagged:")[1]?.split("Items to fix")[0] ?? "";
    // The words to drop: the quote at the start of each flagged line (`- item <id>: "<quote>": <issue>`).
    const words = [...flagged.matchAll(/^- item [^:]+: "([^"]+)":/gm)].flatMap((m) => m[1]!.split(/\s*(?:,|&|\band\b)\s*/)).map((w) => w.trim()).filter((w) => w.length > 1);
    const items = (text.split("Items to fix (JSON lines):")[1]?.split("Other items of the same post")[0] ?? "")
      .split("\n")
      .filter((l) => l.startsWith('{"id":'))
      .map((l) => JSON.parse(l) as { id: string; text: string });
    const scrub = (s: string) => {
      let t = s;
      for (const w of words) t = t.replace(new RegExp(`\\s*#?\\b${escapeRe(w)}\\b`, "gi"), "");
      return t
        .replace(/,(\s*,)+/g, ",")
        .replace(/,\s*&/g, " &")
        .replace(/[ \t]{2,}/g, " ")
        .replace(/[ \t]+([,.!?])/g, "$1")
        .replace(/^[,&\s]+/, "")
        .trim()
        .replace(/^\p{Ll}/u, (c) => c.toUpperCase());
    };
    return { items: items.map((it) => ({ id: it.id, text: opts.keep?.() ? it.text : scrub(it.text) || it.text })), summary: `Fixture: removed ${words.join(", ") || "nothing"}` };
  });
}

/**
 * "Tell Muse what to change" stand-in (FIXTURE ONLY) for the CopyRewrite schema: a deterministic edit
 * of the post's own words (never new claims). "shorter" keeps the first sentence of each long item,
 * "friendlier"/"energetic"/"excited" ends the caption with "!", anything else moves the caption's
 * first sentence to the end. Summaries say "Fixture:".
 */
export function copyRewriteRoute(): MetaRoute {
  return jsonRoute("CopyRewrite", (req) => {
    const text = requestText(req);
    const ask = (text.match(/<untrusted_content source="founder_request">\n([\s\S]*?)\n<\/untrusted_content>/)?.[1] ?? "").toLowerCase();
    const items = (text.split("The post's copy now (JSON lines):")[1] ?? "")
      .split("\n")
      .filter((l) => l.startsWith('{"id":'))
      .map((l) => JSON.parse(l) as { id: string; kind: string; text: string });
    const sentences = (s: string) => s.match(/[^.!?\n]+[.!?]+|[^.!?\n]+$/g)?.map((x) => x.trim()).filter(Boolean) ?? [s];
    const edit = (it: { kind: string; text: string }) => {
      if (it.kind === "hashtags" || it.kind === "title") return it.text;
      const ss = sentences(it.text);
      if (/short|brief|tight|concise/.test(ask)) return ss.length > 1 ? `${ss[0]}${it.text.includes("[APP_LINK]") && !ss[0]!.includes("[APP_LINK]") ? " [APP_LINK]" : ""}` : it.text;
      if (/friend|energ|excit|fun|upbeat/.test(ask)) return it.text.replace(/[.!?]*\s*$/, "!");
      return ss.length > 1 ? [...ss.slice(1), ss[0]].join(" ") : `${it.text} ✨`;
    };
    const how = /short|brief|tight|concise/.test(ask) ? "made the caption shorter" : /friend|energ|excit|fun|upbeat/.test(ask) ? "made the caption more upbeat" : "reordered the caption";
    return { items: items.map((it) => ({ id: it.id, text: edit(it) })), summary: `Fixture: ${how}` };
  });
}

// ---------------------------------------------------------------------------
// Stills and text posts (FIXTURES ONLY): slide plans and text-only posts for the sample app
// ---------------------------------------------------------------------------

/** Carousel beats for Tidy Timer (cover → one idea per slide → call to action). */
const CAROUSEL_BEATS = [
  { headline: "Your phone wins. Again?", body: "Three small changes that give your focus back.", visual: "Bold hook over the real timer screen" },
  { headline: "1. Start one calm session", body: "Pick a length that fits the task and tap start.", visual: "The real timer screen in a phone frame" },
  { headline: "2. Let the noise wait", body: "Distracting apps stay quiet until the session ends.", visual: "The real session screen, the timer running" },
  { headline: "3. Watch the streak grow", body: "A weekly report shows the focus you kept.", visual: "The real weekly report screen" },
  { headline: "Small sessions add up", body: "Short, steady blocks beat one long push.", visual: "Another real screen of the app" },
  { headline: "Built to stay calm", body: "A quiet design that keeps you on the task.", visual: "A real screen of the app" },
  { headline: "Focus on what matters", body: "One session at a time, every day.", visual: "A real screen of the app" },
  { headline: "Make it a habit", body: "Come back tomorrow and keep the streak.", visual: "A real screen of the app" },
];
const STORE_BEATS = [
  { headline: "Focus in one tap", body: "Custom-length Pomodoro sessions" },
  { headline: "Silence distracting apps", body: "They wait until your session ends" },
  { headline: "See your weekly streak", body: "Reports that show your focus" },
  { headline: "Sessions that fit any task", body: "" },
  { headline: "Stay calm while you work", body: "" },
  { headline: "Build a focus habit", body: "" },
  { headline: "Pick up where you left off", body: "" },
  { headline: "Plan your day in blocks", body: "" },
  { headline: "Keep distractions away", body: "" },
  { headline: "Track every focused hour", body: "" },
];

/**
 * Muse Spark "SlidePlan" stand-in (FIXTURE ONLY, slides.ts): a labelled Tidy Timer slide plan for the
 * format and slide count the request asks for. Screens are refs from the request's media list (real
 * screenshots, cut-outs, walkthrough segments); a proof slide only cites a verified claim id chosen for
 * the concept. `over(plan, req)` may change the plan (tests).
 */
export function slidePlanRoute(over?: (plan: { title: string; slides: Record<string, unknown>[] }, req: MetaRequest) => unknown): MetaRoute {
  return jsonRoute("SlidePlan", (req) => {
    const text = requestText(req);
    const format = text.match(/\(format (post|carousel|thumbnail|store_screenshots), frame/)?.[1] ?? "carousel";
    const n = Math.max(1, Math.min(10, Number(text.match(/Plan exactly (\d+) slide/)?.[1] ?? (format === "carousel" || format === "store_screenshots" ? 6 : 1))));
    // Real screens offered in the media list (screenshots, cut-outs, segments), in order.
    const screens = [...text.matchAll(/^- (\S+) \| (raw screenshot|app-screen cut-out of a store image|walkthrough segment of \S+) \|/gm)].map((m) => ({ ref: m[1]!, segment: m[2]!.startsWith("walkthrough") }));
    const hint = (i: number) => {
      const s = screens[i % Math.max(1, screens.length)];
      return s ? [s.segment ? { kind: "app_recording", segmentId: s.ref } : { kind: "screenshot", assetId: s.ref }] : [];
    };
    const concept = text.match(/^Concept: (.+?) \([\w-]+\)$/m)?.[1] ?? "Calm focus";
    const cta = text.match(/CTA "([^"]+)"/)?.[1] ?? text.match(/Call to action: "([^"]+)"/)?.[1] ?? "Start your first focus session";
    const claim = text.match(/Claims chosen for this concept: (clm_[A-Za-z0-9_-]+): ([^|\n]+)/);
    let slides: Record<string, unknown>[];
    if (format === "thumbnail") slides = [{ template: "thumbnail-bold", purpose: "hook", headline: "Focus in one tap", body: "", visual: "Huge words beside the real timer screen", assets: hint(0) }];
    else if (format === "post") slides = [{ template: "slide-cover", purpose: "hook", headline: "Your phone wins. Again?", body: "One calm Pomodoro session gives your focus back.", visual: "Bold hook over the real timer screen", assets: hint(0) }];
    else if (format === "store_screenshots") slides = STORE_BEATS.slice(0, n).map((x, i) => ({ template: "store-screenshot", purpose: "feature", headline: x.headline, body: x.body, visual: "Benefit headline on top, the real screen large below", assets: hint(i) }));
    else {
      const middle = Math.max(0, n - 2);
      slides = [
        { template: "slide-cover", purpose: "hook", ...CAROUSEL_BEATS[0], assets: hint(0) },
        ...Array.from({ length: middle }, (_, i) =>
          claim && i === middle - 1 && middle >= 3
            ? { template: "slide-proof", purpose: "proof", headline: claim[2]!.trim().split(/\s+/).slice(0, 8).join(" "), body: "", visual: "The verified claim, large", claimIds: [claim[1]] }
            : { template: "slide-feature", purpose: "feature", ...CAROUSEL_BEATS[1 + (i % (CAROUSEL_BEATS.length - 1))], assets: hint(i + 1) },
        ),
        { template: "slide-cta", purpose: "cta", headline: cta.split(/\s+/).slice(0, 8).join(" "), body: "One calm session is all it takes.", visual: "App icon, name and store pills", assets: [] },
      ].slice(0, n);
    }
    const plan = { title: `Fixture: ${concept}`.slice(0, 200), slides };
    return over ? (over(plan, req) ?? plan) : plan;
  });
}

/**
 * Text-only post stand-in (FIXTURE ONLY) for "CopyPacks" when copy.generate writes a Create text post
 * (each channel marked "a TEXT-ONLY post"): one labelled Tidy Timer post per channel, within its limit.
 * Other copy requests fall through. `over(channel)` replaces a channel's caption (tests).
 */
export function textPostCopyRoute(over?: (channel: string) => string | undefined): MetaRoute {
  return (req: MetaRequest) => {
    if (schemaName(req) !== "CopyPacks") return undefined;
    const text = requestText(req);
    const channels = [...text.matchAll(/^- (x|threads|linkedin|reddit|facebook): a TEXT-ONLY post/gm)].map((m) => m[1]!);
    if (!channels.length) return undefined;
    const claimId = text.match(/\b(clm_[A-Za-z0-9_-]+)/)?.[1];
    const POSTS: Record<string, string> = {
      x: "Your phone wins again? Start one calm Pomodoro session and let distracting apps wait until it ends. Small sessions add up. [APP_LINK]",
      threads: "Studying with your phone face up never works. Tidy Timer runs custom-length Pomodoro sessions and blocks distracting apps while they run, so the next 25 minutes are yours. [APP_LINK]",
      linkedin: "Deep work rarely fails for lack of time. It fails at the first notification.\n\nI built Tidy Timer to protect short, focused blocks: pick a session length, start it, and distracting apps stay blocked until it ends. A weekly report shows the streak you kept.\n\nIf you try it, I'd love to hear what you think. [APP_LINK]",
      facebook: "Need an hour of real focus tonight? Tidy Timer blocks distracting apps during each Pomodoro session and keeps a weekly streak of the focus you kept. [APP_LINK]",
    };
    const packs = channels.map((c) =>
      c === "reddit"
        ? { channel: c, items: [{ kind: "title", text: "I built a calm Pomodoro timer that blocks distracting apps during sessions" }, { kind: "description", text: "Hi all, I'm the maker. Tidy Timer runs custom-length focus sessions and blocks distracting apps while they run, with a weekly report of your streak. It's early, so honest feedback is very welcome. [APP_LINK]" }] }
        : { channel: c, items: [{ kind: "caption", text: over?.(c) ?? POSTS[c]!, claimIds: claimId ? [claimId] : [] }] },
    );
    return responsesBody({ text: JSON.stringify({ packs }) });
    };
}

export interface SeededApp {
  appId: string;
  screenshotIds: string[];
  iconId: string;
  claimIds: { verified: string[]; review: string[] };
  featureIds: string[];
}

/** Seed an app with App DNA, evidence, claims and real (generated test PNG) screenshots in storage. */
export async function seedApp(p: Platform, workspaceId: string, opts: { name?: string } = {}): Promise<SeededApp> {
  const ws = p.db.ws(workspaceId);
  const actor = "seed";
  const app = await ws.collection("apps").create({ name: opts.name ?? "Tidy Timer", platforms: ["ios"], category: "Productivity", status: "draft", dnaStatus: "needs_review", storeUrls: { ios: "https://apps.apple.com/us/app/tidy-timer-focus-pomodoro/id1234567890" }, targetCountries: ["US"] }, { actor });
  const put = async (name: string, buf: Buffer) => {
    const key = `workspaces/${workspaceId}/apps/${app.id}/seed/${name}.png`;
    const r = await p.storage.put(key, buf, { contentType: "image/png" });
    return { key, ...r };
  };
  const mk = async (role: "screenshot" | "icon", name: string, buf: Buffer) => {
    const s = await put(name, buf);
    return ws.collection("mediaAssets").create({ appId: app.id, kind: "image", role, origin: "store_import", storagePath: s.key, mimeType: "image/png", bytes: s.bytes, sha256: s.sha256, width: 90, height: 160, status: "ready", title: `${name}`, isProductTruth: true, license: { type: "public_listing", sourceUrl: "https://is1-ssl.mzstatic.com/image/thumb/fixture/x.png" } }, { actor });
  };
  const shots = [await mk("screenshot", "timer-screen", await png([250, 250, 250])), await mk("screenshot", "report-screen", await png([22, 24, 36]))];
  const icon = await mk("icon", "icon", await png([92, 70, 220], [64, 64]));
  const src = { kind: "store_listing" as const, url: "https://apps.apple.com/us/app/tidy-timer-focus-pomodoro/id1234567890", retrievedAt: new Date().toISOString() };
  const ev = async (kind: "feature" | "pricing" | "visual", fact: string, assetId?: string) =>
    ws.collection("appEvidence").create({ appId: app.id, kind, fact, source: src, assetId, observedAt: new Date().toISOString(), reviewState: "verified" }, { actor });
  const e1 = await ev("feature", "Pomodoro timer with custom session lengths");
  const e2 = await ev("feature", "Block distracting apps during focus sessions");
  const e3 = await ev("feature", "Weekly focus reports with streaks");
  await ev("pricing", "App Store price: Free");
  await ev("visual", "Screenshot 1 of 2 from the App Store listing", shots[0]!.id);
  const featureIds = ["feat_timer", "feat_block", "feat_reports"];
  await ws.collection("brandProfiles").create(
    {
      id: app.id,
      appId: app.id,
      version: 1,
      status: "confirmed",
      oneLiner: "A calm Pomodoro timer that blocks distracting apps and tracks weekly focus streaks.",
      description: "Tidy Timer is an iPhone focus app built around custom-length Pomodoro sessions.",
      platforms: ["ios"],
      audiences: [{ id: "aud_students", name: "Students", description: "Students studying in focused blocks.", painPoints: ["Phone distractions"], motivations: ["Finish revision"], evidenceIds: [] }],
      problems: [{ id: "prob_1", text: "Phones pull attention away during focused work.", evidenceIds: [e2.id] }],
      features: [
        { id: featureIds[0]!, name: "Pomodoro timer", description: "Custom-length focus sessions.", evidenceIds: [e1.id], assetIds: [shots[0]!.id] },
        { id: featureIds[1]!, name: "Distraction blocking", description: "Blocks distracting apps during sessions.", evidenceIds: [e2.id], assetIds: [] },
        { id: featureIds[2]!, name: "Weekly focus reports", description: "Weekly reports with streaks.", evidenceIds: [e3.id], assetIds: [shots[1]!.id] },
      ],
      differentiators: [{ id: "diff_1", text: "Calm design.", evidenceIds: [] }],
      monetization: { model: "freemium", evidenceIds: [] },
      tone: { voice: ["calm", "encouraging"], vocabularyUse: ["focus"], vocabularyAvoid: ["hustle"] },
      visual: { palette: [{ hex: "#5C46DC", role: "primary" }], styleKeywords: ["minimal"], logoAssetIds: [icon.id], sampleAssetIds: shots.map((s) => s.id) },
      preferredCtas: ["Start your first focus session"],
      prohibitedClaims: ["works offline"],
    },
    { actor },
  );
  await ws.collection("apps").update(app.id, { iconAssetId: icon.id, brandProfileId: app.id, dnaStatus: "confirmed" }, { actor });
  const claim = (text: string, state: "verified" | "needs_review", evidenceIds: string[]) =>
    ws.collection("claims").create({ appId: app.id, text, evidenceIds, confidence: 0.9, state, origin: "extracted", speculative: state !== "verified" }, { actor });
  const c1 = await claim("Block distracting apps during focus sessions", "verified", [e2.id]);
  const c2 = await claim("Weekly focus reports with streaks", "verified", [e3.id]);
  const c3 = await claim("The #1 focus app for students", "needs_review", [e1.id]);
  return { appId: app.id, screenshotIds: shots.map((s) => s.id), iconId: icon.id, claimIds: { verified: [c1.id, c2.id], review: [c3.id] }, featureIds };
}

// Spark video review fixtures (a real tiny MP4 made from FFmpeg test sources).
export { makeTestVideo, reviewTestDoc, seedRenderedVideo, type TestSegment } from "./review/testing";
