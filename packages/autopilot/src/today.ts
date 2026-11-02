/**
 * Creator → Today (GET /apps/:appId/today): what's waiting on the person for one app, in one read.
 *
 *  - posts: waiting for approval first (the same Needs-you items, so "Looks good" calls the same
 *    route with the same permission and snapshot checks), in the order they'd go out; then approved
 *    posts the person posts themselves; then posts Muse is changing (or just changed) for them;
 *  - needs: every other Needs-you item for the app;
 *  - videos: the newest finished video (final render) per composition.
 *
 * Read-only, apart from moving on a "Tell Muse what to change" step whose job finished while its
 * hook was missed (repairPostChanges; idempotent).
 */
import { can, fillAppLink, isPostChangeRunning, type MediaAsset, type ScheduledPost, type TodayPost, type TodayResponse, type TodayVideo, type WorkspaceMember } from "@muselaunch/contracts";
import { preflight } from "@muselaunch/growth";
import { trackedLinkUrl, type Platform } from "@muselaunch/platform";
import { timeBasisOf } from "./always-on-loop";
import { needsYou } from "./needs-you";
import { CHANGEABLE_POST, repairPostChanges } from "./post-change";

type Member = Pick<WorkspaceMember, "role" | "canPublish" | "canManageAccounts" | "status">;

const DAY_MS = 86_400_000;
const MAX_POSTS = 12;
const MAX_VIDEOS = 8;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const byTime = (a: ScheduledPost, b: ScheduledPost) => (a.scheduledAt ?? "￿").localeCompare(b.scheduledAt ?? "￿") || a.createdAt.localeCompare(b.createdAt);

export async function today(p: Platform, wid: string, member: Member, appId: string): Promise<TodayResponse> {
  const ws = p.db.ws(wid);
  const list = () => ws.collection("scheduledPosts").list({ where: [["appId", "==", appId]], orderBy: { field: "createdAt", dir: "desc" }, limit: 200 });
  let posts = (await list()).items;
  if (await repairPostChanges(p, wid, appId, posts).catch(() => 0)) posts = (await list()).items;
  const [needs, renders] = await Promise.all([
    needsYou(p, wid, member, { appId, limit: 50 }),
    ws.collection("mediaAssets").list({ where: [["appId", "==", appId], ["role", "==", "render"]], orderBy: { field: "createdAt", dir: "desc" }, limit: 100 }),
  ]);
  const decisions = new Map(needs.items.filter((i) => i.kind === "post").map((i) => [i.subject.id, i]));
  const byId = new Map(posts.map((x) => [x.id, x]));
  const now = Date.now();
  const waiting = [...decisions.keys()].map((id) => byId.get(id)).filter((x): x is ScheduledPost => Boolean(x));
  const yours = posts.filter((x) => x.status === "manual_post_needed").sort(byTime);
  const changing = posts
    .filter((x) => x.change && CHANGEABLE_POST.includes(x.status) && x.status !== "manual_post_needed" && !decisions.has(x.id) && (isPostChangeRunning(x.change) || now - Date.parse(x.change.finishedAt ?? x.change.startedAt) < DAY_MS))
    .sort(byTime);
  const shown = [...new Map([...waiting, ...yours, ...changing].map((x) => [x.id, x])).values()].slice(0, MAX_POSTS);

  const assetIds = [...new Set(shown.flatMap((x) => x.assetIds))];
  const [assets, comps, accounts, links] = await Promise.all([
    ws.collection("mediaAssets").getMany(assetIds),
    ws.collection("compositions").getMany([...new Set([...shown.flatMap((x) => (x.compositionId ? [x.compositionId] : [])), ...renders.items.flatMap((a) => (a.render?.compositionId ? [a.render.compositionId] : []))])]),
    ws.collection("connectedAccounts").getMany([...new Set(shown.flatMap((x) => (x.accountId ? [x.accountId] : [])))]),
    ws.collection("attributionLinks").getMany([...new Set(shown.flatMap((x) => (x.trackingLinkId ? [x.trackingLinkId] : [])))]),
  ]);
  const assetById = new Map(assets.map((a) => [a.id, a]));
  const compById = new Map(comps.map((c) => [c.id, c]));
  const accountById = new Map(accounts.map((a) => [a.id, a]));
  const linkById = new Map(links.map((l) => [l.id, l]));
  const writer = can(member, "content.write");

  const out: TodayPost[] = [];
  for (const post of shown) {
    const media = post.assetIds.map((id) => assetById.get(id)).filter((a): a is MediaAsset => Boolean(a));
    const main = media.find((a) => a.kind === "video") ?? media.find((a) => a.kind === "image");
    const comp = post.compositionId ? compById.get(post.compositionId) : undefined;
    const link = post.trackingLinkId ? linkById.get(post.trackingLinkId) : undefined;
    const url = link ? trackedLinkUrl(p.cfg, link.slug) : undefined;
    const caption = fillAppLink(post.caption, url);
    const title = post.title ? fillAppLink(post.title, url) : undefined;
    const account = post.accountId ? accountById.get(post.accountId) : undefined;
    const decision = decisions.get(post.id) ?? null;
    const why = post.mode === "manual" ? post.manualInstructions.find((s) => s.startsWith("Why manual: "))?.slice("Why manual: ".length) : undefined;
    const blocked = !decision && post.status !== "manual_post_needed" ? (await preflight(ws, post)).errors[0] : undefined;
    out.push({
      id: post.id,
      channel: post.channel,
      mode: post.mode,
      status: post.status,
      title: title ? clip(title, 300) : undefined,
      caption: clip(caption, 5000),
      copyText: clip([title, caption, url && !caption.includes(url) ? url : undefined].filter(Boolean).join("\n\n"), 6000),
      scheduledAt: post.scheduledAt,
      timezone: post.timezone,
      timeBasis: timeBasisOf(post.suggestedTimeReason),
      timeReason: post.suggestedTimeReason ? clip(post.suggestedTimeReason, 500) : undefined,
      account: account ? { name: clip(account.displayName, 200), status: account.status } : null,
      manualReason: why ? clip(why, 500) : undefined,
      video: main ? { assetId: main.id, posterAssetId: main.posterAssetId, kind: main.kind === "video" ? "video" : "image", durationSec: main.durationSec, width: main.width, height: main.height } : null,
      compositionId: post.compositionId,
      compositionTitle: comp ? clip(comp.title, 200) : undefined,
      compositionVersion: post.compositionVersion,
      decision,
      blocked: blocked ? clip(blocked, 2000) : undefined,
      change: post.change ?? null,
      canChange: writer && CHANGEABLE_POST.includes(post.status),
    });
  }

  // Newest final render per video (a re-render of a newer version replaces the older one).
  const videos: TodayVideo[] = [];
  const seen = new Set<string>();
  for (const a of renders.items) {
    const cid = a.render?.compositionId;
    if (!cid || a.render?.quality !== "final" || a.status !== "ready" || a.kind !== "video" || seen.has(cid)) continue;
    const comp = compById.get(cid);
    if (!comp) continue;
    seen.add(cid);
    videos.push({ compositionId: cid, title: clip(comp.title, 200), version: a.render.version, assetId: a.id, posterAssetId: a.posterAssetId, durationSec: a.durationSec, width: a.width, height: a.height, renderedAt: a.createdAt });
    if (videos.length >= MAX_VIDEOS) break;
  }
  return { appId, posts: out, needs: needs.items.filter((i) => i.kind !== "post"), videos };
}
