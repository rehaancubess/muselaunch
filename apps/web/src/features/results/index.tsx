"use client";
/**
 * Results: "See what is working". One calm page:
 *  - three numbers (Views, Link clicks, Posts published), each saying where it comes from, or "Not
 *    measured yet" with the one action that would measure it;
 *  - a daily chart of the main number (views, else link clicks): real daily numbers only, a day
 *    without one is a gap, hidden with one line when fewer than 3 days are measured;
 *  - the best-performing post (per-post numbers only) and one tip (only from a test with enough data
 *    or a grounded recommendation, never as a cause, with its sample size) that deep-links to Create;
 *  - "What Muse found this week" (1–2 sourced ideas), Connect your data, and Details.
 *
 * Data: GET /insights/overview (the totals, their sources and what's missing, shared with "How it's
 * going"), GET /insights/results (daily series, posts published, best post), the latest test result,
 * recommendations and the Discover feed. Nothing is estimated here.
 */
import type { Experiment, ExperimentResult, GrowthRecommendation, InsightsOverview, ResultsSummary } from "@muselaunch/contracts";
import { Button, Select, Skeleton, cn } from "@muselaunch/ui";
import { ArrowRight, ArrowUpRight, BarChart3, CalendarDays, ChevronRight, Compass, Eye, Globe, Layers, MousePointerClick, Sparkles } from "lucide-react";
import Link from "next/link";
import { useMemo, useState, type ReactNode } from "react";
import { useAssetUrl } from "@/components/app-icon";
import { primarySource, siteName, type FeedResponse } from "@/features/discover/picks";
import { ConnectYourData, useSources, type SourcesState } from "@/features/insights/simple";
import { nextStep } from "@/features/insights/simple-lines";
import { PostSheet } from "@/features/publishing/post-sheet";
import { PlatformGlyph } from "@/features/publishing/where-you-post";
import { errorMessage, wsPath } from "@/lib/api";
import type { Page } from "@/lib/api-types";
import { CHANNEL_LABEL } from "@/lib/labels";
import { useApiQuery } from "@/lib/query";
import { routes } from "@/lib/routes";
import { useWorkspace } from "@/lib/workspace";
import { DailyChart } from "./chart";
import {
  RANGES,
  bestPostLine,
  chartCaption,
  chartFootnote,
  chartHiddenLine,
  coverageLine,
  fullNumber,
  isRangeKey,
  latestTestWithResult,
  nothingYet,
  pickTip,
  rangeQuery,
  shortNumber,
  tiles as buildTiles,
  weekIdeas,
  type RangeKey,
  type Tile,
  type TileAction,
  type Tip,
} from "./results-lines";

