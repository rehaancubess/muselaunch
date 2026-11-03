"use client";
/**
 * "Schedule post" for what Create made that isn't a video: a post, a carousel, a thumbnail, a store
 * set (every slide of the final render: the server takes them all from `compositionId`) or a text post
 * (the copy pack Muse wrote and fact-checked; no media). One small sheet: where it goes, the caption
 * (from Muse's copy for that channel when there is one), a suggested time and the tracked link. It
 * drafts the post (POST /apps/:appId/posts) and asks for approval (POST /posts/:id/request-approval):
 * nothing goes out until someone with publishing rights says OK on Home. It goes out through the
 * channel's connected account when there is one (else the person posts it). Videos keep the full
 * new-post form (NewPostDialog). A YouTube thumbnail isn't a post of its own: "Use as cover" puts it
 * on a YouTube video post that isn't out yet (PATCH /posts/:id { thumbnailAssetId }).
 */
import type { Channel, CopyPack, ScheduledPost } from "@muselaunch/contracts";
import { Button, Dialog, Field, Notice, Select, Switch, Textarea, cn, humanizeStatus, useToast } from "@muselaunch/ui";
import { CalendarClock } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { createTrackedLink, destinationsFor } from "@/components/creator/tracked-links";
import { SlideImage, frameClass } from "@/components/creator/slide-gallery";
import { TextPostCard } from "@/components/creator/text-post-card";
import { PROVIDER_FOR } from "@/features/publishing/new-post";
import type { ConnectionsResponse, PostView, SuggestedTimes } from "@/features/publishing/types";
import { api, errorMessage, newIdempotencyKey, wsPath } from "@/lib/api";
import type { CampaignDetailResponse } from "@/lib/api-types";
import { CHANNEL_LABEL } from "@/lib/labels";
import { useApiQuery, useInvalidate } from "@/lib/query";
import { routes } from "@/lib/routes";
import { useWorkspace } from "@/lib/workspace";
import { CAROUSEL_CHANNELS, POST_CHANNELS, isThumbnailStills, type FinishedStills, type FinishedText, type FinishedVideo } from "./plan";

/** What "Schedule post" was pressed on. */
export type ScheduleTarget = ({ type: "video" } & FinishedVideo) | ({ type: "stills" } & FinishedStills) | ({ type: "text" } & FinishedText);

/** X takes at most 4 images in one post. */
const X_MAX_IMAGES = 4;

/** Where a set of stills can go: one image anywhere an image post goes; several where carousels go (X up to 4). */
function stillChannels(s: FinishedStills): Channel[] {
  return s.assetIds.length > 1 ? [...CAROUSEL_CHANNELS, ...(s.assetIds.length <= X_MAX_IMAGES ? (["x"] as const) : [])] : [...POST_CHANNELS];
}

function firstOf(pack: CopyPack | undefined, kind: string) {
  return pack?.items.find((i) => i.kind === kind)?.text;
}

type DialogProps = { appId: string; target: ScheduleTarget | null; channel?: Channel; onClose: () => void };

export function SchedulePostDialog(props: DialogProps) {
  const t = props.target;
  if (t?.type === "stills" && isThumbnailStills(t)) return <UseAsCoverDialog appId={props.appId} stills={t} onClose={props.onClose} />;
  return <PostDialog {...props} />;
}

