"use client";
import type { App, Channel } from "@muselaunch/contracts";
import { Badge, Button, Dialog, EmptyState, Field, IconButton, Select, Skeleton, Tooltip, useToast } from "@muselaunch/ui";
import { Check, Copy, Link2, Plus } from "lucide-react";
import { useState } from "react";
import { QueryState } from "@/components/states";
import { api, errorMessage, wsPath } from "@/lib/api";
import type { CreateTrackedLinkResponse, Page, TrackedLinkView } from "@/lib/api-types";
import { CHANNEL_LABEL, relativeTime } from "@/lib/labels";
import { useApiQuery, useInvalidate } from "@/lib/query";

type Dest = "ios" | "android" | "website";

export function destinationsFor(app: Pick<App, "storeUrls" | "websiteUrl"> | null): { value: Dest; label: string }[] {
  if (!app) return [];
  return [
    ...(app.storeUrls.ios ? [{ value: "ios" as const, label: "App Store" }] : []),
    ...(app.storeUrls.android ? [{ value: "android" as const, label: "Google Play" }] : []),
    ...(app.websiteUrl ? [{ value: "website" as const, label: "Website" }] : []),
  ];
}

/** Create a tracked link (F: `POST /campaigns/:id/links`) for one of the app's own destinations. */
export async function createTrackedLink(workspaceId: string, campaignId: string, input: { destination: Dest; channel: Channel; campaignName?: string }): Promise<CreateTrackedLinkResponse> {
  return api.post<CreateTrackedLinkResponse>(wsPath(workspaceId, `/campaigns/${campaignId}/links`), {
    destination: input.destination,
    channel: input.channel,
    utm: { source: input.channel, medium: "social", campaign: input.campaignName?.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60) || undefined },
  });
}

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <IconButton
      label={done ? "Copied" : "Copy link"}
      size="sm"
      onClick={() =>
        navigator.clipboard.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        })
      }
    >
      {done ? <Check className="size-3.5 text-success" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
    </IconButton>
  );
}

/** Campaign tracked links: measurable clicks per channel, attributed to this campaign. */
export function TrackedLinks({ workspaceId, campaignId, campaignName, app, channels, canEdit }: { workspaceId: string; campaignId: string; campaignName: string; app: App | null; channels: Channel[]; canEdit: boolean }) {
  const path = wsPath(workspaceId, `/campaigns/${campaignId}/links`);
  const q = useApiQuery<Page<TrackedLinkView>>(path);
  const invalidate = useInvalidate();
  const toast = useToast();
  const dests = destinationsFor(app);
  const [open, setOpen] = useState(false);
  const [dest, setDest] = useState<Dest | "">(dests[0]?.value ?? "");
  const [channel, setChannel] = useState<Channel>(channels[0] ?? "instagram");
  const [busy, setBusy] = useState(false);

  return (
    <div className="space-y-3">
      <QueryState query={q} feature="Tracked links" skeleton={<Skeleton className="h-16" rounded="xl" />}>
        {(data) =>
          data.items.length ? (
            <ul className="divide-y divide-line overflow-hidden rounded-xl bg-surface shadow-raised">
              {data.items.map((l) => (
                <li key={l.id} className="flex items-center gap-3 px-4 py-3">
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-mist text-ink-2">
                    <Link2 className="size-4" aria-hidden />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-mono text-footnote text-ink">{l.publicUrl}</p>
                    <p className="truncate text-caption text-ink-2">
                      {l.channel ? `${CHANNEL_LABEL[l.channel]}, ` : `${l.utm.source}, `}
                      {l.destinationKind === "ios" ? "to the App Store" : l.destinationKind === "android" ? "to Google Play" : "to your website"}, created {relativeTime(l.createdAt)}
                    </p>
                  </div>
                  <Tooltip content="Human clicks only; link-preview bots are excluded">
                    <span>
                      <Badge tone={l.clickCount ? "accent" : "neutral"} className="tabular">
                        {l.clickCount} click{l.clickCount === 1 ? "" : "s"}
                      </Badge>
                    </span>
                  </Tooltip>
                  {!l.active ? <Badge tone="outline">Paused</Badge> : null}
                  <CopyButton text={l.publicUrl} />
                </li>
              ))}
            </ul>
          ) : (
            <div className="rounded-xl bg-mist/60">
              <EmptyState size="sm" icon={<Link2 aria-hidden />} title="No tracked links yet" description="Put a tracked link in each post so Insights can count clicks for this campaign. Without one, clicks can’t be attributed." />
            </div>
          )
        }
      </QueryState>
      {canEdit ? (
        <Button size="sm" variant="secondary" icon={<Plus className="size-3.5" aria-hidden />} onClick={() => setOpen(true)} disabled={!dests.length} title={dests.length ? undefined : "Add a store link or website to the app first"}>
          New tracked link
        </Button>
      ) : null}
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="New tracked link"
        description="A short link that redirects to your app and counts real clicks for this campaign."
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              loading={busy}
              disabled={!dest}
              onClick={async () => {
                if (!dest) return;
                setBusy(true);
                try {
                  const r = await createTrackedLink(workspaceId, campaignId, { destination: dest, channel, campaignName });
                  await invalidate(path);
                  await navigator.clipboard?.writeText(r.publicUrl).catch(() => undefined);
                  toast.success("Tracked link created", `${r.publicUrl} (copied)`);
                  setOpen(false);
                } catch (e) {
                  toast.error("Couldn’t create the link", errorMessage(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              Create link
            </Button>
          </>
        }
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Sends people to">{(f) => <Select id={f.id} value={dest} onChange={(e) => setDest(e.target.value as Dest)} options={dests} />}</Field>
          <Field label="Where you’ll post it">
            {(f) => <Select id={f.id} value={channel} onChange={(e) => setChannel(e.target.value as Channel)} options={(channels.length ? channels : (["instagram", "tiktok", "youtube", "x", "linkedin"] as Channel[])).map((c) => ({ value: c, label: CHANNEL_LABEL[c] }))} />}
          </Field>
        </div>
      </Dialog>
    </div>
  );
}
