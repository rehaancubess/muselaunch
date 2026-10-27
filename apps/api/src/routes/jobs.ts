import { JobStatus, TERMINAL_JOB_STATUSES, type Job } from "@muselaunch/contracts";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { actorOf, query, requireCap, type AppEnv } from "../context";

/** Job status, live progress (SSE), cancel and retry. */
export const jobRoutes = new Hono<AppEnv>();

const ListJobs = z.object({ appId: z.string().optional(), status: JobStatus.optional(), limit: z.coerce.number().int().min(1).max(100).default(30) });

jobRoutes.get("/", async (c) => {
  const p = c.get("platform");
  const q = query(c, ListJobs);
  const where: [string, "==", unknown][] = [];
  if (q.appId) where.push(["appId", "==", q.appId]);
  if (q.status) where.push(["status", "==", q.status]);
  const page = await p.db.ws(c.get("workspaceId")).collection("jobs").list({ where, orderBy: { field: "createdAt", dir: "desc" }, limit: q.limit });
  return c.json(page);
});

jobRoutes.get("/:jobId", async (c) => {
  const p = c.get("platform");
  const job = await p.db.ws(c.get("workspaceId")).collection("jobs").getOrThrow(c.req.param("jobId"));
  return c.json({ job });
});

/**
 * Server-sent events: `job` events with the full job doc on every change, ending after a
 * terminal status. Browsers should use fetch-based SSE (EventSource cannot send auth headers).
 * Jobs stay pollable via GET /jobs/:id when the client disconnects.
 */
jobRoutes.get("/:jobId/events", async (c) => {
  const p = c.get("platform");
  const repo = p.db.ws(c.get("workspaceId")).collection("jobs");
  const initial = await repo.getOrThrow(c.req.param("jobId"));
  return streamSSE(c, async (stream) => {
    let resolveDone!: () => void;
    const done = new Promise<void>((r) => (resolveDone = r));
    let lastUpdated = "";
    const send = async (job: Job | null) => {
      if (!job || job.updatedAt === lastUpdated) return;
      lastUpdated = job.updatedAt;
      await stream.writeSSE({ event: "job", data: JSON.stringify(job), id: job.updatedAt });
      if (TERMINAL_JOB_STATUSES.includes(job.status) || job.status === "needs_approval") resolveDone();
    };
    await send(initial);
    const unwatch = repo.watch(initial.id, (job) => void send(job));
    const ping = setInterval(() => void stream.writeSSE({ event: "ping", data: "{}" }), 15_000);
    const timeout = setTimeout(resolveDone, 30 * 60_000);
    stream.onAbort(() => resolveDone());
    await done;
    clearInterval(ping);
    clearTimeout(timeout);
    unwatch();
  });
});

jobRoutes.get("/:jobId/log", async (c) => {
  const p = c.get("platform");
  await p.db.ws(c.get("workspaceId")).collection("jobs").getOrThrow(c.req.param("jobId"));
  const events = await p.jobs.listEvents(c.get("workspaceId"), c.req.param("jobId"));
  return c.json({ items: events });
});

jobRoutes.post("/:jobId/cancel", requireCap("content.write"), async (c) => {
  const p = c.get("platform");
  const job = await p.jobs.requestCancel(c.get("workspaceId"), c.req.param("jobId"), actorOf(c));
  return c.json({ job });
});

jobRoutes.post("/:jobId/retry", requireCap("content.write"), async (c) => {
  const p = c.get("platform");
  const job = await p.jobs.retry(c.get("workspaceId"), c.req.param("jobId"), actorOf(c));
  return c.json({ job }, 202);
});
