"use client";
/**
 * "Needs you": the only decisions MuseLaunch can't make on its own — publishing a post, sending
 * outreach, spending beyond a run's budget, or letting a loop continue — as one list with one-tap
 * decisions. Data: GET /needs-you (+ ?appId=). Each item names the existing decision route, which
 * keeps its permission and snapshot checks; this UI only calls it.
 */
import type { NeedsYouItem, NeedsYouResponse } from "@muselaunch/contracts";
import { Badge, Button, Sheet, cn, useToast } from "@muselaunch/ui";
import { ArrowUpRight, Check, Coins, Hand, Mail, Send } from "lucide-react";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import { api, errorMessage, wsPath } from "@/lib/api";
import { CHANNEL_LABEL } from "@/lib/labels";
import { useApiQuery, useInvalidate } from "@/lib/query";
import { useWorkspace } from "@/lib/workspace";
import type { Channel } from "@muselaunch/contracts";

const KIND_ICON: Record<NeedsYouItem["kind"], ReactNode> = {
  post: <Send aria-hidden />,
  outreach: <Mail aria-hidden />,
  spend: <Coins aria-hidden />,
  decision: <Hand aria-hidden />,
};

const APPROVE_LABEL: Record<NeedsYouItem["kind"], string> = { post: "Approve post", outreach: "Approve and send", spend: "Approve spend", decision: "Continue" };
const REJECT_LABEL: Record<NeedsYouItem["kind"], string> = { post: "Not this one", outreach: "Don’t send", spend: "Decline", decision: "Pause" };

const WHO: Record<string, string> = {
  publish: "someone who can publish",
  "outreach.send": "someone who can send outreach",
  "billing.manage": "someone who manages billing",
  "content.approve": "an owner or admin",
};

export function useNeedsYou(workspaceId: string, appId?: string | null, opts: { enabled?: boolean } = {}) {
  return useApiQuery<NeedsYouResponse>(workspaceId ? wsPath(workspaceId, "/needs-you") : null, {
    query: appId ? { appId } : undefined,
    enabled: opts.enabled ?? true,
    staleTime: 5_000,
    refetchInterval: 15_000,
    retry: false,
  });
}

