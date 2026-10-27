import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { FetchLike } from "./http";

/**
 * TEST UTILITY: scripted fetch for provider adapter tests. Responses come from documented fixtures
 * under fixtures/growth/ (labelled as fixtures). Never used by product code paths.
 */
export interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  /** Parsed JSON or form body when applicable. */
  json?: unknown;
  form?: Record<string, string>;
  bodyBytes?: number;
  bodyText?: string;
}

type Reply = { status?: number; json?: unknown; text?: string; headers?: Record<string, string> };
type Route = { method: string; match: string | RegExp; replies: (Reply | ((req: RecordedRequest) => Reply))[]; calls: number };

export class FakeFetch {
  readonly requests: RecordedRequest[] = [];
  private readonly routes: Route[] = [];

  /** Register replies for METHOD + URL (prefix string or regex); replies are used in order, the last repeats. */
  on(method: string, match: string | RegExp, ...replies: Route["replies"]): this {
    this.routes.push({ method: method.toUpperCase(), match, replies, calls: 0 });
    return this;
  }

  calls(method: string, match: string | RegExp): RecordedRequest[] {
    return this.requests.filter((r) => r.method === method.toUpperCase() && (typeof match === "string" ? r.url.startsWith(match) : match.test(r.url)));
  }

  readonly fetch: FetchLike = async (input, init = {}) => {
    const method = (init.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init.headers as never).forEach((v, k) => (headers[k] = v));
    const req: RecordedRequest = { method, url: String(input), headers };
    const body = init.body as unknown;
    if (typeof body === "string") {
      req.bodyText = body;
      req.bodyBytes = Buffer.byteLength(body);
      if (headers["content-type"]?.includes("json")) req.json = JSON.parse(body);
      if (headers["content-type"]?.includes("x-www-form-urlencoded")) req.form = Object.fromEntries(new URLSearchParams(body));
    } else if (body instanceof Uint8Array) {
      req.bodyBytes = body.byteLength;
    } else if (body && typeof (body as FormData).get === "function") {
      req.bodyText = "[multipart]";
    }
    this.requests.push(req);
    const route = this.routes.find((r) => r.method === method && (typeof r.match === "string" ? req.url.startsWith(r.match) : r.match.test(req.url)));
    if (!route) return new Response(JSON.stringify({ error: { message: `FakeFetch: no route for ${method} ${req.url}` } }), { status: 599, headers: { "content-type": "application/json" } });
    const spec = route.replies[Math.min(route.calls, route.replies.length - 1)]!;
    route.calls++;
    const r = typeof spec === "function" ? spec(req) : spec;
    const text = r.text ?? (r.json !== undefined ? JSON.stringify(r.json) : "");
    const status = r.status ?? 200;
    return new Response(status === 204 || status === 304 ? null : text, { status, headers: { "content-type": "application/json", ...r.headers } });
  };
}

/** Load a documented-shape fixture from fixtures/growth/<name>.json. */
export function growthFixture<T = Record<string, any>>(name: string): T {
  return JSON.parse(readFileSync(fileURLToPath(new URL(`../../../../fixtures/growth/${name}.json`, import.meta.url)), "utf8")) as T;
}