function PostDialog({ appId, target, channel: initial, onClose }: DialogProps) {
  const open = Boolean(target && target.type !== "video");
  const { workspaceId, app } = useWorkspace();
  const toast = useToast();
  const router = useRouter();
  const invalidate = useInvalidate();
  const t = target && target.type !== "video" ? target : null;
  const campaignId = t?.campaignId;
  // A text post stays on the channel Muse wrote it for (its copy pack is that channel's).
  const channels = useMemo<Channel[]>(() => (t?.type === "text" ? [t.channel] : t ? stillChannels(t) : []), [t]);
  const [channel, setChannel] = useState<Channel>("instagram");
  const [caption, setCaption] = useState("");
  const [edited, setEdited] = useState(false);
  const [when, setWhen] = useState<{ at: string; label: string; reason: string } | null>(null);
  const linkDests = destinationsFor(app);
  const [withLink, setWithLink] = useState(true);
  const [saving, setSaving] = useState(false);
  const idem = useRef(newIdempotencyKey("schedule"));

  useEffect(() => {
    if (!t) return;
    setChannel(t.type === "text" ? t.channel : initial && channels.includes(initial) ? initial : channels[0]!);
    setEdited(false);
    setWhen(null);
    idem.current = newIdempotencyKey("schedule");
  }, [t?.type === "text" ? t.campaignId : t?.compositionId]); // eslint-disable-line react-hooks/exhaustive-deps -- reset per thing scheduled

  const detail = useApiQuery<CampaignDetailResponse>(open && campaignId ? wsPath(workspaceId, `/campaigns/${campaignId}`) : null, { retry: false, staleTime: 30_000 });
  // The channel's connected account posts it after the OK (the server posts by hand what its API can't take).
  const conns = useApiQuery<ConnectionsResponse>(open ? wsPath(workspaceId, "/connections") : null, { retry: false, staleTime: 30_000 });
  const accounts = (conns.data?.items ?? []).filter((a) => a.status === "connected" && a.provider === PROVIDER_FOR[channel]);
  const [accountId, setAccountId] = useState("");
  useEffect(() => setAccountId(accounts[0]?.id ?? ""), [channel, conns.data]); // eslint-disable-line react-hooks/exhaustive-deps -- the first connected account per channel
  const pack = t?.type === "text" ? detail.data?.copyPacks.find((p) => p.id === t.copyPackId) : detail.data?.copyPacks.find((p) => p.channel === channel);
  // The caption Muse wrote for this channel, until the person writes their own.
  useEffect(() => {
    if (!open || edited || t?.type === "text") return;
    setCaption(firstOf(pack, "caption") ?? firstOf(pack, "description") ?? "");
  }, [pack, open, edited, t?.type]);
  const times = useApiQuery<SuggestedTimes>(open ? wsPath(workspaceId, `/apps/${appId}/posts/suggested-times`) : null, { query: { channel, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, count: 3 }, retry: false });

  const text = t?.type === "text";
  const needsCaption = !text && !caption.trim();
  const submit = async () => {
    if (!t || !campaignId) return;
    setSaving(true);
    let postId: string | null = null;
    try {
      let trackingLinkId: string | undefined;
      if (withLink && linkDests[0]) trackingLinkId = (await createTrackedLink(workspaceId, campaignId, { destination: linkDests[0].value, channel, campaignName: detail.data?.campaign.name })).link.id;
      const created = await api.post<PostView>(
        wsPath(workspaceId, `/apps/${appId}/posts`),
        t.type === "text"
          ? // A text post: the copy pack is the post (the server takes its text); no media.
            { campaignId, copyPackId: t.copyPackId, channel, accountId: accountId || undefined, trackingLinkId, scheduledAt: when?.at, suggestedTimeReason: when?.reason, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }
          : // Stills: every slide of the final render (the server takes them from the composition).
            { campaignId, compositionId: t.compositionId, compositionVersion: t.version, copyPackId: pack?.id, caption: caption.trim(), title: firstOf(pack, "title"), channel, accountId: accountId || undefined, trackingLinkId, scheduledAt: when?.at, suggestedTimeReason: when?.reason, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone },
        { idempotencyKey: idem.current },
      );
      postId = created.post.id;
      // Ask for the OK right away: it shows on Home as the next post, with Schedule post.
      await api.post(wsPath(workspaceId, `/posts/${postId}/request-approval`), {});
      toast.toast({ title: "Ready for your OK", description: "It’s on Home. Nothing goes out until someone with publishing rights schedules it.", action: { label: "Open Home", onClick: () => router.push(routes.app(workspaceId, appId).home) } });
      onClose();
    } catch (e) {
      if (postId) {
        // Drafted, but approval couldn't be asked for yet (e.g. the brand or fact check): it waits in Scheduled.
        toast.toast({ title: "Post drafted", description: `${errorMessage(e)} It waits in Scheduled.`, action: { label: "Open Scheduled", onClick: () => router.push(routes.app(workspaceId, appId).scheduled) } });
        onClose();
      } else toast.error("Couldn’t schedule the post", errorMessage(e));
    } finally {
      setSaving(false);
      await invalidate(wsPath(workspaceId, `/apps/${appId}/today`), wsPath(workspaceId, `/apps/${appId}/calendar`), wsPath(workspaceId, "/needs-you"));
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title="Schedule post"
      description="Muse drafts the post and asks for your OK. Nothing is posted until someone with publishing rights says yes."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} loading={saving} disabled={!campaignId || needsCaption || (text && !t?.copyPackId)}>
            Schedule post
          </Button>
        </>
      }
    >
      {t ? (
        <div className="space-y-4">
          {t.type === "text" ? (
            <TextPostCard text={t.text} channel={channel} ok={t.ok} clamp />
          ) : (
            <div className="flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none]">
              {t.assetIds.map((id, i) => (
                <span key={id} className={cn("relative block shrink-0 overflow-hidden rounded-lg bg-mist shadow-raised", frameClass(t.width, t.height), t.width && t.height && t.width > t.height ? "w-40" : "w-20")}>
                  <SlideImage assetId={id} alt={`Slide ${i + 1} of ${t.assetIds.length}`} />
                </span>
              ))}
            </div>
          )}
          <Field label="Where">
            {({ id }) => <Select id={id} value={channel} onChange={(e) => setChannel(e.target.value as Channel)} options={channels.map((c) => ({ value: c, label: CHANNEL_LABEL[c] }))} disabled={channels.length < 2} />}
          </Field>
          {accounts.length ? (
            <Field label="Posted by" hint={accountId ? "MuseLaunch posts it through this account after your OK." : "You post it yourself after your OK."}>
              {({ id }) => <Select id={id} value={accountId} onChange={(e) => setAccountId(e.target.value)} options={[...accounts.map((a) => ({ value: a.id, label: a.displayName })), { value: "", label: "Post it myself" }]} />}
            </Field>
          ) : conns.data ? (
            <p className="text-caption text-ink-3">{PROVIDER_FOR[channel] ? `${CHANNEL_LABEL[channel]} isn’t connected, so you post this one yourself after your OK.` : `${CHANNEL_LABEL[channel]} posts are always posted by hand: you get the ${text ? "text" : "images and caption"} to post yourself.`}</p>
          ) : null}
          {text ? null : (
            <Field label="Caption" hint={pack && !edited ? `Written by Muse for ${CHANNEL_LABEL[channel]}` : `${caption.length} characters`}>
              {({ id }) => <Textarea id={id} rows={4} value={caption} onChange={(e) => (setCaption(e.target.value), setEdited(true))} placeholder="What goes with the images…" />}
            </Field>
          )}
          {times.data?.items.length ? (
            <div className="space-y-2">
              <p className="flex items-center gap-1.5 text-footnote font-medium text-ink">
                <CalendarClock className="size-4 text-ink-3" aria-hidden />
                When
              </p>
              <div className="flex flex-wrap gap-2" role="group" aria-label="Suggested times">
                {times.data.items.map((s) => {
                  const on = when?.at === s.at;
                  return (
                    <button
                      key={s.at}
                      type="button"
                      aria-pressed={on}
                      title={s.reason}
                      onClick={() => setWhen(on ? null : { at: s.at, label: s.localTime, reason: s.reason })}
                      className={cn("inline-flex min-h-9 items-center rounded-full border px-3 text-footnote transition-colors focus-visible:outline-none focus-visible:shadow-focus", on ? "border-accent bg-accent-soft font-medium text-accent-ink" : "border-line-strong text-ink-2 hover:border-ink-3 hover:text-ink")}
                    >
                      {s.localTime}
                    </button>
                  );
                })}
              </div>
              <p className="text-caption text-ink-3">{when ? when.reason : "Or leave it, and pick the time when you schedule it on Home."}</p>
            </div>
          ) : null}
          {linkDests.length ? (
            <label className="flex items-start justify-between gap-4 rounded-lg bg-mist/70 px-3 py-2.5">
              <span className="text-footnote text-ink-2">
                <span className="block font-medium text-ink">Add a tracked link</span>
                Clicks to {linkDests[0]!.label} from this post are counted in Results.
              </span>
              <Switch checked={withLink} onCheckedChange={setWithLink} label="Add a tracked link" />
            </label>
          ) : null}
          {detail.error ? <Notice tone="warning">Couldn’t load this campaign: {errorMessage(detail.error)}</Notice> : null}
        </div>
      ) : null}
    </Dialog>
  );
}

