import { fillAppLink, type ScheduledPost } from "@muselaunch/contracts";
import { nowIso } from "@muselaunch/db";
import { AppError, assertKeyInWorkspace, toAppError, trackedLinkUrl, type JobContext, type JobResult, type Platform } from "@muselaunch/platform";
import { HttpClient, publishingAdapterForChannel, type PublishMedia } from "@muselaunch/providers";
import { assertApproved, consumeApproval, postSnapshot } from "../approvals";
import { freshTokens } from "../connections";
import { growthDeps } from "../deps";
import { manualInstructions } from "./manual";
import { preflight, publicationIdFor } from "./posts";

// ---------------------------------------------------------------------------
// Adapter resume state
// ---------------------------------------------------------------------------

/**
 * SECURITY: some resume state is a bearer capability, not just bookkeeping. A YouTube resumable
 * session URI or a TikTok `upload_url` accepts the media bytes for the pending post without any
 * OAuth token, so anyone holding it could swap the video that is about to be published. `publishState`
 * is part of the post document that every workspace member (viewers included) reads through the API,
 * so such values are kept in the encrypted SecretStore and the document only holds a marker.
 */
export const SEALED_STATE_VALUE = "[sealed]";
const isCapabilityKey = (k: string) => /(url|uri|token|secret)$/i.test(k);
export const publishStateSecretId = (postId: string) => `pubstate_${postId}`;

/** Merge sealed values back. A marker without its secret (or a reset publishState) resolves to "absent". */
export async function loadPublishState(p: Platform, wid: string, post: ScheduledPost): Promise<Record<string, unknown>> {
  const state: Record<string, unknown> = { ...(post.publishState ?? {}) };
  const sealedKeys = Object.keys(state).filter((k) => state[k] === SEALED_STATE_VALUE);
  if (!sealedKeys.length) return state;
  const sealed = await p.secrets.get<Record<string, unknown>>(wid, publishStateSecretId(post.id)).catch(() => null);
  for (const k of sealedKeys) {
    if (sealed && sealed[k] !== undefined) state[k] = sealed[k];
    else delete state[k];
  }
  return state;
}

/** Split state into the visible document (with markers) and the encrypted secret. */
export async function sealPublishState(p: Platform, wid: string, postId: string, state: Record<string, unknown>, previous?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const visible: Record<string, unknown> = {};
  const sealed: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(state)) {
    if (typeof v === "string" && isCapabilityKey(k)) {
      sealed[k] = v;
      visible[k] = SEALED_STATE_VALUE;
    } else visible[k] = v;
  }
  if (Object.keys(sealed).length) await p.secrets.put(wid, publishStateSecretId(postId), "publish_state", sealed);
  else if (Object.values(previous ?? {}).includes(SEALED_STATE_VALUE)) await p.secrets.delete(wid, publishStateSecretId(postId));
  return visible;
}

/**
 * `publish.post`: publish an approved post through the channel's API adapter.
 * - Re-verifies the approval against the CURRENT snapshot (stale → APPROVAL_REQUIRED, never posts).
 * - A post becomes `published` only with a Publication carrying the provider's remote id/receipt.
 * - If the API path is unavailable at run time, the post moves to `manual_post_needed` (honest fallback).
 * - Adapter resume state is persisted before each non-idempotent step so retries never double-post.
 */
