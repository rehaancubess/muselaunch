import type { ConnectRevenueCatRequest, ConnectedAccount, Job } from "@muselaunch/contracts";
import { nowIso } from "@muselaunch/db";
import { AppError, toAppError, type JobHandler, type Platform } from "@muselaunch/platform";
import { RC_DAILY_CHARTS, RC_OVERVIEW_METRICS, RevenueCatClient, parseChartPoints, parsePeriodDays, rcTimestampMs } from "@muselaunch/providers";
import { DAY_MS, hashId, isoDay, upsertObservation } from "./observations";

/** Tests inject a fake fetch per platform (documented fixtures, never live output). */
const fetchOverrides = new WeakMap<Platform, typeof fetch>();
export function installRevenueCatFetch(p: Platform, f: typeof fetch): void {
  fetchOverrides.set(p, f);
}

interface RcSecret {
  secretKey: string;
  projectId: string;
  currency: string;
}

const RC_MODEL = "revenuecat-api-v2";

function client(p: Platform, secretKey: string, signal?: AbortSignal) {
  return new RevenueCatClient({ secretKey, fetch: fetchOverrides.get(p), signal });
}

/** Meter third-party analytics calls like every other provider call (cost 0, traceable). */
async function meter<T>(p: Platform, workspaceId: string, meta: { task: string; appId?: string; jobId?: string; actor?: string }, fn: () => Promise<T & { requestId?: string }>): Promise<T> {
  const started = Date.now();
  try {
    const out = await fn();
    await p.usage.record(workspaceId, { provider: "analytics", model: RC_MODEL, operation: "http", task: meta.task, appId: meta.appId, jobId: meta.jobId, actor: meta.actor, requestId: out.requestId, runtimeMs: Date.now() - started, costUsdEstimate: 0, status: "ok", dataMode: "third_party" });
    return out;
  } catch (err) {
    const e = toAppError(err);
    await p.usage
      .record(workspaceId, { provider: "analytics", model: RC_MODEL, operation: "http", task: meta.task, appId: meta.appId, jobId: meta.jobId, actor: meta.actor, runtimeMs: Date.now() - started, costUsdEstimate: 0, status: "error", errorCode: e.code, dataMode: "third_party" })
      .catch(() => {});
    throw e;
  }
}

export const revenueCatAccountId = (appId: string, projectId: string) => hashId("acc", `${appId}:revenuecat:${projectId}`);

/**
 * Connect RevenueCat with a v2 secret key + project id. The key is validated with a real
 * overview call before it is stored (encrypted via SecretStore); failures are reported verbatim
 * (bad key, missing permission, unknown project) and nothing is stored.
 */
export async function connectRevenueCat(p: Platform, workspaceId: string, input: ConnectRevenueCatRequest, actor: string): Promise<{ account: ConnectedAccount; job: Job }> {
  const ws = p.db.ws(workspaceId);
  await ws.collection("apps").getOrThrow(input.appId);
  const rc = client(p, input.secretKey);
  await meter(p, workspaceId, { task: "analytics.revenuecat.validate", appId: input.appId, actor }, () => rc.overview(input.projectId, { currency: input.currency }));
  let displayName = `RevenueCat project ${input.projectId}`;
  try {
    const projects = await rc.listProjects();
    const match = projects.data.items?.find((x) => x.id === input.projectId);
    if (match?.name) displayName = `RevenueCat · ${match.name}`;
  } catch {
    // Optional: the key may not have project_configuration:projects:read.
  }
  const id = revenueCatAccountId(input.appId, input.projectId);
  const secretId = `rc-${id}`;
  await p.secrets.put(workspaceId, secretId, "revenuecat", { secretKey: input.secretKey, projectId: input.projectId, currency: input.currency } satisfies RcSecret);
  const repo = ws.collection("connectedAccounts");
  const fields = {
    appId: input.appId,
    provider: "revenuecat" as const,
    purposes: ["analytics" as const],
    externalAccountId: input.projectId,
    displayName: displayName.slice(0, 200),
    scopes: ["charts_metrics:overview:read", "charts_metrics:charts:read"],
    status: "connected" as const,
    capabilities: ["read_revenue" as const, "read_insights" as const],
    secretId,
    connectedBy: actor,
    lastError: undefined,
  };
  const { entity, created } = await repo.createIfAbsent({ id, ...fields }, { actor });
  const account = created ? entity : await repo.update(id, fields, { actor });
  const job = await p.jobs.create(workspaceId, "analytics.sync", { connectionId: id, appId: input.appId }, { actor, appId: input.appId, idempotencyKey: `rc-sync:${id}:${Date.now()}`, credits: { operation: "analytics.sync" } });
  return { account, job };
}