/** Posts a cover can go on: YouTube video posts that aren't out yet. */
const COVER_STATUSES: ReadonlySet<ScheduledPost["status"]> = new Set(["draft", "awaiting_approval", "scheduled", "failed", "manual_post_needed"]);
type PostListItem = ScheduledPost & { mediaCount: number; textOnly: boolean };

/**
 * "Use as cover" for a YouTube thumbnail: pick a YouTube video post that isn't out yet and the image
 * becomes its custom thumbnail. Changing a post resets an OK given for it, so it asks again.
 */
function UseAsCoverDialog({ appId, stills, onClose }: { appId: string; stills: FinishedStills; onClose: () => void }) {
  const { workspaceId } = useWorkspace();
  const toast = useToast();
  const router = useRouter();
  const invalidate = useInvalidate();
  const posts = useApiQuery<{ items: PostListItem[] }>(wsPath(workspaceId, `/apps/${appId}/posts`), { retry: false });
  const videos = useMemo(() => (posts.data?.items ?? []).filter((p) => p.channel === "youtube" && COVER_STATUSES.has(p.status) && p.mediaCount > 0), [posts.data]);
  const [postId, setPostId] = useState("");
  useEffect(() => {
    if (!videos.some((v) => v.id === postId)) setPostId(videos[0]?.id ?? "");
  }, [videos, postId]);
  const chosen = videos.find((v) => v.id === postId);
  const [saving, setSaving] = useState(false);
  const cover = stills.assetIds[0]!;
  const r = routes.app(workspaceId, appId);

  const submit = async () => {
    if (!chosen) return;
    setSaving(true);
    try {
      const out = await api.patch<{ post: ScheduledPost; approvalReset: boolean }>(wsPath(workspaceId, `/posts/${chosen.id}`), { thumbnailAssetId: cover });
      if (chosen.status !== "draft" && out.post.status === "draft") {
        // The post changed, so an OK given for it no longer counts: ask for it again.
        try {
          await api.post(wsPath(workspaceId, `/posts/${chosen.id}/request-approval`), {});
          toast.toast({ title: "Cover added", description: "The post changed, so it waits for your OK again on Home.", action: { label: "Open Home", onClick: () => router.push(r.home) } });
        } catch (e) {
          toast.toast({ title: "Cover added", description: `The post changed, so its OK was reset. ${errorMessage(e)} It waits in Scheduled.`, action: { label: "Open Scheduled", onClick: () => router.push(r.scheduled) } });
        }
      } else toast.success("Cover added", "YouTube gets it as the video’s thumbnail when the post goes out.");
      onClose();
    } catch (e) {
      toast.error("Couldn’t add the cover", errorMessage(e));
    } finally {
      setSaving(false);
      await invalidate(wsPath(workspaceId, `/apps/${appId}/today`), wsPath(workspaceId, `/apps/${appId}/posts`), wsPath(workspaceId, `/apps/${appId}/calendar`), wsPath(workspaceId, "/needs-you"));
    }
  };

  const label = (p: PostListItem) => `${(p.title?.trim() || p.caption.trim() || "Untitled video").slice(0, 70)} · ${humanizeStatus(p.status)}`;
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Use as cover"
      description="A thumbnail goes on a YouTube video as its cover. Pick the video post it’s for. YouTube shows custom covers on verified channels only."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} loading={saving} disabled={!chosen}>
            Use as cover
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <span className={cn("relative block w-56 overflow-hidden rounded-lg bg-mist shadow-raised", frameClass(stills.width, stills.height))}>
          <SlideImage assetId={cover} alt="The thumbnail" />
        </span>
        {posts.isLoading ? null : videos.length ? (
          <Field label="Video post" hint={chosen?.thumbnailAssetId ? "Replaces the cover this post has now." : undefined}>
            {({ id }) => <Select id={id} value={postId} onChange={(e) => setPostId(e.target.value)} options={videos.map((v) => ({ value: v.id, label: label(v) }))} />}
          </Field>
        ) : (
          <Notice tone="neutral">No YouTube video post is waiting to go out. Make a video for YouTube and schedule it, then come back to use this as its cover. You can also download the thumbnail and add it in YouTube Studio.</Notice>
        )}
        {posts.error ? <Notice tone="warning">Couldn’t load your posts: {errorMessage(posts.error)}</Notice> : null}
      </div>
    </Dialog>
  );
}
