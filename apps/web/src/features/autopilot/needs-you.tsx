"use client";
/**
 * "Needs you": the only decisions MuseLaunch can't make on its own, as one list of cards with one
 * primary button each (+ "not this one" where there is one): publishing a post, sending outreach,
 * spending beyond a run's budget, letting a loop continue, checking what we learned about an app
 * (About your app) and fixing a video the Brand check blocked. Data: GET /needs-you (+ ?appId=).
 * Approvals name their existing decision route, which keeps its permission and snapshot checks;
 * this UI only calls it. About-your-app and Brand-check items link to the page where that decision
 * is made. Create videos that stopped for the person ("Your video needs a look…") answer through
 * their resolve route; finishing past the Brand check asks for a reason right in the card.
 *
 * Entry points: the app's Home (its count is the badge on the Home tab), the run's progress screen
 * and the page /w/:workspaceId/needs-you (NeedsYouPage; old links, nothing in the nav points to it).
 */
import type { App, Channel, NeedsYouItem, NeedsYouResponse } from "@muselaunch/contracts";
import { Badge, Button, EmptyState, ErrorState, Input, PageHeader, SegmentedControl, Skeleton, cn, useToast } from "@muselaunch/ui";
import { useQueries } from "@tanstack/react-query";
import { ArrowRight, ArrowUpRight, Check, Coins, Hand, Info, Mail, Send, ShieldAlert, Sparkles } from "lucide-react";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import { AppIcon } from "@/components/app-icon";
import { api, errorMessage, wsPath } from "@/lib/api";
import { CHANNEL_LABEL } from "@/lib/labels";
import { keyFor, useApiQuery, useInvalidate } from "@/lib/query";
import { routes } from "@/lib/routes";
import { useWorkspace } from "@/lib/workspace";
import { MediaDecisionFootage, useRecordingState } from "./media-ask";
import { isActive, isWorking, STATUS_COPY, type AutopilotListItem } from "./types";

const KIND_ICON: Record<NeedsYouItem["kind"], ReactNode> = {
  post: <Send aria-hidden />,
  outreach: <Mail aria-hidden />,
  spend: <Coins aria-hidden />,
  decision: <Hand aria-hidden />,
  app_dna: <Info aria-hidden />,
  brand_check: <ShieldAlert aria-hidden />,
  suggestion: <Sparkles aria-hidden />,
};

/** The one primary action per kind. Approvals call their route; the others open a page. */
const PRIMARY_LABEL: Record<NeedsYouItem["kind"], string> = {
  post: "Approve post",
  outreach: "Approve and send",
  spend: "Approve spend",
  decision: "Continue",
  app_dna: "Check it",
  brand_check: "Fix the video",
  suggestion: "Make a video",
};
const SECONDARY_LABEL: Record<NeedsYouItem["kind"], string> = { post: "Not this one", outreach: "Don’t send", spend: "Not now", decision: "Pause", app_dna: "", brand_check: "", suggestion: "Not now" };

export const WHO: Record<string, string> = {
  publish: "someone who can publish",
  "outreach.send": "someone who can send outreach",
  "billing.manage": "someone who manages billing",
  "content.approve": "an owner or admin",
  "apps.write": "an editor, admin or owner",
  "content.write": "an editor, admin or owner",
};

/** Kinds decided on another page: the card's primary button is a link to `reviewPath`. */
const OPENS_PAGE = (k: NeedsYouItem["kind"]) => k === "app_dna" || k === "brand_check";

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

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Make a Needs-you decision: calls the item's own route (which keeps its permission and snapshot
 * checks), says what happened, and refreshes everything that shows decisions. Also used by Home's
 * next post ("Schedule post" / "Skip"), which brings its own words for what happened (`said`).
 */