export async function publishPostHandler(ctx: JobContext<"publish.post">): Promise<JobResult> {
  const { ws, payload } = ctx;
  const p = ctx.platform;
  const deps = growthDeps(p);
  const post = await ws.collection("scheduledPosts").getOrThrow(payload.scheduledPostId);
  const ref = { entity: "scheduledPosts", id: post.id };
  if (post.status === "published" && post.publicationId) return { refs: [ref, { entity: "publications", id: post.publicationId }], data: { alreadyPublished: true } };
  if (post.status === "manually_posted" || post.status === "cancelled") throw new AppError("CONFLICT", `Post is ${post.status}`, { retryable: false });

  const fail = async (err: AppError): Promise<never> => {
    await ws.collection("scheduledPosts").update(post.id, { status: "failed", lastError: (err.toInfo().userMessage ?? err.message).slice(0, 2000) }, { actor: ctx.actor });
    throw err;
  };

  if (post.approvalId !== payload.approvalId) return fail(new AppError("APPROVAL_REQUIRED", "Job approval does not match the post's current approval", { retryable: false }));
  const { hash } = await postSnapshot(ws, post);
  let approval;
  try {
    approval = await assertApproved(ws, { approvalId: payload.approvalId, action: "publish", subject: ref, hash });
  } catch (err) {
    return fail(toAppError(err));
  }

  const adapter = publishingAdapterForChannel(post.channel);
  const account = post.accountId ? await ws.collection("connectedAccounts").get(post.accountId) : null;
  const creds = adapter ? deps.settings.creds[adapter.provider] : undefined;
  const unavailable =
    post.mode !== "api"
      ? "This post is set to manual posting."
      : !adapter?.publish
        ? `${post.channel} has no API adapter.`
        : !creds
          ? `${adapter.label} API isn't configured on this deployment.`
          : !account || account.provider !== adapter.provider
            ? `No ${adapter.label} account is connected for this post.`
            : account.status !== "connected"
              ? `${adapter.label} connection is ${account.status}.`
              : undefined;
  if (unavailable) {
    // Same approved content, posted by the user: the approval stays valid for "Mark as posted".
    await ws.collection("scheduledPosts").update(post.id, { status: "manual_post_needed", manualInstructions: manualInstructions(post.channel, unavailable), lastError: unavailable }, { actor: ctx.actor });
    await ctx.log_event(`Not published via API: ${unavailable} Moved to manual posting.`, ref);
    return { refs: [ref], data: { mode: "manual", reason: unavailable } };
  }

  const pf = await preflight(ws, post);
  if (pf.errors.length) return fail(new AppError("VALIDATION_FAILED", pf.errors.join(" "), { retryable: false, userMessage: pf.errors[0] }));

  await ctx.progress(5, "authorising");
  let tokens;
  try {
    tokens = await freshTokens(p, ws, account!, ctx.actor);
  } catch (raw) {
    const err = toAppError(raw);
    if (err.retryable && ctx.job.attempts < ctx.job.maxAttempts) throw err;
    return fail(err);
  }

  const assets = await ws.collection("mediaAssets").getMany(post.assetIds);
  const primary = assets[0];
  let media: PublishMedia | undefined;
  if (primary) {
    assertKeyInWorkspace(ctx.workspaceId, primary.storagePath);
    const ext = primary.mimeType.split("/")[1] ?? "bin";
    media = {
      kind: primary.kind === "video" ? "video" : "image",
      mimeType: primary.mimeType,
      bytes: primary.bytes,
      filename: `${post.id}.${ext}`,
      read: async () => p.storage.get(primary.storagePath),
      publicUrl: async () => (await p.storage.signedDownloadUrl(primary.storagePath, { expiresSec: 3600 })).url,
    };
  }

  // [APP_LINK] in generated copy becomes this post's tracked link (preflight blocks API posts without one).
  const link = post.trackingLinkId ? await ws.collection("attributionLinks").get(post.trackingLinkId) : null;
  const trackingUrl = link ? trackedLinkUrl(p.cfg, link.slug) : undefined;
  const state = await loadPublishState(p, ctx.workspaceId, post);
  let visibleState: Record<string, unknown> = { ...(post.publishState ?? {}) };
  const saveState = async (patch: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) delete state[k];
      else state[k] = v;
    }
    visibleState = await sealPublishState(p, ctx.workspaceId, post.id, state, visibleState);
    await ws.collection("scheduledPosts").update(post.id, { publishState: visibleState }, { actor: ctx.actor });
  };
  await ws.collection("scheduledPosts").update(post.id, { status: "publishing" }, { actor: ctx.actor });
  await ctx.progress(15, "uploading", adapter!.label);

  let result;
  try {
    result = await adapter!.publish!(
      { media, title: post.title && fillAppLink(post.title, trackingUrl), caption: fillAppLink(post.caption, trackingUrl), tags: post.tags, visibility: post.visibility, containsSyntheticMedia: post.containsSyntheticMedia, scheduledAt: post.scheduledAt },
      {
        http: new HttpClient(deps.fetch, adapter!.label),
        tokens,
        externalAccountId: account!.externalAccountId,
        settings: deps.settings.adapter,
        creds: creds!,
        state,
        saveState,
        sleep: deps.sleep,
        signal: ctx.signal,
        maxPolls: deps.settings.publishMaxPolls,
        pollIntervalMs: deps.settings.publishPollIntervalMs,
      },
    );
  } catch (raw) {
    const err = toAppError(raw);
    if (err.code === "CANCELLED") {
      await ws.collection("scheduledPosts").update(post.id, { status: "failed", lastError: "Cancelled while publishing. Check the channel before retrying: part of the upload may have reached it." }, { actor: ctx.actor });
      throw err;
    }
    if ((err.opts.details as { reconnect?: boolean } | undefined)?.reconnect) await ws.collection("connectedAccounts").update(account!.id, { status: "expired", lastError: err.message.slice(0, 1000) }, { actor: ctx.actor });
    if (err.retryable && ctx.job.attempts < ctx.job.maxAttempts) {
      await ws.collection("scheduledPosts").update(post.id, { lastError: `Retrying: ${err.message}`.slice(0, 2000) }, { actor: ctx.actor });
      throw err;
    }
    return fail(err);
  }
  if (!result?.remoteId) return fail(new AppError("PROVIDER_ERROR", "Provider returned no remote id; not marking as published", { retryable: false }));

  await ctx.progress(95, "recording");
  const { entity: publication } = await ws.collection("publications").createIfAbsent(
    {
      id: publicationIdFor(post.id),
      appId: post.appId,
      campaignId: post.campaignId,
      scheduledPostId: post.id,
      channel: post.channel,
      mode: "api",
      remoteId: result.remoteId.slice(0, 300),
      remoteUrl: result.remoteUrl,
      publishedAt: nowIso(),
      receipt: { provider: adapter!.provider, accountId: account!.id, externalAccountId: account!.externalAccountId, ...result.receipt, effectiveVisibility: result.effectiveVisibility, notes: result.notes, approvalId: approval.id, jobId: ctx.job.id },
    },
    { actor: ctx.actor },
  );
  const patch: Partial<ScheduledPost> = { status: "published", publicationId: publication.id, lastError: undefined };
  await ws.collection("scheduledPosts").update(post.id, patch, { actor: ctx.actor });
  // The upload session is finished: drop any sealed capability URLs.
  if (Object.values(visibleState).includes(SEALED_STATE_VALUE)) await p.secrets.delete(ctx.workspaceId, publishStateSecretId(post.id)).catch(() => {});
  await consumeApproval(ws, approval.id, ctx.actor, `Published ${adapter!.label} ${result.remoteId}`);
  await ctx.log_event(`Published to ${adapter!.label}: ${result.remoteUrl ?? result.remoteId}`, { entity: "publications", id: publication.id });
  return { refs: [ref, { entity: "publications", id: publication.id }], data: { remoteId: result.remoteId, remoteUrl: result.remoteUrl, effectiveVisibility: result.effectiveVisibility } };
}
