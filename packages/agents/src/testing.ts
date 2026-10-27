/**
 * Test harness for module B (and integrator E2E tests): fake Meta Responses API and fake public
 * web serving documented-shape FIXTURES from `fixtures/agents/`. Never used by product code.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Platform, SafeFetchOptions } from "@muselaunch/platform";
import { GlimmerClient, installGlimmerClient, installMetaClient, MetaClient } from "@muselaunch/providers";
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

/** Install a fake Meta client: routes are tried in order; the first non-undefined result is the response body. */
export function installFakeMeta(p: Platform, routes: MetaRoute[]): { requests: MetaRequest[] } {
  const requests: MetaRequest[] = [];
  const f = (async (_url: string, init: RequestInit) => {
    const req = JSON.parse(String(init.body)) as MetaRequest;
    requests.push(req);
    for (const r of routes) {
      const body = r(req, requests.length - 1);
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