function when(iso?: string) {
  if (!iso) return null;
  return new Date(iso).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** One decision, ready for a single tap. */
export function NeedsYouCard({ item, appName, compact }: { item: NeedsYouItem; appName?: string; compact?: boolean }) {
  const { workspaceId } = useWorkspace();
  const toast = useToast();
  const invalidate = useInvalidate();
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const review = item.reviewPath ? `/w/${workspaceId}${item.reviewPath}` : null;
  const decide = async (which: "approve" | "reject") => {
    const route = which === "approve" ? item.approve : item.reject;
    if (!route) return;
    setBusy(which);
    try {
      await api.post(wsPath(workspaceId, route.path), route.body ?? {});
      toast.success(
        which === "approve" ? (item.kind === "post" ? "Post approved" : item.kind === "spend" ? "Spend approved" : "Approved") : "Got it",
        which === "approve"
          ? item.kind === "post"
            ? "It goes out at its scheduled time, or you post it yourself where the channel needs that."
            : "Growth Autopilot carries on."
          : item.kind === "spend" || item.kind === "decision"
            ? "The run is paused. Resume it whenever you like."
            : "Nothing was sent.",
      );
      await invalidate(wsPath(workspaceId, "/needs-you"), wsPath(workspaceId, "/autopilots"), wsPath(workspaceId, "/apps"), wsPath(workspaceId, "/approvals"));
    } catch (e) {
      toast.error("Couldn’t record that", errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const pv = item.preview;
  return (
    <article className={cn("space-y-3 rounded-xl bg-surface shadow-raised", compact ? "p-4" : "p-5")} aria-label={item.title}>
      <div className="flex items-start gap-3">
        <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-full [&_svg]:size-4", item.kind === "spend" ? "bg-warning-soft text-warning" : "bg-accent-soft text-accent")}>{KIND_ICON[item.kind]}</span>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="text-body-sm font-semibold text-ink text-pretty">{item.title}</h3>
            {item.credits ? <Badge tone="warning">≈{item.credits} credits</Badge> : null}
          </div>
          {appName ? <p className="text-caption text-ink-3">{appName}</p> : null}
          {pv?.caption && item.kind !== "spend" ? (
            <p className="line-clamp-3 text-footnote text-ink-2">
              {pv.subjectLine ? <span className="font-medium text-ink">{pv.subjectLine} · </span> : null}
              {pv.caption}
            </p>
          ) : (
            <p className="text-footnote text-ink-2 text-pretty">{item.summary}</p>
          )}
          {pv?.channel || pv?.scheduledAt || pv?.to ? (
            <p className="text-caption text-ink-3">{[pv.channel ? (CHANNEL_LABEL[pv.channel as Channel] ?? pv.channel) : null, pv.scheduledAt ? when(pv.scheduledAt) : null, pv.to ? `To ${pv.to}` : null].filter(Boolean).join(" · ")}</p>
          ) : null}
        </div>
      </div>
      {item.stale ? (
        <p className="text-footnote text-warning sm:pl-12">This changed after approval was requested. Review the latest version.</p>
      ) : !item.canDecide ? (
        <p className="text-footnote text-ink-2 sm:pl-12">Waiting for {WHO[item.requiredCap] ?? "someone with permission"} to decide.</p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2 sm:pl-12">
        {item.canDecide && item.approve && !item.stale ? (
          <Button size="sm" icon={<Check className="size-3.5" aria-hidden />} loading={busy === "approve"} disabled={Boolean(busy)} onClick={() => void decide("approve")}>
            {APPROVE_LABEL[item.kind]}
          </Button>
        ) : null}
        {item.canDecide && item.reject ? (
          <Button size="sm" variant="ghost" loading={busy === "reject"} disabled={Boolean(busy)} onClick={() => void decide("reject")}>
            {REJECT_LABEL[item.kind]}
          </Button>
        ) : null}
        {review ? (
          <Link href={review} className="ml-auto inline-flex items-center gap-0.5 text-footnote font-medium text-accent hover:underline">
            Review
            <ArrowUpRight className="size-3" aria-hidden />
          </Link>
        ) : null}
      </div>
    </article>
  );
}

/** The list of decisions (the app Home and the top-bar sheet). */
export function NeedsYouList({ items, showApp }: { items: NeedsYouItem[]; showApp?: boolean }) {
  const { apps } = useWorkspace();
  const name = (id?: string) => (showApp && id ? apps.find((a) => a.id === id)?.name : undefined);
  return (
    <ul className="space-y-3" aria-label="Needs you">
      {items.map((i) => (
        <li key={i.id}>
          <NeedsYouCard item={i} appName={name(i.appId)} compact={showApp} />
        </li>
      ))}
    </ul>
  );
}

/**
 * Top-bar badge: how many decisions are waiting, one tap from the list. Hidden when nothing needs
 * you, so the bar stays quiet.
 */
export function NeedsYouButton({ workspaceId }: { workspaceId: string }) {
  const [open, setOpen] = useState(false);
  const q = useNeedsYou(workspaceId);
  const count = q.data?.count ?? 0;
  if (!count) return null;
  return (
    <Sheet
      open={open}
      onOpenChange={setOpen}
      title="Needs you"
      description="MuseLaunch never posts, sends or spends past a budget without you. Everything else runs on its own."
      trigger={
        <button
          type="button"
          aria-label={`Needs you: ${count} decision${count === 1 ? "" : "s"}`}
          className="inline-flex h-8 items-center gap-1.5 rounded-full border border-warning/40 bg-warning-soft px-2.5 text-footnote font-medium text-ink transition-colors hover:border-warning/70 focus-visible:outline-none focus-visible:shadow-focus"
        >
          <Hand className="size-3.5 text-warning" aria-hidden />
          <span className="hidden sm:inline">Needs you</span>
          <span className="flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-warning px-1 text-[11px] font-semibold tabular text-white">{count}</span>
        </button>
      }
    >
      <div className="space-y-4 p-4">
        <NeedsYouList items={q.data?.items ?? []} showApp />
        {count > (q.data?.items.length ?? 0) ? <p className="text-footnote text-ink-3">Showing the newest {q.data?.items.length}.</p> : null}
      </div>
    </Sheet>
  );
}
