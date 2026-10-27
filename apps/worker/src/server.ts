import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

loadDotenv({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

const { serve } = await import("@hono/node-server");
const { Hono } = await import("hono");
const { JOB_POOLS, TaskEnvelope } = await import("@muselaunch/contracts");
const { createPlatform, createRunner, toAppError } = await import("@muselaunch/platform");
const { handlers } = await import("./registry");

const platform = createPlatform();
const pools = new Set(platform.cfg.WORKER_POOLS);
const runner = createRunner(platform, handlers);
const app = new Hono();

function authorised(header: string | undefined): boolean {
  // Cloud Run IAM (no unauthenticated access + Cloud Tasks OIDC) already authenticates the caller.
  if (process.env.WORKER_TRUST_IAM === "1") return true;
  const expected = Buffer.from(platform.cfg.WORKER_SHARED_SECRET);
  const got = Buffer.from(header ?? "");
  return got.length === expected.length && timingSafeEqual(got, expected);
}

app.get("/health", (c) => c.json({ ok: true, service: "worker", pools: [...pools], handlers: Object.keys(handlers).length }));

/**
 * Execute one job. Synchronous by design (Cloud Tasks waits for the response):
 * 2xx = done (succeeded / failed permanently / skipped), 503 = retry later.
 */
app.post("/tasks/execute", async (c) => {
  if (!authorised(c.req.header("x-worker-secret"))) return c.json({ error: "unauthorised" }, 401);
  const parsed = TaskEnvelope.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "bad envelope" }, 400);
  const env = parsed.data;
  if (!pools.has(JOB_POOLS[env.type])) return c.json({ error: `pool ${JOB_POOLS[env.type]} not served here` }, 400);
  try {
    const outcome = await runner.execute(env);
    return c.json({ outcome }, outcome === "retry" ? 503 : 200);
  } catch (err) {
    const e = toAppError(err);
    platform.log.error({ err: { code: e.code, message: e.message }, env }, "task execution crashed");
    return c.json({ error: e.code }, 503);
  }
});

const port = Number(process.env.PORT ?? platform.cfg.WORKER_PORT);
serve({ fetch: app.fetch, port }, () => {
  platform.log.info({ port, pools: [...pools], handlers: Object.keys(handlers) }, "MuseLaunch worker listening");
});