export default function Results({ appId }: { appId: string }) {
  const { workspaceId } = useWorkspace();
  const [range, setRange] = useState<RangeKey>("28");
  const query = useMemo(() => rangeQuery(range), [range]);
  const overview = useApiQuery<InsightsOverview>(wsPath(workspaceId, `/apps/${appId}/insights/overview`), { query: { ...query, compare: "none" }, placeholderData: (prev) => prev });
  const results = useApiQuery<ResultsSummary>(wsPath(workspaceId, `/apps/${appId}/insights/results`), { query, placeholderData: (prev) => prev });
  const sources = useSources(appId);
  const r = routes.app(workspaceId, appId);

  const ov = overview.data;
  const res = results.data;
  const loading = (overview.isLoading || results.isLoading) && !(ov && res);
  const failed = (overview.error && !ov) || (results.error && !res);
  const t = ov && res ? buildTiles(ov.metrics, ov.missing, res.postsPublished, sources.youtube, range) : [];
  const empty = Boolean(ov && res && nothingYet(t));
  const canWiden = Boolean(ov && range !== "90" && (range === "7" || ov.missing.some((m) => m.action === "widen_range")));
  const showRange = Boolean(ov && res && (!empty || range !== "28" || canWiden));
  const fetching = overview.isFetching || results.isFetching;

  return (
    <div className="space-y-10 sm:space-y-12">
      <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
        <h1 className="text-title-1 font-semibold text-balance">See what is working</h1>
        {showRange ? <RangeSelect value={range} onChange={setRange} /> : null}
      </header>

      {loading ? (
        <div className="space-y-6" aria-busy>
          <div className="grid gap-3 sm:grid-cols-3">
            {Array.from({ length: 3 }, (_, i) => (
              <Skeleton key={i} className="h-[104px]" rounded="xl" />
            ))}
          </div>
          <Skeleton className="h-[180px]" rounded="xl" />
        </div>
      ) : failed ? (
        <Calm
          title="Couldn’t load your results"
          body={errorMessage(overview.error ?? results.error)}
          action={
            <Button size="lg" variant="outline" onClick={() => void Promise.all([overview.refetch(), results.refetch()])} loading={fetching}>
              Try again
            </Button>
          }
        />
      ) : ov && res ? (
        empty ? (
          <EmptyResults appId={appId} range={range} canWiden={canWiden} onWiden={() => setRange("90")} step={nextStep(ov.missing, sources.youtube)} sources={sources} />
        ) : (
          <div className={cn("space-y-10 sm:space-y-12", fetching && "opacity-70 transition-opacity")}>
            <section aria-label="Your numbers" className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-3">
                {t.map((tile) => (
                  <NumberTile key={tile.key} tile={tile} appId={appId} sources={sources} onWiden={() => setRange("90")} />
                ))}
              </div>
              {coverageLine(ov.metrics) ? <p className="text-footnote text-ink-2">{coverageLine(ov.metrics)}</p> : null}
            </section>

            <ChartSection summary={res} rangeDays={Number(range)} />

            <BestAndTip appId={appId} best={res.bestPost} />
          </div>
        )
      ) : null}

      <WhatMuseFound appId={appId} />

      {!loading ? <ConnectYourData appId={appId} sources={sources} installsMeasured={Boolean(ov?.metrics.some((m) => m.metric === "installs" && m.value !== null))} skipYouTube={empty && nextStep(ov?.missing ?? [], sources.youtube) === "connect_youtube"} /> : null}

      <div className="flex flex-col gap-3 border-t border-line pt-8 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-body-sm text-ink-2">Your tests, filters, data sources and every number with its source.</p>
        <Button asChild size="lg" variant="outline">
          <Link href={r.insightsDetails()}>
            Details
            <ArrowRight className="size-4" aria-hidden />
          </Link>
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header: the date range
// ---------------------------------------------------------------------------

function RangeSelect({ value, onChange }: { value: RangeKey; onChange: (v: RangeKey) => void }) {
  return (
    <div className="relative w-full sm:w-auto">
      <Select aria-label="Date range" selectSize="lg" className="rounded-xl pl-10 font-medium sm:w-48" value={value} onChange={(e) => isRangeKey(e.target.value) && onChange(e.target.value)} options={RANGES} />
      <CalendarDays className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-ink-2" aria-hidden />
    </div>
  );
}

// ---------------------------------------------------------------------------
// The three numbers
// ---------------------------------------------------------------------------

const TILE_ICON: Record<Tile["key"], ReactNode> = {
  views: <Eye aria-hidden />,
  clicks: <MousePointerClick aria-hidden />,
  posts: <Layers aria-hidden />,
};

function NumberTile({ tile, appId, sources, onWiden }: { tile: Tile; appId: string; sources: SourcesState; onWiden: () => void }) {
  return (
    <div className="flex items-start gap-4 rounded-xl bg-surface px-5 py-4 shadow-raised">
      <span className="mt-1 flex size-10 shrink-0 items-center justify-center rounded-full bg-mist text-ink-2 [&_svg]:size-5">{TILE_ICON[tile.key]}</span>
      <div className="min-w-0 flex-1">
        {tile.value !== null ? (
          <>
            <p className="text-[28px] font-semibold leading-[34px] tracking-[-0.02em] text-ink tabular-nums" title={`${fullNumber(tile.value)} ${tile.label.toLowerCase()}`}>
              {shortNumber(tile.value)}
            </p>
            <p className="text-body-sm text-ink-2">{tile.label}</p>
            {tile.source ? <p className="mt-1 text-caption text-ink-3">{tile.scope ? `${tile.source} · ${tile.scope.toLowerCase()}` : tile.source}</p> : null}
          </>
        ) : (
          <>
            <p className="pt-1 text-body font-semibold leading-[26px] text-ink">Not measured yet</p>
            <p className="text-body-sm text-ink-2">{tile.label}</p>
            {tile.action ? <TileActionButton action={tile.action} appId={appId} sources={sources} onWiden={onWiden} /> : null}
          </>
        )}
      </div>
    </div>
  );
}

function TileActionButton({ action, appId, sources, onWiden }: { action: TileAction; appId: string; sources: SourcesState; onWiden: () => void }) {
  const { workspaceId } = useWorkspace();
  const r = routes.app(workspaceId, appId);
  const cls = "min-h-11 justify-start text-body-sm font-medium";
  const label = (
    <>
      {action.label}
      <ArrowRight className="size-3.5" aria-hidden />
    </>
  );
  if (action.kind === "widen")
    return (
      <Button variant="link" className={cls} onClick={onWiden}>
        {label}
      </Button>
    );
  if (action.kind === "connect_youtube")
    return (
      <Button variant="link" className={cls} onClick={() => void sources.connectYouTube()} loading={sources.connecting} disabled={!sources.canManage} title={sources.canManage ? undefined : "Ask a workspace owner to connect YouTube."}>
        {label}
      </Button>
    );
  return (
    <Button asChild variant="link" className={cls}>
      <Link href={action.kind === "home" ? r.home : r.insightsDetails("sources", { focus: action.focus })}>{label}</Link>
    </Button>
  );
}

// ---------------------------------------------------------------------------
// The chart
// ---------------------------------------------------------------------------

function ChartSection({ summary, rangeDays }: { summary: ResultsSummary; rangeDays: number }) {
  const s = summary.series;
  if (!s) return null;
  const hidden = chartHiddenLine(s, rangeDays);
  if (hidden)
    return (
      <p className="flex items-start gap-3 rounded-xl bg-mist/70 px-5 py-4 text-body-sm text-ink-2 text-pretty">
        <BarChart3 className="mt-0.5 size-4 shrink-0" aria-hidden />
        {hidden}
      </p>
    );
  const foot = chartFootnote(s);
  return (
    <section aria-label={`${s.label} per day`} className="space-y-2">
      <p className="text-footnote font-medium text-ink-2">{chartCaption(s)}</p>
      <DailyChart series={s} />
      {foot ? <p className="text-caption text-ink-3 text-pretty">{foot}</p> : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Best-performing post + the tip
// ---------------------------------------------------------------------------

function BestAndTip({ appId, best }: { appId: string; best: ResultsSummary["bestPost"] }) {
  const tip = useTip(appId);
  if (!best && !tip) return null;
  return (
    <div className={cn("grid gap-x-6 gap-y-10", best && tip && "md:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)]")}>
      {best ? <BestPost best={best} /> : null}
      {tip ? <TipCard tip={tip} appId={appId} heading={!best} /> : null}
    </div>
  );
}

function BestPost({ best }: { best: NonNullable<ResultsSummary["bestPost"]> }) {
  const { workspaceId } = useWorkspace();
  const [open, setOpen] = useState(false);
  const thumb = useAssetUrl(workspaceId, best.thumbnailAssetId);
  const channel = CHANNEL_LABEL[best.channel] ?? best.channel;
  const glyph = ["instagram", "youtube", "tiktok", "linkedin", "x"].includes(best.channel);
  const what = best.metric === "views" ? "Views" : "Link clicks";
  return (
    <section aria-labelledby="best-heading" className="space-y-3">
      <h2 id="best-heading" className="text-headline font-semibold">
        Best-performing post
      </h2>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="group flex w-full items-center gap-4 rounded-xl bg-surface p-3 text-left shadow-raised transition-shadow hover:shadow-[0_6px_20px_-6px_rgb(16_24_40/0.14),0_0_0_1px_rgb(16_24_40/0.07)] focus-visible:outline-none focus-visible:shadow-focus"
        aria-label={`${best.title}, ${channel}: ${fullNumber(best.value)} ${what.toLowerCase()}. Open the post`}
      >
        <span className="relative size-16 shrink-0 overflow-hidden rounded-lg bg-accent-soft">
          {thumb.data?.url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={thumb.data.url} alt="" className="size-full object-cover" />
          ) : (
            <span className="flex size-full items-center justify-center text-accent">
              <Layers className="size-5" aria-hidden />
            </span>
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="line-clamp-2 text-body font-semibold text-ink">{best.title}</span>
          <span className="mt-1 flex items-center gap-1.5 text-footnote text-ink-2">
            {glyph ? <PlatformGlyph channel={best.channel as "instagram"} className="size-4" /> : <Globe className="size-4" aria-hidden />}
            {channel}
          </span>
        </span>
        <span className="shrink-0 text-right">
          <span className="block text-title-3 font-semibold text-ink tabular-nums">{shortNumber(best.value)}</span>
          <span className="block text-caption text-ink-2">{what}</span>
        </span>
        <ChevronRight className="size-5 shrink-0 text-ink-3 transition-transform group-hover:translate-x-0.5" aria-hidden />
      </button>
      <p className="text-caption text-ink-3">{bestPostLine(best)}</p>
      <PostSheet postId={open ? best.scheduledPostId : null} onOpenChange={setOpen} />
    </section>
  );
}

/** The latest test with a result, else Muse's recommendations: at most one tip, or none. */
function useTip(appId: string): Tip | null {
  const { workspaceId } = useWorkspace();
  const list = useApiQuery<Page<Experiment>>(wsPath(workspaceId, `/apps/${appId}/experiments`));
  const latest = latestTestWithResult(list.data?.items ?? []);
  const detail = useApiQuery<{ experiment: Experiment; results: ExperimentResult[] }>(latest ? wsPath(workspaceId, `/experiments/${latest.id}`) : null);
  const recs = useApiQuery<Page<GrowthRecommendation>>(wsPath(workspaceId, `/apps/${appId}/recommendations`));
  if (list.isLoading || (latest && detail.isLoading) || recs.isLoading) return null;
  const result = detail.data ? (detail.data.results.find((x) => x.id === detail.data!.experiment.lastResultId) ?? detail.data.results[0]) : undefined;
  return pickTip(detail.data ? { exp: detail.data.experiment, result } : null, recs.data?.items ?? []);
}

function TipCard({ tip, appId, heading }: { tip: Tip; appId: string; heading: boolean }) {
  const { workspaceId } = useWorkspace();
  const card = (
    <article aria-label={tip.title} className="flex h-full flex-col gap-3 rounded-xl bg-surface p-5 shadow-raised">
      <div className="flex items-start gap-3">
        <Sparkles className="mt-0.5 size-5 shrink-0 text-accent" aria-hidden />
        <div className="min-w-0 space-y-1">
          <h3 className="text-body font-semibold text-ink text-balance">{tip.title}</h3>
          <p className="text-body-sm text-ink-2 text-pretty">{tip.body}</p>
          <p className="text-caption text-ink-3 text-pretty">
            {tip.basis}
            {tip.caution ? ` ${tip.caution}` : ""}
          </p>
        </div>
      </div>
      <Button asChild size="lg" className="mt-auto w-full rounded-lg">
        <Link href={routes.app(workspaceId, appId).create({ kind: tip.kind, prompt: tip.prompt })}>{tip.button}</Link>
      </Button>
    </article>
  );
  if (!heading) return <div className="md:pt-9">{card}</div>;
  return (
    <section aria-labelledby="tip-heading" className="space-y-3">
      <h2 id="tip-heading" className="text-headline font-semibold">
        A tip from your results
      </h2>
      {card}
    </section>
  );
}

// ---------------------------------------------------------------------------
// What Muse found this week
// ---------------------------------------------------------------------------

function WhatMuseFound({ appId }: { appId: string }) {
  const { workspaceId } = useWorkspace();
  const feed = useApiQuery<FeedResponse>(wsPath(workspaceId, `/apps/${appId}/discover/feed`), { query: { limit: 20 }, retry: false });
  const r = routes.app(workspaceId, appId);
  const { items, thisWeek } = weekIdeas(feed.data?.items ?? []);
  if (!items.length) return null;
  return (
    <section aria-labelledby="found-heading" className="rounded-xl bg-surface p-5 shadow-raised">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <h2 id="found-heading" className="flex items-center gap-2 text-headline font-semibold">
          <Compass className="size-5 text-accent" aria-hidden />
          {thisWeek ? "What Muse found this week" : "What Muse found"}
        </h2>
        <Button asChild variant="link" className="min-h-11 text-body-sm font-medium">
          <Link href={r.create({ kind: "idea" })}>
            More ideas
            <ArrowRight className="size-3.5" aria-hidden />
          </Link>
        </Button>
      </div>
      <ul className="mt-2 divide-y divide-line">
        {items.map((item) => {
          const source = primarySource(item);
          return (
            <li key={item.id} className="py-3 first:pt-1 last:pb-0">
              <Link href={r.create({ kind: "idea", ideaId: item.refId })} className="group flex min-h-11 items-center justify-between gap-3 rounded-md text-body font-medium text-ink focus-visible:outline-none focus-visible:shadow-focus">
                <span className="min-w-0 text-pretty">{item.title}</span>
                <ChevronRight className="size-4 shrink-0 text-ink-3 transition-transform group-hover:translate-x-0.5" aria-hidden />
              </Link>
              {source ? (
                source.url ? (
                  <a href={source.url} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex min-h-8 max-w-full items-center gap-1 text-footnote text-ink-2 hover:text-ink focus-visible:outline-none focus-visible:shadow-focus" title={source.title ?? source.url}>
                    <span className="truncate">
                      Found on <span className="font-medium">{siteName(source)}</span>
                    </span>
                    <ArrowUpRight className="size-3.5 shrink-0" aria-hidden />
                    <span className="sr-only">(opens in a new tab)</span>
                  </a>
                ) : (
                  <p className="text-footnote text-ink-2">
                    Found in <span className="font-medium">{siteName(source)}</span>
                  </p>
                )
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Empty state and quiet notices
// ---------------------------------------------------------------------------

function EmptyResults({ appId, range, canWiden, onWiden, step, sources }: { appId: string; range: RangeKey; canWiden: boolean; onWiden: () => void; step: ReturnType<typeof nextStep>; sources: SourcesState }) {
  const { workspaceId } = useWorkspace();
  const r = routes.app(workspaceId, appId);
  const action =
    step === "post_video" ? (
      <Button asChild size="lg">
        <Link href={r.home}>Post your first video</Link>
      </Button>
    ) : step === "connect_youtube" ? (
      <Button size="lg" onClick={() => void sources.connectYouTube()} loading={sources.connecting} disabled={!sources.canManage}>
        Connect YouTube
      </Button>
    ) : (
      <Button asChild size="lg">
        <Link href={r.insightsDetails("sources", { focus: "csv" })}>Add your numbers</Link>
      </Button>
    );
  return (
    <Calm
      icon={
        <span className="flex items-center gap-2 text-ink-2 [&_svg]:size-5">
          <Eye aria-hidden />
          <MousePointerClick aria-hidden />
          <Layers aria-hidden />
        </span>
      }
      title={range === "28" ? "Your results will show up here" : `Nothing measured in the last ${range} days`}
      body={
        step === "post_video"
          ? "Once your first video is out, you’ll see its views, link clicks and the post that did best, plus a tip from what worked. Only real numbers, never estimates."
          : "Your views, link clicks and best post show up here as soon as one of your accounts or files reports them. Only real numbers, never estimates."
      }
      action={
        <>
          {action}
          {canWiden ? (
            <Button size="lg" variant="ghost" onClick={onWiden}>
              Show 90 days
            </Button>
          ) : null}
        </>
      }
      note={step === "connect_youtube" && !sources.canManage ? "Ask a workspace owner to connect YouTube." : undefined}
    />
  );
}

function Calm({ icon, title, body, action, note }: { icon?: ReactNode; title: string; body: string; action?: ReactNode; note?: string }) {
  return (
    <div className="rounded-2xl bg-mist/70 px-6 py-10 text-center sm:py-12">
      {icon ? <div className="mx-auto flex h-12 w-fit items-center justify-center rounded-full bg-surface px-4 shadow-raised">{icon}</div> : null}
      <p className={cn("text-title-3 font-semibold text-ink text-balance", icon && "mt-4")}>{title}</p>
      <p className="mx-auto mt-2 max-w-md text-body-sm text-ink-2 text-pretty">{body}</p>
      {action ? <div className="mt-6 flex flex-wrap items-center justify-center gap-2">{action}</div> : null}
      {note ? <p className="mt-3 text-footnote text-ink-2">{note}</p> : null}
    </div>
  );
}