export async function disconnectAnalyticsAccount(p: Platform, workspaceId: string, accountId: string, actor: string): Promise<ConnectedAccount> {
  const repo = p.db.ws(workspaceId).collection("connectedAccounts");
  const account = await repo.getOrThrow(accountId);
  if (!account.purposes.includes("analytics")) throw new AppError("BAD_REQUEST", "Not an analytics connection");
  if (account.secretId) await p.secrets.delete(workspaceId, account.secretId);
  // Observations already synced stay (they're real, labelled history); no further syncs happen.
  return repo.update(accountId, { status: "revoked", secretId: undefined }, { actor });
}

/** Job `analytics.sync`: pull RevenueCat overview + daily charts into labelled observations. */
export const analyticsSyncHandler: JobHandler<"analytics.sync"> = async (ctx) => {
  const { connectionId, appId, since } = ctx.payload;
  const accounts = ctx.ws.collection("connectedAccounts");
  const account = await accounts.getOrThrow(connectionId);
  if (account.appId && account.appId !== appId) throw new AppError("BAD_REQUEST", "Connection belongs to a different app", { retryable: false });
  if (account.provider !== "revenuecat") {
    throw new AppError("PROVIDER_NOT_CONFIGURED", `Analytics sync for ${account.provider} is not available yet`, { retryable: false, userMessage: `Automatic ${account.provider} analytics aren't available in the beta. Import a CSV or enter numbers manually.` });
  }
  if (account.status !== "connected" || !account.secretId) throw new AppError("PROVIDER_NOT_CONFIGURED", "RevenueCat connection is not active", { retryable: false, userMessage: "Reconnect RevenueCat to sync." });
  const secret = await ctx.platform.secrets.get<RcSecret>(ctx.workspaceId, account.secretId);
  if (!secret) throw new AppError("PROVIDER_NOT_CONFIGURED", "RevenueCat key missing", { retryable: false, userMessage: "Reconnect RevenueCat to sync." });

  const rc = client(ctx.platform, secret.secretKey, ctx.signal);
  const meta = { appId, jobId: ctx.job.id, actor: ctx.actor };
  const base = { appId, source: "revenuecat" as const, connectionId: account.id, externalAccountId: secret.projectId, attribution: "aggregate" as const, timezone: "UTC" };
  const unmapped: string[] = [];
  const skipped: string[] = [];
  let written = 0;

  try {
    await ctx.progress(10, "fetching overview");
    const overview = await meter(ctx.platform, ctx.workspaceId, { ...meta, task: "analytics.revenuecat.overview" }, () => rc.overview(secret.projectId, { currency: secret.currency }));
    const fetchedAt = nowIso();
    for (const m of overview.data.metrics ?? []) {
      const def = RC_OVERVIEW_METRICS[m.id];
      const days = parsePeriodDays(m.period ?? "");
      if (!def || days === null || typeof m.value !== "number" || !Number.isFinite(m.value)) {
        unmapped.push(`${m.id}${m.period ? ` (${m.period})` : ""}`);
        continue;
      }
      const updatedMs = typeof m.last_updated_at === "number" ? rcTimestampMs(m.last_updated_at) : m.last_updated_at_iso8601 ? Date.parse(m.last_updated_at_iso8601.replace(" ", "T").replace(/\.(\d{3})\d*/, ".$1")) : Date.now();
      const end = Number.isFinite(updatedMs) ? updatedMs : Date.now();
      const start = days === 0 ? end : end - days * DAY_MS;
      const currency = def.unit === "currency" ? (overview.data.currency ?? secret.currency) : undefined;
      await upsertObservation(
        ctx.ws,
        {
          ...base,
          metric: def.metric,
          metricDefinition: `${def.definition}${days > 0 ? ` Window: trailing ${days} days ending ${new Date(end).toISOString()}.` : ""}`.slice(0, 500),
          value: m.value,
          unit: def.unit,
          currency,
          windowStart: new Date(start).toISOString(),
          windowEnd: new Date(end).toISOString(),
          provenance: { imported: false, apiRequestId: overview.requestId, fetchedAt },
          scope: `revenuecat:${secret.projectId}:${def.metric}:${days === 0 ? "snapshot" : `P${days}D`}:${currency ?? "*"}`,
          dedupWindow: `${isoDay(end)}`,
        },
        ctx.actor,
      );
      written++;
    }

    const lastSyncMs = account.lastSyncAt ? Date.parse(account.lastSyncAt) : NaN;
    const startMs = since ? Date.parse(since) : Number.isFinite(lastSyncMs) ? lastSyncMs - 3 * DAY_MS : Date.now() - 90 * DAY_MS;
    const startDate = isoDay(startMs);
    const endDate = isoDay(Date.now());
    for (const [i, spec] of RC_DAILY_CHARTS.entries()) {
      ctx.throwIfCancelled();
      await ctx.progress(30 + i * 15, `fetching ${spec.chart} chart`);
      let chart;
      try {
        chart = await meter(ctx.platform, ctx.workspaceId, { ...meta, task: `analytics.revenuecat.chart.${spec.chart}` }, () =>
          rc.chart(secret.projectId, spec.chart, { resolution: "0", startDate, endDate, currency: spec.unit === "currency" ? secret.currency : undefined }),
        );
      } catch (err) {
        const e = toAppError(err);
        if (e.code === "PROVIDER_NOT_CONFIGURED" && e.message.includes("permission")) {
          skipped.push(`${spec.chart}: key lacks charts_metrics:charts:read`);
          continue;
        }
        if (e.code === "PROVIDER_ERROR" || e.code === "NOT_FOUND") {
          skipped.push(`${spec.chart}: ${e.message.slice(0, 160)}`);
          continue;
        }
        throw e;
      }
      if (chart.data.resolution && chart.data.resolution !== "day") {
        skipped.push(`${spec.chart}: returned resolution "${chart.data.resolution}", expected day`);
        continue;
      }
      const parsed = parseChartPoints(chart.data, spec.measureHint);
      if (parsed.unrecognised) skipped.push(`${spec.chart}: ${parsed.unrecognised} values in an unrecognised format were ignored`);
      const fetchedAtChart = nowIso();
      const currency = spec.unit === "currency" ? (chart.data.yaxis_currency ?? secret.currency) : undefined;
      const measureName = chart.data.measures?.[parsed.measureIndex]?.display_name;
      const definition = chart.data.description
        ? `RevenueCat ${chart.data.display_name ?? spec.chart} chart${measureName ? ` (${measureName})` : ""}: ${chart.data.description} Per UTC day.`
        : spec.fallbackDefinition;
      for (const pt of parsed.points) {
        const start = pt.startMs;
        await upsertObservation(
          ctx.ws,
          {
            ...base,
            metric: spec.metric,
            metricDefinition: definition.slice(0, 500),
            value: pt.value,
            unit: spec.unit,
            currency,
            windowStart: new Date(start).toISOString(),
            windowEnd: new Date(start + DAY_MS).toISOString(),
            provenance: { imported: false, apiRequestId: chart.requestId, fetchedAt: fetchedAtChart },
            scope: `revenuecat:${secret.projectId}:${spec.metric}:day:${currency ?? "*"}`,
          },
          ctx.actor,
        );
        written++;
      }
    }
  } catch (err) {
    const e = toAppError(err);
    if (e.code === "PROVIDER_NOT_CONFIGURED" || e.code === "NOT_FOUND") {
      await accounts.update(account.id, { status: "error", lastError: (e.opts.userMessage ?? e.message).slice(0, 1000) }, { actor: ctx.actor });
      throw new AppError(e.code === "NOT_FOUND" ? "PROVIDER_ERROR" : e.code, e.message, { retryable: false, userMessage: e.opts.userMessage, details: e.opts.details });
    }
    await accounts.update(account.id, { lastError: `Sync failed: ${e.message}`.slice(0, 1000) }, { actor: ctx.actor });
    throw e;
  }

  const notes = [...(unmapped.length ? [`Skipped RevenueCat metrics MuseLaunch doesn't map yet: ${unmapped.join(", ")}`] : []), ...skipped];
  await accounts.update(account.id, { lastSyncAt: nowIso(), lastError: notes.length ? notes.join("; ").slice(0, 1000) : undefined, status: "connected" }, { actor: ctx.actor });
  await ctx.progress(100, "done");
  return { refs: [{ entity: "connectedAccounts", id: account.id }], data: { observations: written, unmapped, skipped }, creditsUsed: 0 };
};
