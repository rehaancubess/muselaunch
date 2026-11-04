"use client";
/**
 * Insights → "How it's going": the one job of the main Insights page. Up to three measured numbers
 * (each with where it comes from), "What's working" (only from a test with enough data, the measured
 * sentence first and any reason labelled as a guess), "Try next" (the top recommendation and its one
 * action) and "Connect your data" (sources not connected yet, one line and one button each). A 7 / 28
 * / 90 day switch (28 by default). Filters, the funnel, cost vs outcome, tests, YouTube and data
 * sources stay on Details (./index.tsx, /insights/details).
 *
 * Honesty: numbers come straight from GET /insights/overview (never estimated; a measured 0 is shown,
 * "not measured" is said plainly), changes are never explained as causes.
 */
import type { ConnectedAccount, Experiment, ExperimentResult, GrowthRecommendation, ImportBatch, InsightMetric, InsightsOverview, Job } from "@muselaunch/contracts";
import { Button, JobProgress, SegmentedControl, Skeleton, cn, useToast } from "@muselaunch/ui";
import { ArrowDownRight, ArrowRight, ArrowUpRight, BarChart3, FileUp, Lightbulb, Minus, SquarePlay, Wallet } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, type ReactNode } from "react";
import type { ConnectionsResponse } from "@/features/publishing/types";
import { api, errorMessage, newIdempotencyKey, wsPath } from "@/lib/api";
import type { Page } from "@/lib/api-types";
import { useJob } from "@/lib/jobs";
import { useApiQuery, useInvalidate } from "@/lib/query";
import { routes } from "@/lib/routes";
import { useWorkspace } from "@/lib/workspace";
import { fmtNumber } from "./shared";
import { bigNumbers, changeLine, coverageNote, firstParagraph, nextStep, plainMetricLabel, plainSource, scopeLine, workingLine, type NextStep } from "./simple-lines";

type RangeKey = "7" | "28" | "90";
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const DAY = 86_400_000;

type YouTubeState = "connected" | "can_connect" | "unavailable";

