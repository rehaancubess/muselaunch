import { Channel, HttpUrl, Id, IsoDateTime, APP_LINK_TOKEN, fillAppLink, type Approval, type ConnectedAccount, type CopyPack, type MediaAsset, type Publication, type ScheduledPost } from "@muselaunch/contracts";
import { nowIso, type WorkspaceDb } from "@muselaunch/db";
import { AppError, assertKeyInWorkspace, trackedLinkUrl, type Platform } from "@muselaunch/platform";
import { MANUAL_ONLY_CHANNELS, providerAdapter, publishingAdapterForChannel } from "@muselaunch/providers";
import { z } from "zod";
import { assertApproved, consumeApproval, expireApprovals, postSnapshot, requestApproval } from "../approvals";
import { growthDeps } from "../deps";
import { manualInstructions, POST_URL_HOSTS } from "./manual";

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export const CreatePostRequest = z
  .object({
    campaignId: Id,
    variantId: Id.optional(),
    compositionId: Id.optional(),
    compositionVersion: z.number().int().min(1).optional(),
    assetIds: z.array(Id).max(10).optional(),
    copyPackId: Id.optional(),
    channel: Channel,
    accountId: Id.optional(),
    title: z.string().max(300).optional(),
    caption: z.string().max(5000).optional(),
    tags: z.array(z.string().max(100)).max(50).optional(),
    visibility: z.enum(["public", "unlisted", "private"]).default("public"),
    containsSyntheticMedia: z.boolean().optional(),
    thumbnailAssetId: Id.optional(),
    trackingLinkId: Id.optional(),
    scheduledAt: IsoDateTime.optional(),
    timezone: z.string().max(64).optional(),
    suggestedTimeReason: z.string().max(500).optional(),
  })
  .refine((v) => v.compositionId || v.assetIds?.length, { message: "Provide compositionId (rendered) or assetIds" });
export type CreatePostRequest = z.infer<typeof CreatePostRequest>;

export const UpdatePostRequest = z.object({
  title: z.string().max(300).nullable().optional(),
  caption: z.string().max(5000).optional(),
  tags: z.array(z.string().max(100)).max(50).optional(),
  visibility: z.enum(["public", "unlisted", "private"]).optional(),
  containsSyntheticMedia: z.boolean().optional(),
  accountId: Id.nullable().optional(),
  assetIds: z.array(Id).min(1).max(10).optional(),
  thumbnailAssetId: Id.nullable().optional(),
  trackingLinkId: Id.nullable().optional(),
  scheduledAt: IsoDateTime.nullable().optional(),
  timezone: z.string().max(64).optional(),
});

export const MarkPostedRequest = z.object({ url: HttpUrl, postedAt: IsoDateTime.optional(), note: z.string().max(500).optional() });
export const ReminderRequest = z.object({ at: IsoDateTime.nullable() });

const TERMINAL: ScheduledPost["status"][] = ["published", "manually_posted", "cancelled"];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function loadPost(ws: WorkspaceDb, id: string, appId?: string): Promise<ScheduledPost> {
  const post = await ws.collection("scheduledPosts").getOrThrow(id);
  if (appId && post.appId !== appId) throw new AppError("NOT_FOUND", "Post not found");
  return post;
}

/** Final render of a composition (exact version if given, otherwise the newest final render). */
async function renderAssetFor(ws: WorkspaceDb, appId: string, compositionId: string, version?: number): Promise<MediaAsset> {
  const comp = await ws.collection("compositions").getOrThrow(compositionId);
  if (comp.appId !== appId) throw new AppError("NOT_FOUND", "Composition not found");
  const renders = (await ws.collection("mediaAssets").list({ where: [["appId", "==", appId], ["role", "==", "render"]], orderBy: { field: "createdAt", dir: "desc" }, limit: 200 })).items.filter(
    (a) => a.render?.compositionId === compositionId && a.render.quality === "final" && a.status === "ready" && (version === undefined || a.render.version === version),
  );
  const hit = renders.sort((a, b) => (b.render!.version - a.render!.version) || b.createdAt.localeCompare(a.createdAt))[0];
  if (!hit) throw new AppError("CONFLICT", `No final render${version ? ` of version ${version}` : ""} for this composition`, { userMessage: "Render the final video first, then schedule it." });
  return hit;
}

