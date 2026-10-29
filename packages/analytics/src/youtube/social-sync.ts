import type { ConnectedAccount, Publication } from "@muselaunch/contracts";
import { nowIso } from "@muselaunch/db";
import { freshTokens } from "@muselaunch/growth";
import { AppError, toAppError, type JobContext, type JobResult } from "@muselaunch/platform";
import { socialInsightsAdapter, youtubeVideoIdFromUrl, type SocialInsightsRequest } from "@muselaunch/providers";
import { METRIC_INFO } from "../metrics";
import { upsertObservation } from "../observations";
import { youtubeFetchFor } from "./channel";

/** Publications read per sync (newest first). */
export const MAX_POSTS_PER_SYNC = 50;

/** Connections whose posts' insights MuseLaunch can sync (a registered social insights adapter). */
export function hasSocialInsights(account: Pick<ConnectedAccount, "provider">): boolean {
  return Boolean(socialInsightsAdapter(account.provider));
}

function belongsToChannel(pub: Publication, provider: string): boolean {
  if (pub.channel !== provider) return false;
  if (provider === "youtube") return Boolean((pub.remoteId && /^[A-Za-z0-9_-]{11}$/.test(pub.remoteId)) || youtubeVideoIdFromUrl(pub.remoteUrl));
  return Boolean(pub.remoteId);
}

/**
 * `analytics.sync` for a social connection (YouTube): per-post insights of the app's publications on
 * that channel, stored as platform-reported observations (one lifetime-to-date value per post and
 * metric, replaced on every sync). Videos on another channel are skipped, never attributed.
 */
export async function syncSocialInsights(ctx: JobContext<"analytics.sync">, account: ConnectedAccount): Promise<JobResult> {
  const p = ctx.platform;
  const { appId } = ctx.payload;
  const adapter = socialInsightsAdapter(account.provider);
  if (!adapter) throw new AppError("PROVIDER_NOT_CONFIGURED", `No insights adapter for ${account.provider}`, { retryable: false });
  const accounts = ctx.ws.collection("connectedAccounts");
  if (account.status !== "connected") throw new AppError("PROVIDER_NOT_CONFIGURED", `${account.provider} connection is ${account.status}`, { retryable: false, userMessage: "Reconnect YouTube to sync its stats." });

  await ctx.progress(5, "connecting");
  const tokens = await freshTokens(p, ctx.ws, account, ctx.actor);
  const pubs = (await ctx.ws.collection("publications").list({ where: [["appId", "==", appId]], orderBy: { field: "createdAt", dir: "desc" }, limit: 200 })).items.filter((x) => belongsToChannel(x, account.provider)).slice(0, MAX_POSTS_PER_SYNC);

  const notes = new Set<string>();
  const skipped: { publicationId: string; reason: string }[] = [];
  const pending: Promise<unknown>[] = [];
  let written = 0;
  let quotaUnits = 0;
  const meter = (r: SocialInsightsRequest) => {
    quotaUnits += r.quotaUnits ?? 0;
    pending.push(
      p.usage
        .record(ctx.workspaceId, {
          provider: "analytics",
          model: r.api === "YouTube Analytics API" ? "youtube-analytics-api-v2" : "youtube-data-api-v3",
          operation: "http",
          task: `analytics.${account.provider}.${r.method}`,
          appId,
          jobId: ctx.job.id,
          actor: ctx.actor,
          quotaUnits: r.quotaUnits,
          runtimeMs: r.ms,
          costUsdEstimate: 0,
          status: r.status,
          errorCode: r.errorCode,
          dataMode: "third_party",
        })
        .catch(() => undefined),
    );
  };

  try {
    for (const [i, pub] of pubs.entries()) {
      ctx.throwIfCancelled();
      await ctx.progress(10 + (i / Math.max(pubs.length, 1)) * 85, "fetching", `Post ${i + 1} of ${pubs.length}`);
      try {
        const insights = await adapter.fetchPostInsights({ account, accessToken: tokens.accessToken, publication: pub, signal: ctx.signal, fetch: youtubeFetchFor(p), onRequest: meter, onNote: (n) => notes.add(n) });
        const fetchedAt = nowIso();
        for (const ins of insights) {
          await upsertObservation(
            ctx.ws,
            {
              appId,
              campaignId: pub.campaignId,
              publicationId: pub.id,
              source: "youtube",
              connectionId: account.id,
              externalAccountId: account.externalAccountId,
              metric: ins.metric,
              metricDefinition: ins.definition.slice(0, 500),
              value: ins.value,
              unit: METRIC_INFO[ins.metric].unit,
              windowStart: ins.windowStart,
              windowEnd: ins.windowEnd,
              timezone: "UTC",
              channel: "youtube",
              attribution: "platform_reported",
              provenance: { imported: false, apiRequestId: ins.apiRequestId, fetchedAt },
              scope: `${account.provider}:${account.externalAccountId}:${pub.id}:${ins.metric}`,
              // One lifetime-to-date value per post and metric: each sync replaces it (never added up).
              dedupWindow: "lifetime",
            },
            ctx.actor,
          );
          written++;
        }
      } catch (raw) {
        const err = toAppError(raw);
        // Per-post problems (deleted video, video on another channel) skip that post only.
        if (err.code === "NOT_FOUND" || err.code === "BAD_REQUEST") {
          skipped.push({ publicationId: pub.id, reason: (err.toInfo().userMessage ?? err.message).slice(0, 200) });
          continue;
        }
        throw err;
      }
    }
  } catch (raw) {
    await Promise.allSettled(pending);
    const err = toAppError(raw);
    const details = err.opts.details as { reconnect?: boolean } | undefined;
    if (details?.reconnect) await accounts.update(account.id, { status: "expired", lastError: (err.toInfo().userMessage ?? err.message).slice(0, 1000) }, { actor: ctx.actor });
    else if (!err.retryable) await accounts.update(account.id, { lastError: `Sync failed: ${err.toInfo().userMessage ?? err.message}`.slice(0, 1000) }, { actor: ctx.actor });
    throw err;
  }
  await Promise.allSettled(pending);
  const summary = [...notes, ...skipped.map((s) => `Skipped a post: ${s.reason}`)];
  if (!pubs.length) summary.unshift("No posts on this channel from this app yet.");
  await accounts.update(account.id, { lastSyncAt: nowIso(), lastError: summary.length ? summary.join(" ").slice(0, 1000) : undefined }, { actor: ctx.actor });
  p.log.info({ workspaceId: ctx.workspaceId, appId, provider: account.provider, quotaUnits, posts: pubs.length }, "social insights synced");
  await ctx.progress(100, "done");
  return { refs: [{ entity: "connectedAccounts", id: account.id }], data: { observations: written, posts: pubs.length, skipped, notes: [...notes], quotaUnits }, creditsUsed: 0 };
}