export function useNeedsYouDecision(item: NeedsYouItem, said: { approved?: { title: string; text: string } } = {}) {
  const { workspaceId } = useWorkspace();
  const toast = useToast();
  const invalidate = useInvalidate();
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  /** `extra`: what the person typed (e.g. the reason an item's `approveReason` asks for). */
  const decide = async (which: "approve" | "reject", extra: Record<string, unknown> = {}) => {
    const route = which === "approve" ? item.approve : item.reject;
    if (!route) return;
    setBusy(which);
    try {
      await api.post(wsPath(workspaceId, route.path), { ...(route.body ?? {}), ...extra });
      if (which === "approve" && said.approved) toast.success(said.approved.title, said.approved.text);
      else toast.success(
        which === "approve" ? (item.kind === "post" ? "Post approved" : item.kind === "spend" ? "Spend approved" : "Approved") : "Got it",
        // Items can bring their own words (Always on's suggestions and pace decision).
        (which === "approve" ? item.labels?.approved : item.labels?.rejected) ??
        (which === "approve"
          ? item.kind === "post"
            ? "It goes out at its scheduled time, or you post it yourself where the channel needs that."
            : "Autopilot carries on."
          : item.kind === "spend" || item.kind === "decision"
            ? "Autopilot is paused. Resume it whenever you like."
            : "Nothing was sent."),
      );
      // "/apps" also covers each app's Today and Create runs.
      await invalidate(wsPath(workspaceId, "/needs-you"), wsPath(workspaceId, "/autopilots"), wsPath(workspaceId, "/apps"), wsPath(workspaceId, "/approvals"), wsPath(workspaceId, "/posts"));
    } catch (e) {
      toast.error("Couldn’t record that", errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  return { busy, decide };
}

/** One decision, ready for a single tap. */
export function NeedsYouCard({ item, appName, compact }: { item: NeedsYouItem; appName?: string; compact?: boolean }) {
  const { workspaceId } = useWorkspace();
  const { busy, decide } = useNeedsYouDecision(item);
  const review = item.reviewPath ? `/w/${workspaceId}${item.reviewPath}` : null;
  const opensPage = OPENS_PAGE(item.kind);
  const pv = item.preview;
  // The run waits for real footage of the app: the upload is right in the card, then Continue.
  const media = item.kind === "decision" && Boolean(pv?.needsMedia) && Boolean(item.appId);
  const rec = useRecordingState(workspaceId, media ? item.appId : null);
  const footageIn = rec.state === "processing" || rec.state === "ready";
  const meta = [
    pv?.channel ? (CHANNEL_LABEL[pv.channel as Channel] ?? pv.channel) : null,
    pv?.scheduledAt ? when(pv.scheduledAt) : null,
    pv?.to ? `To ${pv.to}` : null,
    item.kind === "app_dna" && pv?.factsToCheck ? plural(pv.factsToCheck, "fact") + " to check" : null,
    item.kind === "brand_check" && pv?.blockingIssues ? plural(pv.blockingIssues, "issue") + " to fix" : null,
  ].filter(Boolean);
  const showCaption = Boolean(pv?.caption) && (item.kind === "post" || item.kind === "outreach");
  const summary = media ? (footageIn ? "Your videos show your real app." : "Your videos show your real app, and there’s no footage of it yet. Add a screen recording, then press Continue.") : item.summary;
  // Long explanations (e.g. a loop's checkpoint) stay three lines until asked for.
  const long = !showCaption && summary.length > 240;
  const [expanded, setExpanded] = useState(false);
  // Approving needs a short reason typed here (e.g. finishing a video past the Brand check).
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState("");
  return (
    <article className={cn("space-y-3 rounded-xl bg-surface shadow-raised", compact ? "p-4" : "p-5")} aria-label={item.title}>
      <div className="flex items-start gap-3">
        <span
          className={cn(
            "flex size-9 shrink-0 items-center justify-center rounded-full [&_svg]:size-4",
            item.kind === "spend" || item.kind === "brand_check" ? "bg-warning-soft text-warning" : "bg-accent-soft text-accent",
          )}
        >
          {KIND_ICON[item.kind]}
        </span>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="text-body-sm font-semibold text-ink text-pretty">{item.title}</h3>
            {item.credits ? <Badge tone="warning">≈{item.credits} credits</Badge> : null}
          </div>
          {appName ? <p className="text-caption text-ink-3">{appName}</p> : null}
          {showCaption ? (
            <p className="line-clamp-3 text-footnote text-ink-2">
              {pv?.subjectLine ? <span className="font-medium text-ink">{pv.subjectLine} · </span> : null}
              {pv?.caption}
            </p>
          ) : (
            <div>
              <p id={`ny-summary-${item.id}`} className={cn("break-words text-footnote text-ink-2 text-pretty", long && !expanded && "line-clamp-3")}>
                {summary}
              </p>
              {long ? (
                <button
                  type="button"
                  aria-expanded={expanded}
                  aria-controls={`ny-summary-${item.id}`}
                  onClick={() => setExpanded((v) => !v)}
                  className="mt-0.5 rounded-sm text-footnote font-medium text-accent hover:underline focus-visible:outline-none focus-visible:shadow-focus"
                >
                  {expanded ? "Show less" : "Show all"}
                </button>
              ) : null}
            </div>
          )}
          {meta.length ? <p className="text-caption text-ink-3">{meta.join(" · ")}</p> : null}
          {media && item.appId ? (
            <div className="pt-2">
              <MediaDecisionFootage appId={item.appId} rec={rec} compact={compact} />
            </div>
          ) : null}
        </div>
      </div>
      {item.stale ? (
        <p className="text-footnote text-warning sm:pl-12">This changed after approval was requested. Review the latest version.</p>
      ) : !item.canDecide ? (
        <p className="text-footnote text-ink-2 sm:pl-12">Waiting for {WHO[item.requiredCap] ?? "someone with permission"} to decide.</p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2 sm:pl-12">
        {opensPage && review && item.canDecide ? (
          <Button size="sm" asChild>
            <Link href={review}>
              {PRIMARY_LABEL[item.kind]}
              <ArrowRight className="size-3.5" aria-hidden />
            </Link>
          </Button>
        ) : null}
        {!opensPage && item.canDecide && item.approve && !item.stale && item.approveReason && asking ? (
          <form
            className="flex w-full flex-col gap-2 sm:flex-row"
            onSubmit={(e) => {
              e.preventDefault();
              if (reason.trim().length >= 3) void decide("approve", { reason: reason.trim() });
            }}
          >
            <label htmlFor={`ny-reason-${item.id}`} className="sr-only">
              {item.approveReason.label}
            </label>
            <Input id={`ny-reason-${item.id}`} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={item.approveReason.placeholder ?? item.approveReason.label} maxLength={500} className="h-10 min-w-0 flex-1" autoFocus />
            <Button size="sm" type="submit" icon={<Check className="size-3.5" aria-hidden />} disabled={reason.trim().length < 3 || Boolean(busy)} loading={busy === "approve"}>
              {item.labels?.approve ?? PRIMARY_LABEL[item.kind]}
            </Button>
          </form>
        ) : !opensPage && item.canDecide && item.approve && !item.stale ? (
          // Waiting for footage: Continue is the obvious next step once a recording is in (before that, the upload is).
          <Button
            size="sm"
            variant={media && !footageIn ? "secondary" : "primary"}
            icon={<Check className="size-3.5" aria-hidden />}
            loading={busy === "approve"}
            disabled={Boolean(busy)}
            onClick={() => (item.approveReason ? setAsking(true) : void decide("approve"))}
          >
            {item.labels?.approve ?? PRIMARY_LABEL[item.kind]}
            {item.approveReason ? "…" : null}
          </Button>
        ) : null}
        {!opensPage && item.canDecide && item.reject && !asking ? (
          <Button size="sm" variant="ghost" loading={busy === "reject"} disabled={Boolean(busy)} onClick={() => void decide("reject")}>
            {item.labels?.reject ?? SECONDARY_LABEL[item.kind]}
          </Button>
        ) : null}
        {review && !(opensPage && item.canDecide) ? (
          <Link href={review} className="ml-auto inline-flex items-center gap-0.5 rounded-sm text-footnote font-medium text-accent hover:underline focus-visible:outline-none focus-visible:shadow-focus">
            {item.labels?.review ?? (opensPage ? "Open" : "Review")}
            <ArrowUpRight className="size-3" aria-hidden />
          </Link>
        ) : null}
      </div>
    </article>
  );
}

/**
 * The list of decisions (the app Home, the top-bar sheet and the Needs you page). `group`: one
 * section per app when the items span several apps.
 */
export function NeedsYouList({ items, showApp, group, compact = showApp }: { items: NeedsYouItem[]; showApp?: boolean; group?: boolean; compact?: boolean }) {
  const { apps, workspaceId } = useWorkspace();
  const appOf = (id?: string) => (id ? apps.find((a) => a.id === id) : undefined);
  const appIds = [...new Set(items.map((i) => i.appId ?? ""))];
  if (group && appIds.length > 1) {
    return (
      <div className="space-y-8">
        {appIds.map((id) => {
          const app = appOf(id);
          const mine = items.filter((i) => (i.appId ?? "") === id);
          return (
            <section key={id || "workspace"} aria-labelledby={`ny-${id || "workspace"}`} className="space-y-3">
              <h2 id={`ny-${id || "workspace"}`} className="flex items-center gap-2 text-body-sm font-semibold text-ink">
                {app ? <AppIcon app={app} workspaceId={workspaceId} size={22} /> : null}
                <span className="truncate">{app?.name ?? "This workspace"}</span>
                <span className="text-footnote font-normal text-ink-3 tabular">{mine.length}</span>
              </h2>
              <ul className="space-y-3" aria-label={`Needs you for ${app?.name ?? "this workspace"}`}>
                {mine.map((i) => (
                  <li key={i.id}>
                    <NeedsYouCard item={i} compact={compact} />
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    );
  }
  return (
    <ul className="space-y-3" aria-label="Needs you">
      {items.map((i) => (
        <li key={i.id}>
          <NeedsYouCard item={i} appName={showApp ? appOf(i.appId)?.name : undefined} compact={compact} />
        </li>
      ))}
    </ul>
  );
}

/** What a loop is doing, in plain words (from its stage; the loop page has the detailed log). */
export const DOING: Record<AutopilotListItem["stage"], string> = {
  understand: "Learning about your app",
  research: "Researching your audience",
  select_audience: "Choosing who to reach",
  hypothesis: "Deciding what to test",
  plan_creative: "Planning ideas",
  produce: "Making videos",
  verify: "Checking the videos",
  render: "Rendering videos",
  schedule: "Drafting posts",
  measure: "Waiting for real results",
  learn: "Learning from the results",
  done: "Finishing up",
};
const doing = (loop: AutopilotListItem) => DOING[loop.stage];

/** What Autopilot is doing in each app right now (shared cache with useActiveAutopilot). */
function useAutopilotActivity(workspaceId: string, apps: App[]) {
  const results = useQueries({
    queries: apps.map((a) => {
      const path = wsPath(workspaceId, `/apps/${a.id}/autopilots`);
      return {
        queryKey: keyFor(path),
        queryFn: ({ signal }: { signal: AbortSignal }) => api.get<{ items: AutopilotListItem[] }>(path, { signal }),
        staleTime: 10_000,
        retry: false,
      };
    }),
  });
  return apps.flatMap((app, i) => {
    const loop = results[i]?.data?.items.find((x) => isActive(x.status));
    return loop ? [{ app, loop }] : [];
  });
}

/**
 * Empty state. "Autopilot is working" only when a loop really is (running, or measuring results),
 * with what it's doing; otherwise a plain "nothing right now".
 */
export function NothingNeedsYou({ appId, compact }: { appId?: string | null; compact?: boolean }) {
  const { workspaceId, apps } = useWorkspace();
  const scope = appId ? apps.filter((a) => a.id === appId) : apps;
  const activity = useAutopilotActivity(workspaceId, scope);
  const working = activity.filter((x) => isWorking(x.loop.status) || x.loop.status === "sleeping");
  const first = scope[0];
  return (
    <div className="rounded-2xl bg-mist/60">
      <EmptyState
        size={compact ? "sm" : "md"}
        icon={working.length ? <Sparkles aria-hidden /> : <Check aria-hidden />}
        title={working.length ? "Nothing needs you. Autopilot is working." : "Nothing needs you right now."}
        description={
          working.length ? (
            <ul className="space-y-1.5">
              {working.map(({ app, loop }) => (
                <li key={app.id}>
                  {scope.length > 1 ? <span className="font-medium text-ink">{app.name}: </span> : null}
                  {loop.status === "sleeping" ? STATUS_COPY[loop.status] : "Now"}: {doing(loop)}
                </li>
              ))}
            </ul>
          ) : (
            "Decisions show up here when something is ready: a post or outreach to approve, extra credits, a check of what we learned about your app, or a video that didn’t pass the Brand check."
          )
        }
        action={
          working.length === 1 ? (
            <Button size="sm" variant="secondary" asChild>
              <Link href={`${routes.app(workspaceId, working[0]!.app.id).autopilot}?loop=${encodeURIComponent(working[0]!.loop.id)}`}>See what Autopilot is doing</Link>
            </Button>
          ) : !working.length && first && !compact ? (
            <Button size="sm" variant="secondary" asChild>
              <Link href={routes.app(workspaceId, first.id).home}>Go to Home</Link>
            </Button>
          ) : null
        }
      />
    </div>
  );
}

/** The Needs you page: every decision, grouped by app, with an app filter when there are several. */
export function NeedsYouPage({ appId }: { appId?: string | null }) {
  const { workspaceId, apps } = useWorkspace();
  const filter = appId && apps.some((a) => a.id === appId) ? appId : null;
  const q = useNeedsYou(workspaceId, filter);
  const all = useNeedsYou(workspaceId, null, { enabled: Boolean(filter) });
  const count = q.data?.count ?? 0;
  const items = q.data?.items ?? [];
  return (
    <div className="space-y-8">
      <PageHeader
        title="Needs you"
        description="The few things MuseLaunch won’t do without you: posting, sending outreach, spending past a budget, and checks only you can make. Everything else runs on its own."
        className="pb-0"
      />
      {apps.length > 1 ? (
        <div className="-mx-1 overflow-x-auto px-1 pb-1">
          <SegmentedControl
            label="Show decisions for"
            size="sm"
            value={filter ?? "all"}
            items={[
              { value: "all", label: `All apps${filter ? (all.data ? ` · ${all.data.count}` : "") : count ? ` · ${count}` : ""}`, href: routes.needsYou(workspaceId) },
              ...apps.map((a) => ({ value: a.id, label: a.name, href: routes.needsYou(workspaceId, a.id) })),
            ]}
            renderLink={(p) => (
              <Link href={p.href} className={p.className} aria-current={p["aria-current"]} prefetch={false}>
                {p.children}
              </Link>
            )}
          />
        </div>
      ) : null}
      {q.isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-32" rounded="xl" />
          <Skeleton className="h-32" rounded="xl" />
        </div>
      ) : q.error ? (
        <ErrorState title="Decisions didn’t load" message={errorMessage(q.error)} onRetry={() => q.refetch()} retrying={q.isFetching} reference={q.error.requestId} />
      ) : items.length ? (
        <>
          <NeedsYouList items={items} group={!filter} showApp={!filter && apps.length > 1} compact={false} />
          {count > items.length ? <p className="text-footnote text-ink-3">Showing the newest {items.length} of {count}.</p> : null}
        </>
      ) : (
        <NothingNeedsYou appId={filter} />
      )}
    </div>
  );
}