function captionFromCopyPack(pack: CopyPack, channel: Channel): { title?: string; caption?: string; tags: string[] } {
  const first = (k: string) => pack.items.find((i) => i.kind === k)?.text;
  const hashtagsText = first("hashtags") ?? "";
  const tags = [...hashtagsText.matchAll(/#?([\p{L}\p{N}_]{2,})/gu)].map((m) => m[1]!).slice(0, 30);
  let caption = first("caption") ?? first("description");
  if (caption && hashtagsText && !/#\w/.test(caption) && channel !== "youtube") caption = `${caption}\n\n${hashtagsText.trim()}`;
  return { title: first("title"), caption, tags };
}

/** X weighted length (twitter-text v3: most Latin = 1, CJK/emoji = 2, URLs = 23). */
export function xWeightedLength(text: string): number {
  let n = 0;
  const withoutUrls = text.replace(/https?:\/\/\S+/g, () => {
    n += 23;
    return "";
  });
  for (const ch of withoutUrls) {
    const cp = ch.codePointAt(0)!;
    n += cp <= 4351 || (cp >= 8192 && cp <= 8205) || (cp >= 8208 && cp <= 8223) || (cp >= 8242 && cp <= 8247) ? 1 : 2;
  }
  return n;
}

export interface Preflight {
  errors: string[];
  warnings: string[];
}

/** Channel rules checked before approval is requested and again before publishing. */
export async function preflight(ws: WorkspaceDb, post: ScheduledPost): Promise<Preflight> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const assets = await ws.collection("mediaAssets").getMany(post.assetIds);
  if (assets.length !== post.assetIds.length) errors.push("One or more media files are missing.");
  for (const a of assets) if (!["ready", "uploaded"].includes(a.status)) errors.push(`${a.title ?? a.originalFilename ?? a.id} is ${a.status}.`);
  const primary = assets[0];
  const isVideo = primary?.kind === "video";
  const cap = post.caption;
  const api = post.mode === "api";
  // Generated copy uses [APP_LINK] where a link belongs; it's filled from the post's tracked link.
  if ((cap.includes(APP_LINK_TOKEN) || post.title?.includes(APP_LINK_TOKEN)) && !post.trackingLinkId) {
    (api ? errors : warnings).push(`The copy still has the ${APP_LINK_TOKEN} placeholder. Add a tracked link to this post, or replace the placeholder with your link.`);
  }
  switch (post.channel) {
    case "youtube":
      if (!isVideo) errors.push("YouTube needs a video.");
      if (!post.title?.trim()) errors.push("YouTube needs a title.");
      if ((post.title ?? "").length > 100) errors.push("YouTube titles are limited to 100 characters.");
      if (Buffer.byteLength(cap, "utf8") > 5000) errors.push("YouTube descriptions are limited to 5,000 bytes.");
      break;
    case "instagram":
      if (!primary) errors.push("Instagram posts need an image or video.");
      if (cap.length > 2200) errors.push("Instagram captions are limited to 2,200 characters.");
      if ((cap.match(/#[\p{L}\p{N}_]+/gu) ?? []).length > 30) errors.push("Instagram allows at most 30 hashtags.");
      if (api && post.visibility !== "public") errors.push("Instagram API posts are always public.");
      if (api && primary?.kind === "image" && !/jpe?g$/i.test(primary.mimeType)) errors.push("Instagram API publishing accepts JPEG images only.");
      break;
    case "tiktok":
      if (!isVideo) errors.push("TikTok needs a video.");
      if (cap.length > 2200) errors.push("TikTok captions are limited to 2,200 characters.");
      if (post.visibility === "unlisted") errors.push("TikTok has no unlisted visibility.");
      break;
    case "x": {
      const len = xWeightedLength(cap);
      if (len > 280) (api ? errors : warnings).push(`Post is ${len}/280 characters (longer posts need X Premium).`);
      if (post.visibility !== "public") errors.push("Posts on X are public.");
      break;
    }
    case "linkedin":
      if (cap.length > 3000) errors.push("LinkedIn posts are limited to 3,000 characters.");
      if (api && primary && !isVideo) errors.push("LinkedIn API publishing here supports video or text-only posts.");
      break;
    case "facebook":
      if (api && !isVideo) errors.push("Facebook Page API publishing here supports videos.");
      break;
    default:
      break;
  }
  if (assets.some((a) => a.origin === "generated") && !post.containsSyntheticMedia) warnings.push("This post includes AI-generated media; we recommend enabling the synthetic-media disclosure.");
  if (api) {
    const acc = post.accountId ? await ws.collection("connectedAccounts").get(post.accountId) : null;
    if (!acc || acc.status !== "connected") errors.push("The selected account isn't connected. Reconnect it or switch to manual posting.");
    for (const l of acc?.limitations ?? []) warnings.push(l);
  }
  if (post.copyPackId) {
    const pack = await ws.collection("copyPacks").get(post.copyPackId);
    if (pack?.validation && !pack.validation.ok) errors.push(`The copy pack failed claim validation: ${pack.validation.issues.map((i) => i.issue).join("; ").slice(0, 300)}`);
  }
  if (post.scheduledAt && Date.parse(post.scheduledAt) < Date.now() - 5 * 60_000 && post.status !== "published") warnings.push("The scheduled time is in the past; it will publish as soon as it's approved and started.");
  return { errors, warnings };
}

/** Decide api vs manual for a channel/account, with the reason when manual. */
async function resolveMode(p: Platform, ws: WorkspaceDb, channel: Channel, accountId?: string): Promise<{ mode: "api" | "manual"; account?: ConnectedAccount; reason?: string }> {
  if (MANUAL_ONLY_CHANNELS.includes(channel)) return { mode: "manual", reason: channel === "reddit" ? "Community posts are never automated." : `${channel} has no supported posting API.` };
  const adapter = publishingAdapterForChannel(channel);
  if (!adapter) return { mode: "manual", reason: `${channel} publishing isn't supported via API.` };
  if (!growthDeps(p).settings.creds[adapter.provider]) return { mode: "manual", reason: `${adapter.label} API isn't configured on this deployment (needs ${adapter.env.clientId}).` };
  if (!accountId) return { mode: "manual", reason: `No ${adapter.label} account selected.` };
  const acc = await ws.collection("connectedAccounts").get(accountId);
  if (!acc || acc.provider !== adapter.provider) throw new AppError("BAD_REQUEST", `Account ${accountId} is not a ${adapter.label} connection`);
  if (acc.status !== "connected") return { mode: "manual", account: acc, reason: `${adapter.label} connection is ${acc.status}.` };
  if (!acc.capabilities.some((c) => c.startsWith("publish_"))) return { mode: "manual", account: acc, reason: `${adapter.label} connection can't publish.` };
  return { mode: "api", account: acc };
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export async function createPost(p: Platform, wid: string, appId: string, input: CreatePostRequest, actor: string): Promise<{ post: ScheduledPost; preflight: Preflight }> {
  const ws = p.db.ws(wid);
  const campaign = await ws.collection("campaigns").getOrThrow(input.campaignId);
  if (campaign.appId !== appId) throw new AppError("NOT_FOUND", "Campaign not found");
  let assetIds = input.assetIds ?? [];
  let compositionVersion = input.compositionVersion;
  if (input.compositionId) {
    const render = await renderAssetFor(ws, appId, input.compositionId, input.compositionVersion);
    compositionVersion = render.render!.version;
    assetIds = [render.id, ...assetIds.filter((x) => x !== render.id)];
  }
  const assets = await ws.collection("mediaAssets").getMany(assetIds);
  if (assets.length !== assetIds.length || assets.some((a) => a.appId && a.appId !== appId)) throw new AppError("NOT_FOUND", "Asset not found");
  if (input.thumbnailAssetId) await ws.collection("mediaAssets").getOrThrow(input.thumbnailAssetId);
  if (input.trackingLinkId) {
    const link = await ws.collection("attributionLinks").getOrThrow(input.trackingLinkId);
    if (link.appId !== appId) throw new AppError("NOT_FOUND", "Tracking link not found");
  }
  let fromPack: ReturnType<typeof captionFromCopyPack> = { tags: [] };
  if (input.copyPackId) {
    const pack = await ws.collection("copyPacks").getOrThrow(input.copyPackId);
    if (pack.appId !== appId) throw new AppError("NOT_FOUND", "Copy pack not found");
    fromPack = captionFromCopyPack(pack, input.channel);
  }
  const caption = input.caption ?? fromPack.caption;
  if (caption === undefined) throw new AppError("BAD_REQUEST", "Provide a caption or a copy pack", { userMessage: "Add a caption (or pick a copy pack) for this post." });
  const mode = await resolveMode(p, ws, input.channel, input.accountId);
  const post = await ws.collection("scheduledPosts").create(
    {
      appId,
      campaignId: input.campaignId,
      variantId: input.variantId,
      compositionId: input.compositionId,
      compositionVersion,
      assetIds,
      channel: input.channel,
      accountId: mode.account?.id ?? input.accountId,
      mode: mode.mode,
      title: input.title ?? fromPack.title,
      caption,
      tags: input.tags ?? fromPack.tags,
      copyPackId: input.copyPackId,
      visibility: input.visibility,
      containsSyntheticMedia: input.containsSyntheticMedia ?? assets.some((a) => a.origin === "generated"),
      thumbnailAssetId: input.thumbnailAssetId,
      trackingLinkId: input.trackingLinkId,
      scheduledAt: input.scheduledAt,
      timezone: input.timezone ?? (await p.db.top("workspaces").get(wid))?.settings.defaultTimezone ?? "UTC",
      suggestedTimeReason: input.suggestedTimeReason,
      status: "draft",
      manualInstructions: mode.mode === "manual" ? manualInstructions(input.channel, mode.reason) : [],
      attempts: 0,
    },
    { actor },
  );
  return { post, preflight: await preflight(ws, post) };
}

/** Edit a post. Content changes invalidate any pending/granted approval (back to draft). */
export async function updatePost(p: Platform, wid: string, id: string, input: z.infer<typeof UpdatePostRequest>, actor: string): Promise<{ post: ScheduledPost; approvalReset: boolean; preflight: Preflight }> {
  const ws = p.db.ws(wid);
  const post = await loadPost(ws, id);
  if (TERMINAL.includes(post.status) || post.status === "publishing") throw new AppError("CONFLICT", `Post is ${post.status}`);
  const patch: Partial<ScheduledPost> = {};
  for (const [k, v] of Object.entries(input)) (patch as Record<string, unknown>)[k] = v === null ? undefined : v;
  if (input.assetIds) {
    const assets = await ws.collection("mediaAssets").getMany(input.assetIds);
    if (assets.length !== input.assetIds.length || assets.some((a) => a.appId && a.appId !== post.appId)) throw new AppError("NOT_FOUND", "Asset not found");
  }
  if (input.trackingLinkId) {
    const link = await ws.collection("attributionLinks").getOrThrow(input.trackingLinkId);
    if (link.appId !== post.appId) throw new AppError("NOT_FOUND", "Tracking link not found");
  }
  if (input.accountId !== undefined) {
    const mode = await resolveMode(p, ws, post.channel, input.accountId ?? undefined);
    patch.mode = mode.mode;
    patch.accountId = mode.account?.id ?? input.accountId ?? undefined;
    patch.manualInstructions = mode.mode === "manual" ? manualInstructions(post.channel, mode.reason) : [];
  }
  const before = (await postSnapshot(ws, post)).hash;
  let next = await ws.collection("scheduledPosts").update(id, patch, { actor });
  const after = (await postSnapshot(ws, next)).hash;
  const contentChanged = before !== after;
  let approvalReset = false;
  if (contentChanged && post.approvalId) {
    approvalReset = (await expireApprovals(ws, { entity: "scheduledPosts", id }, post.appId, actor, "Post content changed")) > 0;
    next = await ws.collection("scheduledPosts").update(id, { status: "draft", approvalId: undefined, publishState: undefined, lastError: undefined }, { actor });
  }
  return { post: next, approvalReset, preflight: await preflight(ws, next) };
}

export async function requestPostApproval(p: Platform, wid: string, id: string, actor: string): Promise<{ post: ScheduledPost; approval: Approval; preflight: Preflight }> {
  const ws = p.db.ws(wid);
  const post = await loadPost(ws, id);
  if (!["draft", "awaiting_approval", "failed", "manual_post_needed", "scheduled"].includes(post.status)) throw new AppError("CONFLICT", `Post is ${post.status}`);
  const pf = await preflight(ws, post);
  if (pf.errors.length) throw new AppError("VALIDATION_FAILED", "Post can't be approved yet", { details: { errors: pf.errors }, userMessage: pf.errors[0] });
  const { hash } = await postSnapshot(ws, post);
  const acc = post.accountId ? await ws.collection("connectedAccounts").get(post.accountId) : null;
  const where = post.mode === "api" ? `${providerAdapter(acc?.provider ?? "youtube")?.label ?? post.channel} (${acc?.displayName ?? "account"}) via API` : `${post.channel} (you post it manually)`;
  const approval = await requestApproval(ws, {
    appId: post.appId,
    action: "publish",
    subject: { entity: "scheduledPosts", id: post.id },
    hash,
    summary: `Publish to ${where}: ${(post.title ?? post.caption).slice(0, 140)}${post.scheduledAt ? ` · scheduled ${post.scheduledAt}` : ""}`,
    actor,
  });
  const updated = await ws.collection("scheduledPosts").update(post.id, { status: approval.status === "approved" ? post.status : "awaiting_approval", approvalId: approval.id }, { actor });
  return { post: updated, approval, preflight: pf };
}

/** Called after an approval decision on a post. */
export async function onPostApprovalDecided(ws: WorkspaceDb, approval: Approval, actor: string): Promise<ScheduledPost | null> {
  if (approval.subject.entity !== "scheduledPosts") return null;
  const post = await ws.collection("scheduledPosts").get(approval.subject.id);
  if (!post || post.approvalId !== approval.id || TERMINAL.includes(post.status)) return post;
  if (approval.status === "approved") return ws.collection("scheduledPosts").update(post.id, { status: post.mode === "api" ? "scheduled" : "manual_post_needed" }, { actor });
  if (approval.status === "rejected") return ws.collection("scheduledPosts").update(post.id, { status: "draft", lastError: approval.note ? `Rejected: ${approval.note}` : "Approval rejected" }, { actor });
  return post;
}

/** Explicit "publish now" (or start a scheduled one early). Requires approval + `publish` capability (checked by the route). */
export async function enqueuePublish(p: Platform, wid: string, id: string, actor: string, opts: { system?: boolean } = {}) {
  const ws = p.db.ws(wid);
  const post = await loadPost(ws, id);
  if (post.status === "published" || post.status === "manually_posted") throw new AppError("CONFLICT", "Post is already published");
  if (post.status === "publishing") throw new AppError("CONFLICT", "Post is already being published");
  if (post.mode !== "api") throw new AppError("CONFLICT", "This post is set to manual posting", { userMessage: "This channel is posted manually: download the package and use “Mark as posted”." });
  const { hash } = await postSnapshot(ws, post);
  const approval = await assertApproved(ws, { approvalId: post.approvalId, action: "publish", subject: { entity: "scheduledPosts", id: post.id }, hash });
  const attempt = post.attempts + 1;
  const job = await p.jobs.create(wid, "publish.post", { scheduledPostId: post.id, approvalId: approval.id }, { actor: opts.system ? approval.decidedBy ?? actor : actor, appId: post.appId, idempotencyKey: `publish:${post.id}:${approval.id}:a${attempt}`, maxAttempts: 4 });
  const updated = await ws.collection("scheduledPosts").update(post.id, { status: "publishing", attempts: attempt, lastError: undefined }, { actor });
  return { post: updated, job };
}

export async function switchToManual(ws: WorkspaceDb, id: string, actor: string, reason = "Switched to manual posting"): Promise<ScheduledPost> {
  const post = await loadPost(ws, id);
  if (TERMINAL.includes(post.status) || post.status === "publishing") throw new AppError("CONFLICT", `Post is ${post.status}`);
  if (post.publishState && Object.keys(post.publishState).length && post.status === "failed") {
    // A failed API attempt may have partially reached the provider; keep the state for audit but make the user check.
    reason = `${reason}. A previous API attempt didn't complete: check the channel before posting again to avoid a duplicate.`;
  }
  const approved = post.approvalId ? await ws.collection("approvals").get(post.approvalId) : null;
  // Mode is part of the approved snapshot: switching invalidates the approval.
  await expireApprovals(ws, { entity: "scheduledPosts", id }, post.appId, actor, "Switched to manual posting");
  return ws.collection("scheduledPosts").update(id, { mode: "manual", status: "draft", approvalId: undefined, manualInstructions: manualInstructions(post.channel, reason), lastError: approved ? "Approval reset: request approval for manual posting" : undefined }, { actor });
}

export async function cancelPost(ws: WorkspaceDb, id: string, actor: string): Promise<ScheduledPost> {
  const post = await loadPost(ws, id);
  if (TERMINAL.includes(post.status)) throw new AppError("CONFLICT", `Post is ${post.status}`);
  if (post.status === "publishing") throw new AppError("CONFLICT", "Post is being published; wait for the result");
  await expireApprovals(ws, { entity: "scheduledPosts", id }, post.appId, actor, "Post cancelled");
  return ws.collection("scheduledPosts").update(id, { status: "cancelled", approvalId: undefined }, { actor });
}

/** Manual flow confirmation: the user posted it themselves and gives the live URL. Never yields `published`. */
export async function markPosted(p: Platform, wid: string, id: string, input: z.infer<typeof MarkPostedRequest>, actor: string): Promise<{ post: ScheduledPost; publication: Publication }> {
  const ws = p.db.ws(wid);
  const post = await loadPost(ws, id);
  if (post.status === "manually_posted" && post.publicationId) return { post, publication: await ws.collection("publications").getOrThrow(post.publicationId) };
  if (post.status === "published") throw new AppError("CONFLICT", "Post was already published via API");
  if (!["manual_post_needed", "failed"].includes(post.status)) throw new AppError("CONFLICT", `Post is ${post.status}; approve it for manual posting first`);
  const { hash } = await postSnapshot(ws, post);
  const approval = await assertApproved(ws, { approvalId: post.approvalId, action: "publish", subject: { entity: "scheduledPosts", id: post.id }, hash });
  const host = new URL(input.url).hostname.toLowerCase();
  const hosts = POST_URL_HOSTS[post.channel];
  if (hosts && !hosts.some((h) => host === h || host.endsWith(`.${h}`))) throw new AppError("BAD_REQUEST", `That link isn't a ${post.channel} URL`, { userMessage: `Paste the link of the ${post.channel} post.` });
  const publishedAt = input.postedAt ?? nowIso();
  const { entity: publication } = await ws.collection("publications").createIfAbsent(
    {
      id: publicationIdFor(post.id),
      appId: post.appId,
      campaignId: post.campaignId,
      scheduledPostId: post.id,
      channel: post.channel,
      mode: "manual_confirmed",
      remoteUrl: input.url,
      publishedAt,
      confirmedBy: actor,
      receipt: { confirmation: "user", note: input.note, approvalId: approval.id },
    },
    { actor },
  );
  const updated = await ws.collection("scheduledPosts").update(post.id, { status: "manually_posted", publicationId: publication.id, lastError: undefined }, { actor });
  await consumeApproval(ws, approval.id, actor, "Manually posted");
  return { post: updated, publication };
}

export const publicationIdFor = (postId: string) => `pub_${postId.replace(/^pst_/, "")}`;

export async function setReminder(ws: WorkspaceDb, id: string, at: string | null, actor: string) {
  const post = await loadPost(ws, id);
  if (TERMINAL.includes(post.status)) throw new AppError("CONFLICT", `Post is ${post.status}`);
  return ws.collection("scheduledPosts").update(id, { reminderAt: at ?? undefined }, { actor });
}

/** Signed download links for the post media (manual flow). */
export async function manualPackage(p: Platform, wid: string, id: string) {
  const ws = p.db.ws(wid);
  const post = await loadPost(ws, id);
  const assets = await ws.collection("mediaAssets").getMany([...post.assetIds, ...(post.thumbnailAssetId ? [post.thumbnailAssetId] : [])]);
  const downloads = [];
  for (const a of assets) {
    assertKeyInWorkspace(wid, a.storagePath);
    const ext = a.mimeType.split("/")[1]?.replace("quicktime", "mov").replace("jpeg", "jpg") ?? "bin";
    const filename = `${post.channel}-${a.role}-${a.id.slice(-6)}.${ext}`;
    const signed = await p.storage.signedDownloadUrl(a.storagePath, { expiresSec: 3600, downloadName: filename });
    downloads.push({ assetId: a.id, role: a.role, kind: a.kind, mimeType: a.mimeType, bytes: a.bytes, filename, ...signed });
  }
  let pkg: { jobId: string; status: string; assetId?: string; url?: string; expiresAt?: string; error?: string } | undefined;
  if (post.exportJobId) {
    const job = await p.jobs.get(wid, post.exportJobId);
    let assetId = post.packageAssetId;
    if (job?.status === "succeeded" && !assetId) {
      const ref = job.output?.refs.find((r) => r.entity === "mediaAssets");
      if (ref) {
        assetId = ref.id;
        await ws.collection("scheduledPosts").update(post.id, { packageAssetId: ref.id }, { actor: "system" });
      }
    }
    pkg = { jobId: post.exportJobId, status: job?.status ?? "unknown", assetId, error: job?.error?.userMessage ?? job?.error?.message };
    if (assetId) {
      const asset = await ws.collection("mediaAssets").get(assetId);
      if (asset) {
        assertKeyInWorkspace(wid, asset.storagePath);
        Object.assign(pkg, await p.storage.signedDownloadUrl(asset.storagePath, { expiresSec: 3600, downloadName: `${post.channel}-package.zip` }));
      }
    }
  }
  let trackingUrl: string | undefined;
  if (post.trackingLinkId) {
    const link = await ws.collection("attributionLinks").get(post.trackingLinkId);
    if (link) trackingUrl = trackedLinkUrl(p.cfg, link.slug);
  }
  return {
    post,
    instructions: post.manualInstructions.length ? post.manualInstructions : manualInstructions(post.channel),
    copy: { title: post.title && fillAppLink(post.title, trackingUrl), caption: post.caption && fillAppLink(post.caption, trackingUrl), tags: post.tags, trackingUrl },
    downloads,
    package: pkg,
  };
}

/** Export package via module C's `package.export` job (ZIP with media + copy). */
export async function requestPackage(p: Platform, wid: string, id: string, actor: string) {
  const ws = p.db.ws(wid);
  const post = await loadPost(ws, id);
  const job = await p.jobs.create(wid, "package.export", { appId: post.appId, campaignId: post.campaignId, compositionIds: post.compositionId ? [post.compositionId] : [], includeCopy: true }, { actor, appId: post.appId, idempotencyKey: `package:${post.id}:${post.compositionVersion ?? 0}:${Date.now()}` });
  const updated = await ws.collection("scheduledPosts").update(post.id, { exportJobId: job.id, packageAssetId: undefined }, { actor });
  return { post: updated, job };
}

export async function postView(p: Platform, wid: string, id: string) {
  const ws = p.db.ws(wid);
  const post = await loadPost(ws, id);
  const [approval, publication, account, pf, snap] = await Promise.all([
    post.approvalId ? ws.collection("approvals").get(post.approvalId) : null,
    post.publicationId ? ws.collection("publications").get(post.publicationId) : null,
    post.accountId ? ws.collection("connectedAccounts").get(post.accountId) : null,
    preflight(ws, post),
    postSnapshot(ws, post),
  ]);
  return {
    post,
    approval,
    publication,
    account: account ? { id: account.id, provider: account.provider, displayName: account.displayName, status: account.status, limitations: account.limitations } : null,
    preflight: pf,
    snapshotHash: snap.hash,
    statusLabel: statusLabel(post),
  };
}

/** Plain-language status (UI must never show "published" unless a real receipt exists). */
export function statusLabel(post: ScheduledPost): string {
  switch (post.status) {
    case "published":
      return "Published via API (receipt on file)";
    case "manually_posted":
      return "Posted manually (confirmed by you)";
    case "manual_post_needed":
      return "Ready for you to post manually";
    case "awaiting_approval":
      return "Waiting for approval";
    case "scheduled":
      return post.scheduledAt ? `Approved · publishes ${post.scheduledAt}` : "Approved · ready to publish";
    case "publishing":
      return "Publishing…";
    case "failed":
      return `Failed: ${post.lastError ?? "unknown error"}`;
    default:
      return post.status.replace(/_/g, " ");
  }
}
