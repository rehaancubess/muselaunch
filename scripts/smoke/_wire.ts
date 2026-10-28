import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { redactForTrace, type Platform } from "@muselaunch/platform";
import { GlimmerClient, installGlimmerClient, installMetaClient, MetaClient } from "@muselaunch/providers";

/**
 * Raw wire capture for live smoke runs: every HTTP exchange with the Meta Model API (and Glimmer)
 * is written to fixtures/live/raw/wire/ (gitignored) BEFORE our parsers touch it, so request and
 * response shapes can be checked against the docs. Redaction: no request headers except
 * content-type/accept; secret-looking response headers, cookies and query params are masked; long
 * strings (base64 media, mask payloads) are truncated by `redactForTrace`; private reasoning text
 * from Glimmer streams is replaced by its length.
 */
export const WIRE_DIR = fileURLToPath(new URL("../../fixtures/live/raw/wire/", import.meta.url));

const SECRET = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|api_key|key|token|access_token)$/i;
let seq = 0;
const pending: Promise<void>[] = [];

export function installWireCapture(p: Platform): void {
  mkdirSync(WIRE_DIR, { recursive: true });
  installMetaClient(p, new MetaClient(p, { fetch: recordingFetch("meta") }));
  if (p.cfg.GLIMMER_BASE_URL) installGlimmerClient(p, new GlimmerClient(p, { fetch: recordingFetch("glimmer") }));
}

/** Wait for in-flight captures to be written. Returns how many exchanges were saved. */
export async function flushWire(): Promise<number> {
  await Promise.allSettled(pending);
  return seq;
}

function recordingFetch(label: string, inner: typeof fetch = fetch): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const n = ++seq;
    const started = Date.now();
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const request = { method: init?.method ?? "GET", url: safeUrl(url), headers: pickRequestHeaders(init?.headers), body: init?.body };
    let res: Response;
    try {
      res = await inner(input, init);
    } catch (err) {
      pending.push(save(n, label, request, { networkError: String((err as Error)?.message ?? err) }, started));
      throw err;
    }
    const copy = res.clone();
    pending.push(
      (async () => {
        const text = await copy.text().catch((e: unknown) => `[body read failed: ${String(e)}]`);
        const contentType = res.headers.get("content-type") ?? "";
        const body = contentType.includes("text/event-stream") ? summariseSse(text) : parseMaybeJson(text);
        await save(n, label, request, { status: res.status, statusText: res.statusText, headers: headerObject(res.headers), body }, started);
      })(),
    );
    return res;
  }) as typeof fetch;
}

async function save(n: number, label: string, request: { method: string; url: string; headers: Record<string, string>; body: unknown }, response: unknown, started: number) {
  const path = new URL(request.url).pathname;
  const name = `${String(n).padStart(3, "0")}-${label}-${request.method}-${path.replace(/[^a-z0-9]+/gi, "_").replace(/^_|_$/g, "")}.json`;
  const out = {
    capturedAt: new Date().toISOString(),
    live: true,
    elapsedMs: Date.now() - started,
    request: { ...request, body: redactForTrace(await describeBody(request.body)) },
    response: redactForTrace(response),
  };
  writeFileSync(`${WIRE_DIR}${name}`, JSON.stringify(out, null, 2));
}

function safeUrl(url: string): string {
  const u = new URL(url);
  for (const k of [...u.searchParams.keys()]) if (SECRET.test(k)) u.searchParams.set(k, "[redacted]");
  return u.toString();
}

function pickRequestHeaders(h: ConstructorParameters<typeof Headers>[0]): Record<string, string> {
  const all = new Headers(h);
  const out: Record<string, string> = {};
  for (const k of ["content-type", "accept"]) {
    const v = all.get(k);
    if (v) out[k] = k === "content-type" ? v.replace(/boundary=.*/, "boundary=…") : v;
  }
  return out;
}

function headerObject(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => {
    out[k] = SECRET.test(k) ? "[redacted]" : v;
  });
  return out;
}

function parseMaybeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function describeBody(body: unknown): Promise<unknown> {
  if (body == null) return undefined;
  if (typeof body === "string") return parseMaybeJson(body);
  if (body instanceof FormData) {
    const parts: unknown[] = [];
    for (const [name, v] of body.entries()) {
      if (typeof v === "string") parts.push({ name, value: parseMaybeJson(v) });
      else if (v.type.includes("json") && v.size < 64 * 1024) parts.push({ name, type: v.type, value: parseMaybeJson(await v.text()) });
      else parts.push({ name, file: v.name, type: v.type, bytes: v.size });
    }
    return { multipart: parts };
  }
  return `[${Object.prototype.toString.call(body)}]`;
}

/**
 * SSE bodies: keep every non-delta event in full (created/completed/failed/error/web search events,
 * which carry status, usage and output), plus the first few text deltas and counts.
 */
function summariseSse(text: string): unknown {
  const events: unknown[] = [];
  const firstDeltas: unknown[] = [];
  let deltaEvents = 0;
  let deltaChars = 0;
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") continue;
    let ev: Record<string, any>;
    try {
      ev = JSON.parse(data) as Record<string, any>;
    } catch {
      events.push({ unparsed: data.slice(0, 2000) });
      continue;
    }
    // Chat Completions chunks: hide private reasoning text, keep its length.
    for (const c of (ev.choices ?? []) as Record<string, any>[]) {
      for (const holder of [c.delta, c.message]) {
        if (!holder) continue;
        for (const k of ["reasoning_content", "reasoning"]) if (typeof holder[k] === "string") holder[k] = `[${holder[k].length} chars of private reasoning]`;
      }
    }
    const isResponsesDelta = ev.type === "response.output_text.delta";
    const isChatDelta = Array.isArray(ev.choices) && ev.choices.length > 0 && ev.choices.every((c: Record<string, any>) => !c.finish_reason) && !ev.usage;
    if (isResponsesDelta || isChatDelta) {
      deltaEvents++;
      deltaChars += typeof ev.delta === "string" ? ev.delta.length : JSON.stringify(ev.choices).length;
      if (firstDeltas.length < 5) firstDeltas.push(ev);
      continue;
    }
    events.push(ev);
  }
  return { sse: true, deltaEvents, deltaChars, firstDeltaEvents: firstDeltas, otherEvents: events };
}
