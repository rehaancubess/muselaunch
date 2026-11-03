"use client";
/**
 * "Schedule post" for what Create made that isn't a video: a post, a carousel, a thumbnail, a store
 * set (every slide of the final render: the server takes them all from `compositionId`) or a text post
 * (the copy pack Muse wrote and fact-checked; no media). One small sheet: where it goes, the caption
 * (from Muse's copy for that channel when there is one), a suggested time and the tracked link. It
 * drafts the post (POST /apps/:appId/posts) and asks for approval (POST /posts/:id/request-approval):
 * nothing goes out until someone with publishing rights says OK on Home. Videos keep the full
 * new-post form (NewPostDialog).
 */
import type { Channel, CopyPack } from "@muselaunch/contracts";
import { Button, Dialog, Field, Notice, Select, Switch, Textarea, cn, useToast } from "@muselaunch/ui";
import { CalendarClock } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { createTrackedLink, destinationsFor } from "@/components/creator/tracked-links";
import { SlideImage, frameClass } from "@/components/creator/slide-gallery";
import { TextPostCard } from "@/components/creator/text-post-card";
import type { PostView, SuggestedTimes } from "@/features/publishing/types";
import { api, errorMessage, newIdempotencyKey, wsPath } from "@/lib/api";
import type { CampaignDetailResponse } from "@/lib/api-types";
import { CHANNEL_LABEL } from "@/lib/labels";
import { useApiQuery, useInvalidate } from "@/lib/query";
import { routes } from "@/lib/routes";
import { useWorkspace } from "@/lib/workspace";
import { CAROUSEL_CHANNELS, POST_CHANNELS, TEXT_POST_CHANNELS, type FinishedStills, type FinishedText, type FinishedVideo } from "./plan";

/** What "Schedule post" was pressed on. */
export type ScheduleTarget = ({ type: "video" } & FinishedVideo) | ({ type: "stills" } & FinishedStills) | ({ type: "text" } & FinishedText);

/** Where a set of stills can go: one image anywhere an image post goes; several where carousels go; a thumbnail on YouTube. */
function stillChannels(s: FinishedStills): Channel[] {
  if (s.width && s.height && s.width > s.height) return ["youtube"];
  return s.assetIds.length > 1 ? [...CAROUSEL_CHANNELS, "x"] : [...POST_CHANNELS];
}

function firstOf(pack: CopyPack | undefined, kind: string) {
  return pack?.items.find((i) => i.kind === kind)?.text;
}

export function SchedulePostDialog({ appId, target, channel: initial, onClose }: { appId: string; target: ScheduleTarget | null; channel?: Channel; onClose: () => void }) {
  const open = Boolean(target && target.type !== "video");
  const { workspaceId, app } = useWorkspace();
  const toast = useToast();
  const router = useRouter();
  const invalidate = useInvalidate();
  const t = target && target.type !== "video" ? target : null;
  const campaignId = t?.campaignId;
  const channels = useMemo<Channel[]>(() => (t?.type === "text" ? [...TEXT_POST_CHANNELS] : t ? stillChannels(t) : []), [t]);
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
            { campaignId, copyPackId: t.copyPackId, channel, trackingLinkId, scheduledAt: when?.at, suggestedTimeReason: when?.reason, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }
          : // Stills: every slide of the final render (the server takes them from the composition).
            { campaignId, compositionId: t.compositionId, compositionVersion: t.version, copyPackId: pack?.id, caption: caption.trim(), title: firstOf(pack, "title"), channel, trackingLinkId, scheduledAt: when?.at, suggestedTimeReason: when?.reason, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone },
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
