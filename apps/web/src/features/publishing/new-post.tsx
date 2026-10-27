"use client";
import type { Campaign, Channel, MediaAsset } from "@muselaunch/contracts";
import { Badge, Button, Dialog, Field, Input, Notice, Select, Switch, Textarea, useToast } from "@muselaunch/ui";
import { Lightbulb } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api, errorMessage, isRouteMissing, wsPath } from "@/lib/api";
import type { CampaignDetailResponse, Page } from "@/lib/api-types";
import { CHANNEL_LABEL } from "@/lib/labels";
import { useApiQuery } from "@/lib/query";
import { useWorkspace } from "@/lib/workspace";
import type { ConnectionsResponse, PostView, SuggestedTimes } from "./types";

const CHANNELS: Channel[] = ["youtube", "instagram", "tiktok", "linkedin", "x", "facebook", "threads", "reddit", "producthunt", "hackernews", "newsletter", "website", "other"];
const PROVIDER_FOR: Partial<Record<Channel, string>> = { youtube: "youtube", instagram: "instagram", tiktok: "tiktok", linkedin: "linkedin", x: "x", facebook: "facebook" };

const toLocalInput = (iso: string) => {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** Create a post from a rendered composition (or other media) and a copy pack. Starts as a draft. */
export function NewPostDialog({ appId, open, onOpenChange, onCreated, initialCampaignId }: { appId: string; open: boolean; onOpenChange: (o: boolean) => void; onCreated: (postId: string) => void; initialCampaignId?: string }) {
  const { workspaceId } = useWorkspace();
  const toast = useToast();
  const campaigns = useApiQuery<Page<Campaign>>(open ? wsPath(workspaceId, `/apps/${appId}/campaigns`) : null);
  const [campaignId, setCampaignId] = useState(initialCampaignId ?? "");
  const detail = useApiQuery<CampaignDetailResponse>(open && campaignId ? wsPath(workspaceId, `/campaigns/${campaignId}`) : null, { retry: false });
  const assets = useApiQuery<Page<MediaAsset>>(open ? wsPath(workspaceId, "/assets") : null, { query: { appId, limit: 200 } });
  const conns = useApiQuery<ConnectionsResponse>(open ? wsPath(workspaceId, "/connections") : null);
  const [channel, setChannel] = useState<Channel>("youtube");
  const [assetId, setAssetId] = useState("");
  const [accountId, setAccountId] = useState("");
  const [copyPackId, setCopyPackId] = useState("");
  const [title, setTitle] = useState("");
  const [caption, setCaption] = useState("");
  const [tags, setTags] = useState("");
  const [visibility, setVisibility] = useState<"public" | "unlisted" | "private">("public");
  const [synthetic, setSynthetic] = useState<boolean | null>(null);
  const [when, setWhen] = useState("");
  const [reason, setReason] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);
  const times = useApiQuery<SuggestedTimes>(open ? wsPath(workspaceId, `/apps/${appId}/posts/suggested-times`) : null, { query: { channel, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, count: 3 } });

  useEffect(() => {
    if (!campaignId && campaigns.data?.items[0]) setCampaignId(campaigns.data.items[0].id);
  }, [campaigns.data, campaignId]);

  const media = useMemo(() => {
    const items = (assets.data?.items ?? []).filter((a) => ["ready", "uploaded"].includes(a.status) && (a.kind === "video" || a.kind === "image") && a.role !== "preview" && a.role !== "mask");
    const finals = items.filter((a) => a.role === "render" && a.render?.quality === "final" && (!campaignId || a.campaignId === campaignId || !a.campaignId));
    const others = items.filter((a) => a.role !== "render");
    return { finals, others };
  }, [assets.data, campaignId]);
  const chosen = [...media.finals, ...media.others].find((a) => a.id === assetId);
  const accounts = (conns.data?.items ?? []).filter((a) => a.status === "connected" && a.provider === PROVIDER_FOR[channel]);
  const packs = (detail.data?.copyPacks ?? []).filter((p) => p.channel === channel);

  useEffect(() => setAccountId(accounts[0]?.id ?? ""), [channel, conns.data]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const pack = packs.find((p) => p.id === copyPackId);
    if (!pack) return;
    const first = (k: string) => pack.items.find((i) => i.kind === k)?.text;
    setTitle(first("title") ?? title);
    setCaption(first("caption") ?? first("description") ?? caption);
    setTags(first("hashtags") ?? tags);
  }, [copyPackId]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async () => {
    setSaving(true);
    try {
      const r = await api.post<PostView>(wsPath(workspaceId, `/apps/${appId}/posts`), {
        campaignId,
        assetIds: [assetId],
        compositionId: chosen?.render?.compositionId,
        compositionVersion: chosen?.render?.version,
        copyPackId: copyPackId || undefined,
        channel,
        accountId: accountId || undefined,
        title: title || undefined,
        caption,
        tags: tags
          .split(/[\s,]+/)
          .map((t) => t.replace(/^#/, ""))
          .filter(Boolean),
        visibility,
        containsSyntheticMedia: synthetic ?? undefined,
        scheduledAt: when ? new Date(when).toISOString() : undefined,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        suggestedTimeReason: reason,
      });
      toast.success("Post drafted", r.preflight.errors.length ? r.preflight.errors[0] : "Request approval when it’s ready.");
      onCreated(r.post.id);
      onOpenChange(false);
    } catch (e) {
      toast.error("Couldn’t create the post", errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const campaignsMissing = campaigns.error && isRouteMissing(campaigns.error);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title="New post"
      description="Drafts are never published until someone with publishing rights approves this exact version."
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} loading={saving} disabled={!campaignId || !assetId || !caption.trim()}>
            Create draft
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {campaignsMissing ? <Notice tone="neutral">Campaigns aren’t available in this build yet, so posts can’t be created.</Notice> : null}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Campaign">
            {({ id }) => <Select id={id} value={campaignId} onChange={(e) => setCampaignId(e.target.value)} placeholder="Choose a campaign" options={(campaigns.data?.items ?? []).map((c) => ({ value: c.id, label: c.name }))} />}
          </Field>
          <Field label="Channel">
            {({ id }) => <Select id={id} value={channel} onChange={(e) => setChannel(e.target.value as Channel)} options={CHANNELS.map((c) => ({ value: c, label: CHANNEL_LABEL[c] }))} />}
          </Field>
        </div>
        <Field label="Media" hint={media.finals.length ? "Final renders first. Render the final video in the studio to see it here." : "No final renders yet: render a composition in the studio, or pick uploaded media."}>
          {({ id }) => (
            <Select
              id={id}
              value={assetId}
              onChange={(e) => setAssetId(e.target.value)}
              placeholder="Choose media"
              options={[
                ...media.finals.map((a) => ({ value: a.id, label: `Final render · ${a.title ?? a.render?.compositionId} v${a.render?.version}` })),
                ...media.others.map((a) => ({ value: a.id, label: `${a.role.replace(/_/g, " ")} · ${a.title ?? a.originalFilename ?? a.id}` })),
              ]}
            />
          )}
        </Field>
        <Field label="Account" hint={PROVIDER_FOR[channel] ? (accounts.length ? "Publishes via API after approval." : "No connected account: you’ll get a posting package and checklist instead.") : `${CHANNEL_LABEL[channel]} is always posted manually.`}>
          {({ id }) => (
            <Select id={id} value={accountId} onChange={(e) => setAccountId(e.target.value)} options={[{ value: "", label: "Post manually" }, ...accounts.map((a) => ({ value: a.id, label: `${a.displayName} (API)` }))]} disabled={!PROVIDER_FOR[channel]} />
          )}
        </Field>
        {packs.length ? (
          <Field label="Copy pack" optional>
            {({ id }) => <Select id={id} value={copyPackId} onChange={(e) => setCopyPackId(e.target.value)} options={[{ value: "", label: "Write my own" }, ...packs.map((p) => ({ value: p.id, label: `${CHANNEL_LABEL[p.channel]} copy · ${p.locale}${p.validation && !p.validation.ok ? " (claim issues)" : ""}` }))]} />}
          </Field>
        ) : null}
        <Field label="Title" optional={channel !== "youtube"}>
          {({ id }) => <Input id={id} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={300} />}
        </Field>
        <Field label="Caption" hint={`${caption.length} characters`}>
          {({ id }) => <Textarea id={id} rows={5} value={caption} onChange={(e) => setCaption(e.target.value)} />}
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Tags" optional hint="Space or comma separated">
            {({ id }) => <Input id={id} value={tags} onChange={(e) => setTags(e.target.value)} />}
          </Field>
          <Field label="Visibility">
            {({ id }) => (
              <Select
                id={id}
                value={visibility}
                onChange={(e) => setVisibility(e.target.value as typeof visibility)}
                options={[
                  { value: "public", label: "Public" },
                  { value: "unlisted", label: "Unlisted (YouTube)" },
                  { value: "private", label: "Private" },
                ]}
              />
            )}
          </Field>
        </div>
        <Switch checked={synthetic ?? chosen?.origin === "generated"} onCheckedChange={setSynthetic} label="Disclose AI-generated or synthetic media (YouTube, TikTok labels)" />
        <Field label="When" optional hint="Leave empty to publish when you click Publish after approval.">
          {({ id }) => <Input id={id} type="datetime-local" value={when} onChange={(e) => (setWhen(e.target.value), setReason(undefined))} />}
        </Field>
        {times.data?.items.length ? (
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-footnote text-ink-2">
              <Lightbulb className="size-3.5" aria-hidden /> Suggested times <Badge tone="outline">{times.data.basis === "your_results" ? "From your results" : "General starting points"}</Badge>
            </div>
            <div className="flex flex-wrap gap-2">
              {times.data.items.map((t) => (
                <button
                  key={t.at}
                  type="button"
                  title={t.reason}
                  onClick={() => (setWhen(toLocalInput(t.at)), setReason(t.reason))}
                  className="inline-flex h-8 items-center rounded-full border border-line-strong px-3 text-footnote text-ink-2 hover:border-ink-3 hover:text-ink"
                >
                  {t.localTime}
                </button>
              ))}
            </div>
            <p className="text-caption text-ink-3">{times.data.note}</p>
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}