export default function SimpleInsights({ appId }: { appId: string }) {
  const { workspaceId } = useWorkspace();
  const [range, setRange] = useState<RangeKey>("28");
  const query = useMemo(() => {
    const today = Date.now();
    return { from: isoDay(today - (Number(range) - 1) * DAY), to: isoDay(today), compare: "prev" };
  }, [range]);
  const overview = useApiQuery<InsightsOverview>(wsPath(workspaceId, `/apps/${appId}/insights/overview`), { query, placeholderData: (prev) => prev });
  const sources = useSources(appId);
  const r = routes.app(workspaceId, appId);

  const data = overview.data;
  const shown = data ? bigNumbers(data.metrics) : [];
  const step = data ? nextStep(data.missing, sources.youtube) : null;
  const showRange = Boolean(data && (shown.length || range !== "28" || data.missing.some((m) => m.action === "widen_range")));

  return (
    <div className="space-y-12">
      <section aria-label="Your numbers" className="space-y-4">
        {showRange ? (
          <SegmentedControl<RangeKey>
            label="Time range"
            size="lg"
            className="[&_button]:min-h-11"
            value={range}
            onChange={setRange}
            items={[
              { value: "7", label: "7 days" },
              { value: "28", label: "28 days" },
              { value: "90", label: "90 days" },
            ]}
          />
        ) : null}
        {overview.isLoading ? (
          <div className="grid gap-3 sm:grid-cols-3">
            {Array.from({ length: 3 }, (_, i) => (
              <Skeleton key={i} className="h-40" rounded="xl" />
            ))}
          </div>
        ) : overview.error && !data ? (
          <Calm title="Couldn’t load your numbers" body={errorMessage(overview.error)} action={<Button size="lg" variant="outline" onClick={() => void overview.refetch()} loading={overview.isFetching}>Try again</Button>} />
        ) : data && shown.length ? (
          <>
            <div className={cn("grid gap-3", shown.length === 1 ? "sm:grid-cols-1" : shown.length === 2 ? "sm:grid-cols-2" : "sm:grid-cols-3", overview.isFetching && "opacity-70 transition-opacity")}>
              {shown.map((m) => (
                <BigNumber key={m.metric} m={m} days={Number(range)} />
              ))}
            </div>
            {coverageNote(shown) ? <p className="text-footnote text-ink-2">{coverageNote(shown)}</p> : null}
          </>
        ) : data && step ? (
          <NothingMeasured step={step} range={range} onWiden={() => setRange("90")} canWiden={range === "7" || (range === "28" && data.missing.some((m) => m.action === "widen_range"))} appId={appId} youtube={sources} />
        ) : null}
      </section>

      {data && shown.length ? <WhatsWorking appId={appId} /> : null}
      <TryNext appId={appId} measured={shown.length > 0} />
      <ConnectYourData appId={appId} sources={sources} installsMeasured={Boolean(data?.metrics.some((m) => m.metric === "installs" && m.value !== null))} skipYouTube={!shown.length && step === "connect_youtube"} />

      <div className="flex flex-col gap-3 border-t border-line pt-8 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-body-sm text-ink-2">Filters, your tests, YouTube and every number with its source.</p>
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
// The numbers
// ---------------------------------------------------------------------------

function BigNumber({ m, days }: { m: InsightMetric; days: number }) {
  const change = changeLine(m, days);
  const scope = scopeLine(m);
  const source = plainSource(m);
  const delta = m.comparison?.deltaPct ?? null;
  return (
    <div className="flex flex-col gap-1 rounded-2xl bg-surface px-5 py-4 shadow-raised sm:py-5">
      <p className="text-body-sm font-medium text-ink-2">{plainMetricLabel(m)}</p>
      <p className="text-[36px] font-semibold leading-[42px] tracking-[-0.03em] text-ink tabular sm:text-[40px] sm:leading-[46px]">
        {m.value !== null ? (
          fmtNumber(m.value, m.unit, m.currency)
        ) : (
          <span className="flex flex-col text-title-2">
            {(m.byCurrency ?? []).map((c) => (
              <span key={c.currency}>{fmtNumber(c.value, "currency", c.currency)}</span>
            ))}
          </span>
        )}
      </p>
      <div className="mt-1 space-y-1 text-footnote text-ink-2">
        {source ? <p>{source}</p> : null}
        {change ? (
          <p className="flex items-center gap-1">
            {delta !== null && delta > 0 ? <ArrowUpRight className="size-3.5 shrink-0" aria-hidden /> : delta !== null && delta < 0 ? <ArrowDownRight className="size-3.5 shrink-0" aria-hidden /> : <Minus className="size-3.5 shrink-0" aria-hidden />}
            {change}
          </p>
        ) : null}
        {scope ? <p>{scope}</p> : null}
      </div>
    </div>
  );
}

function NothingMeasured({ step, range, canWiden, onWiden, appId, youtube }: { step: NextStep; range: RangeKey; canWiden: boolean; onWiden: () => void; appId: string; youtube: SourcesState }) {
  const { workspaceId } = useWorkspace();
  const r = routes.app(workspaceId, appId);
  const action =
    step === "post_video" ? (
      <Button asChild size="lg">
        <Link href={r.home}>Post your first video</Link>
      </Button>
    ) : step === "connect_youtube" ? (
      <Button size="lg" icon={<SquarePlay className="size-4" aria-hidden />} onClick={() => void youtube.connectYouTube()} loading={youtube.connecting} disabled={!youtube.canManage}>
        Connect YouTube
      </Button>
    ) : (
      <Button asChild size="lg">
        <Link href={r.insightsDetails("sources", { focus: "csv" })}>Add your numbers</Link>
      </Button>
    );
  return (
    <Calm
      icon={<BarChart3 className="size-5" aria-hidden />}
      title={range === "28" ? "Nothing measured yet" : `Nothing measured in the last ${range} days`}
      body={
        step === "post_video"
          ? "Once your first video is out, its real numbers show up here: views, link clicks and installs. Muse never guesses a number."
          : "Your views, link clicks and installs show up here as soon as one of your accounts or files reports them. Muse never guesses a number."
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
      note={step === "connect_youtube" && !youtube.canManage ? "Ask a workspace owner to connect YouTube." : undefined}
    />
  );
}

function Calm({ icon, title, body, action, note }: { icon?: ReactNode; title: string; body: string; action?: ReactNode; note?: string }) {
  return (
    <div className="rounded-2xl bg-mist/70 px-6 py-10 text-center">
      {icon ? <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-surface text-ink-2 shadow-raised">{icon}</div> : null}
      <p className={cn("text-headline font-semibold text-ink", icon && "mt-4")}>{title}</p>
      <p className="mx-auto mt-1.5 max-w-md text-body-sm text-ink-2 text-pretty">{body}</p>
      {action ? <div className="mt-5 flex flex-wrap items-center justify-center gap-2">{action}</div> : null}
      {note ? <p className="mt-3 text-footnote text-ink-2">{note}</p> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// What's working: the latest test with enough data, never a cause
// ---------------------------------------------------------------------------

function WhatsWorking({ appId }: { appId: string }) {
  const { workspaceId } = useWorkspace();
  const list = useApiQuery<Page<Experiment>>(wsPath(workspaceId, `/apps/${appId}/experiments`));
  const latest = [...(list.data?.items ?? [])].filter((e) => e.lastResultId && e.status !== "abandoned").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  const detail = useApiQuery<{ experiment: Experiment; results: ExperimentResult[] }>(latest ? wsPath(workspaceId, `/experiments/${latest.id}`) : null);
  const line = workingLine(detail.data?.experiment, detail.data?.results[0]);
  if (!line) return null; // not enough data yet: say nothing rather than guess
  return (
    <section aria-labelledby="working-heading" className="space-y-3">
      <h2 id="working-heading" className="text-headline font-semibold">
        What’s working
      </h2>
      <div className="space-y-2 rounded-2xl bg-surface p-5 shadow-raised">
        <p className="text-body text-ink text-pretty">{line.text}</p>
        {line.maybe ? <p className="text-body-sm text-ink-2 text-pretty">{line.maybe}</p> : null}
        <p className="text-footnote text-ink-2">
          {line.basis}, from your test “{line.testTitle}”.
        </p>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Try next: the top recommendation and its one action
// ---------------------------------------------------------------------------

function TryNext({ appId, measured }: { appId: string; measured: boolean }) {
  const { workspaceId, workspace, can } = useWorkspace();
  const toast = useToast();
  const router = useRouter();
  const invalidate = useInvalidate();
  const auto = workspace?.settings.autopilot?.enabled ?? true;
  const recs = useApiQuery<Page<GrowthRecommendation>>(wsPath(workspaceId, `/apps/${appId}/recommendations`), { refetchInterval: auto ? 20_000 : false });
  const [busy, setBusy] = useState<"accept" | "dismiss" | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const job = useJob(workspaceId, jobId, { onSettled: () => void recs.refetch() });
  const generating = Boolean(jobId && job.job && (job.job.status === "queued" || job.job.status === "running"));
  const top = recs.data?.items.find((x) => x.status === "new");
  const canAct = can("analytics.write");

  const accept = async (rec: GrowthRecommendation) => {
    setBusy("accept");
    try {
      const res = await api.post<{ recommendation: GrowthRecommendation; experiment: Experiment | null }>(wsPath(workspaceId, `/recommendations/${rec.id}/accept`));
      await Promise.all([recs.refetch(), invalidate(wsPath(workspaceId, `/apps/${appId}`), wsPath(workspaceId, "/experiments"))]);
      if (res.experiment) {
        toast.success("Test set up", `${res.experiment.title}. Add each version’s numbers when they’re in.`);
        router.push(routes.app(workspaceId, appId).insightsDetails("experiments", { open: res.experiment.id }));
      } else toast.success("Saved", "Muse will keep this in mind for your next ideas.");
    } catch (err) {
      toast.error("That didn’t work", errorMessage(err));
    } finally {
      setBusy(null);
    }
  };
  const dismiss = async (rec: GrowthRecommendation) => {
    setBusy("dismiss");
    try {
      await api.post(wsPath(workspaceId, `/recommendations/${rec.id}/dismiss`), {});
      await recs.refetch();
    } catch (err) {
      toast.error("That didn’t work", errorMessage(err));
    } finally {
      setBusy(null);
    }
  };
  const generate = async () => {
    try {
      const res = await api.post<{ job: Job }>(wsPath(workspaceId, `/apps/${appId}/recommendations/generate`), {}, { idempotencyKey: newIdempotencyKey("rec") });
      setJobId(res.job.id);
    } catch (err) {
      toast.error("Muse couldn’t start", errorMessage(err));
    }
  };

  if (recs.isLoading) return null;
  if (!top && !(measured && canAct)) return null;
  const evidence = top ? top.basedOn.observationIds.length + top.basedOn.resultIds.length : 0;
  return (
    <section aria-labelledby="next-heading" className="space-y-3">
      <h2 id="next-heading" className="text-headline font-semibold">
        Try next
      </h2>
      {top ? (
        <article aria-label={top.title} className="space-y-3 rounded-2xl bg-surface p-5 shadow-raised">
          <div className="flex items-start gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent">
              <Lightbulb className="size-4" aria-hidden />
            </span>
            <div className="min-w-0 space-y-1.5">
              <h3 className="text-headline font-semibold text-ink text-balance">{top.title}</h3>
              <p className="line-clamp-3 text-body-sm text-ink-2 text-pretty">{firstParagraph(top.rationale)}</p>
              <p className="text-footnote text-ink-2">{evidence ? `Based on ${evidence} of your measured numbers and test results.` : "A starting idea: not based on your numbers yet."}</p>
            </div>
          </div>
          {canAct ? (
            <div className="flex flex-wrap items-center gap-2 sm:pl-12">
              <Button size="lg" onClick={() => void accept(top)} loading={busy === "accept"} disabled={busy !== null}>
                {top.proposedExperiment ? "Set up this test" : "Remember this"}
              </Button>
              <Button size="lg" variant="ghost" onClick={() => void dismiss(top)} loading={busy === "dismiss"} disabled={busy !== null}>
                Not now
              </Button>
            </div>
          ) : null}
        </article>
      ) : (
        <div className="space-y-3 rounded-2xl bg-mist/70 p-5">
          <p className="text-body-sm text-ink-2">No suggestion yet. Muse can read your numbers and suggest one thing to try.</p>
          {jobId ? <JobProgress job={job.job} title="Reading your numbers" variant="row" onRetry={() => void job.retry()} retrying={job.retrying} /> : null}
          <Button size="lg" variant="outline" icon={<Lightbulb className="size-4" aria-hidden />} onClick={() => void generate()} loading={generating}>
            Suggest something
          </Button>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Connect your data: what isn't connected yet, one line and one button each
// ---------------------------------------------------------------------------

/** Which data sources are connected (also used by Results). */
export type SourcesState = ReturnType<typeof useSources>;

export function useSources(appId: string) {
  const { workspaceId, can } = useWorkspace();
  const toast = useToast();
  const accounts = useApiQuery<Page<ConnectedAccount>>(wsPath(workspaceId, `/apps/${appId}/analytics/connections`));
  const catalog = useApiQuery<ConnectionsResponse>(wsPath(workspaceId, "/connections"), { retry: false });
  const imports = useApiQuery<Page<ImportBatch>>(wsPath(workspaceId, `/apps/${appId}/imports`), { retry: false });
  const [connecting, setConnecting] = useState(false);
  const items = accounts.data?.items ?? [];
  const yt = items.find((c) => c.provider === "youtube" && c.status !== "revoked");
  const rc = items.find((c) => c.provider === "revenuecat" && c.status !== "revoked");
  const ytProvider = catalog.data?.providers.find((p) => p.provider === "youtube");
  const youtube: YouTubeState = yt?.status === "connected" ? "connected" : ytProvider && ytProvider.configured && ytProvider.state !== "not_configured" ? "can_connect" : "unavailable";
  const storeFileImported = (imports.data?.items ?? []).some(
    (b) => b.status === "committed" && (b.detectedFormat === "app_store_sales" || b.detectedFormat === "play_installs" || b.options.source === "app_store_connect" || b.options.source === "google_play_console"),
  );

  const connectYouTube = async () => {
    setConnecting(true);
    try {
      const r = await api.post<{ authorizeUrl: string }>(wsPath(workspaceId, "/connections/youtube/start"), { appId });
      window.location.assign(r.authorizeUrl);
    } catch (e) {
      toast.error("Couldn’t start connecting YouTube", errorMessage(e));
      setConnecting(false);
    }
  };

  return {
    loading: accounts.isLoading || catalog.isLoading || imports.isLoading,
    youtube,
    youtubeAccount: yt ?? null,
    revenuecat: rc ?? null,
    storeFileImported,
    canManage: can("accounts.manage"),
    connecting,
    connectYouTube,
  };
}

export function ConnectYourData({ appId, sources, installsMeasured, skipYouTube }: { appId: string; sources: SourcesState; installsMeasured: boolean; skipYouTube: boolean }) {
  const { workspaceId } = useWorkspace();
  const r = routes.app(workspaceId, appId);
  if (sources.loading) return null;
  const rows: { key: string; icon: ReactNode; name: string; line: string; action: ReactNode }[] = [];

  if (!skipYouTube && sources.youtube !== "connected") {
    const broken = sources.youtubeAccount && sources.youtubeAccount.status !== "connected";
    rows.push(
      sources.youtube === "can_connect"
        ? {
            key: "youtube",
            icon: <SquarePlay aria-hidden />,
            name: "YouTube",
            line: broken ? "The connection stopped working. Connect it again to keep your views coming in." : sources.canManage ? "Views and likes for the videos you post there." : "Views and likes for your videos. A workspace owner can connect it.",
            action: (
              <Button size="lg" variant="outline" onClick={() => void sources.connectYouTube()} loading={sources.connecting} disabled={!sources.canManage}>
                {broken ? "Reconnect" : "Connect"}
              </Button>
            ),
          }
        : {
            key: "youtube",
            icon: <SquarePlay aria-hidden />,
            name: "YouTube",
            line: "Can’t be connected on this server yet. You can type in your video numbers instead.",
            action: (
              <Button asChild size="lg" variant="outline">
                <Link href={r.insightsDetails("sources", { focus: "manual" })}>Type them in</Link>
              </Button>
            ),
          },
    );
  }
  if (!sources.revenuecat || sources.revenuecat.status !== "connected") {
    const broken = Boolean(sources.revenuecat);
    rows.push({
      key: "revenuecat",
      icon: <Wallet aria-hidden />,
      name: "RevenueCat",
      line: broken ? "The connection needs a new key." : "Free trials, subscribers and revenue from your app.",
      action: (
        <Button asChild size="lg" variant="outline">
          <Link href={r.insightsDetails("sources", { focus: "revenuecat" })}>{broken ? "Fix" : "Connect"}</Link>
        </Button>
      ),
    });
  }
  if (!sources.storeFileImported && !installsMeasured) {
    rows.push({
      key: "store",
      icon: <FileUp aria-hidden />,
      name: "App Store or Google Play",
      line: "Installs, from a report file you download there.",
      action: (
        <Button asChild size="lg" variant="outline">
          <Link href={r.insightsDetails("sources", { focus: "csv" })}>Add a file</Link>
        </Button>
      ),
    });
  }
  if (!rows.length) return null;
  return (
    <section aria-labelledby="connect-heading" className="space-y-3">
      <h2 id="connect-heading" className="text-headline font-semibold">
        Connect your data
      </h2>
      <ul className="divide-y divide-line overflow-hidden rounded-2xl bg-surface shadow-raised">
        {rows.map((row) => (
          <li key={row.key} className="flex flex-wrap items-center gap-x-3 gap-y-3 px-5 py-4">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-mist text-ink-2 [&_svg]:size-4">{row.icon}</span>
            <div className="min-w-0 flex-1 basis-48">
              <p className="text-body-sm font-semibold text-ink">{row.name}</p>
              <p className="text-footnote text-ink-2 text-pretty">{row.line}</p>
            </div>
            <div className="ml-12 shrink-0 sm:ml-0">{row.action}</div>
          </li>
        ))}
      </ul>
    </section>
  );
}
