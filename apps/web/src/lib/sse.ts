import { buildUrl, getToken } from "./api";

/**
 * Fetch-based Server-Sent Events reader (EventSource can't send Authorization headers).
 * Calls `onEvent` for each `event:`/`data:` frame. Resolves when the server closes the stream.
 */
export async function readSse(
  path: string,
  opts: { signal: AbortSignal; onEvent: (event: string, data: string, id?: string) => void; lastEventId?: string },
): Promise<void> {
  const token = await getToken();
  const headers: Record<string, string> = { accept: "text/event-stream" };
  if (token) headers.authorization = `Bearer ${token}`;
  if (opts.lastEventId) headers["last-event-id"] = opts.lastEventId;
  const res = await fetch(buildUrl(path), { headers, signal: opts.signal, cache: "no-store" });
  if (!res.ok || !res.body) throw Object.assign(new Error(`SSE ${res.status}`), { status: res.status });

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  let event = "message";
  let data: string[] = [];
  let id: string | undefined;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
      if (line === "") {
        if (data.length) opts.onEvent(event, data.join("\n"), id);
        event = "message";
        data = [];
        continue;
      }
      if (line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      const val = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
      if (field === "event") event = val;
      else if (field === "data") data.push(val);
      else if (field === "id") id = val;
    }
  }
}

export interface StreamOptions<T> {
  /** SSE path, e.g. `/v1/workspaces/:wid/jobs/:id/events`. */
  path: string;
  /** Event name carrying the payload (`job`). */
  event: string;
  onData: (data: T) => void;
  /** Stop when this returns true (e.g. terminal job status). */
  isDone: (data: T) => boolean;
  /** Poll fallback when streaming keeps failing. */
  poll: () => Promise<T>;
  pollIntervalMs?: number;
  onMode?: (mode: "live" | "polling" | "done") => void;
  onError?: (err: unknown) => void;
}

/**
 * Live subscription with reconnect + backoff; after 3 consecutive stream failures it falls
 * back to polling. Returns a disposer.
 */
export function subscribe<T>(opts: StreamOptions<T>): () => void {
  const ctrl = new AbortController();
  let finished = false;
  let failures = 0;
  let lastId: string | undefined;

  const finish = () => {
    finished = true;
    opts.onMode?.("done");
  };

  const sleep = (ms: number) =>
    new Promise<void>((r) => {
      const t = setTimeout(r, ms);
      ctrl.signal.addEventListener("abort", () => {
        clearTimeout(t);
        r();
      });
    });

  const pollLoop = async () => {
    opts.onMode?.("polling");
    while (!finished && !ctrl.signal.aborted) {
      try {
        const d = await opts.poll();
        opts.onData(d);
        if (opts.isDone(d)) return finish();
      } catch (err) {
        opts.onError?.(err);
        const status = (err as { status?: number })?.status;
        if (status === 404 || status === 403 || status === 401) return finish();
      }
      await sleep(opts.pollIntervalMs ?? 2500);
    }
  };

  const streamLoop = async () => {
    while (!finished && !ctrl.signal.aborted) {
      try {
        opts.onMode?.("live");
        await readSse(opts.path, {
          signal: ctrl.signal,
          lastEventId: lastId,
          onEvent: (ev, raw, id) => {
            if (ev !== opts.event) return;
            lastId = id;
            failures = 0;
            try {
              const d = JSON.parse(raw) as T;
              opts.onData(d);
              if (opts.isDone(d)) finish();
            } catch {
              /* malformed frame: ignore */
            }
          },
        });
        if (finished || ctrl.signal.aborted) return;
        // Server closed without a terminal event (timeout/redeploy): confirm by polling once.
        const d = await opts.poll();
        opts.onData(d);
        if (opts.isDone(d)) return finish();
      } catch (err) {
        if (ctrl.signal.aborted) return;
        const status = (err as { status?: number })?.status;
        if (status === 404 || status === 403) return finish();
        failures += 1;
        opts.onError?.(err);
        if (failures >= 3) return pollLoop();
        await sleep(Math.min(8000, 600 * 2 ** failures));
      }
    }
  };

  void streamLoop();
  return () => ctrl.abort();
}
