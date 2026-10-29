"use client";
/**
 * Owner: module F. Insights → YouTube: public channel analysis (YouTube Data API numbers + a labelled
 * AI reading) and per-post stats for videos published to a connected YouTube channel.
 */
import {
  modelDisplayName,
  type ConnectedAccount,
  type Job,
  type MetricObservation,
  type Publication,
  type YouTubeChannelAnalysis,
  type YouTubeChannelRelation,
  type YouTubeGroupStat,
  type YouTubeVideoStat,
} from "@muselaunch/contracts";
import { Badge, Button, Card, CostEstimate, EmptyState, Field, Input, JobProgress, Notice, Section, Select, Stat, StatusPill, statusKindOf, useToast } from "@muselaunch/ui";
import { ExternalLink, RefreshCw, Search, Sparkles, SquarePlay } from "lucide-react";
import { type ReactNode, useState } from "react";
import { QueryState } from "@/components/states";
import { api, errorMessage, newIdempotencyKey, wsPath } from "@/lib/api";
import type { Page } from "@/lib/api-types";
import { useJob } from "@/lib/jobs";
import { useApiQuery } from "@/lib/query";
import { useWorkspace } from "@/lib/workspace";
import { fetchEstimate } from "./experiments";
import { fmtDate, Hint } from "./shared";

type AnalysisSummary = Pick<YouTubeChannelAnalysis, "id" | "appId" | "input" | "relation" | "connectedChannel" | "channel" | "fetchedAt" | "updatedAt"> & {
  videosAnalyzed: number;
  medianViews: number | null;
  interpretation: Pick<YouTubeChannelAnalysis["interpretation"], "status" | "model">;
};
type AnalysesResponse = Page<AnalysisSummary> & { configured: boolean };

const RELATIONS: { value: YouTubeChannelRelation; label: string }[] = [
  { value: "competitor", label: "A competitor" },
  { value: "mine", label: "Mine" },
  { value: "creator", label: "A creator" },
  { value: "inspiration", label: "Inspiration" },
];
const RELATION_LABEL: Record<YouTubeChannelRelation, string> = { competitor: "Competitor", mine: "Your channel", creator: "Creator", inspiration: "Inspiration" };

const num = (v: number | null | undefined, digits = 0) => (v === null || v === undefined ? "—" : new Intl.NumberFormat(undefined, { maximumFractionDigits: digits }).format(v));
const pct = (v: number | null | undefined) => (v === null || v === undefined ? "—" : `${(v * 100).toFixed(1)}%`);
const dur = (s: number | null) => (s === null ? "—" : s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`);

function ExtLink({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={className ?? "text-accent hover:underline"}>
      {children}
    </a>
  );
}

export function YouTubeView({ workspaceId, appId }: { workspaceId: string; appId: string }) {
  return (
    <div className="space-y-12">
      <ChannelAnalysis workspaceId={workspaceId} appId={appId} />
      <PostStats workspaceId={workspaceId} appId={appId} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Public channel analysis
// ---------------------------------------------------------------------------

function ChannelAnalysis({ workspaceId, appId }: { workspaceId: string; appId: string }) {
  const toast = useToast();
  const { can } = useWorkspace();
  const list = useApiQuery<AnalysesResponse>(wsPath(workspaceId, `/apps/${appId}/youtube/analyses`));
  const [channel, setChannel] = useState("");
  const [relation, setRelation] = useState<YouTubeChannelRelation>("competitor");
  const [busy, setBusy] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const job = useJob(workspaceId, jobId, {
    onSettled: (j) => {
      void list.refetch();
      const id = j.output?.data?.analysisId;
      if (j.status === "succeeded" && typeof id === "string") {
        setSelected(id);
        setChannel("");
      }
    },
  });
  const items = list.data?.items ?? [];
  const current = selected ?? items[0]?.id ?? null;
  const running = Boolean(job.job && (job.job.status === "queued" || job.job.status === "running"));

  const analyze = async (input: string, rel: YouTubeChannelRelation) => {
    setBusy(true);
    try {
      const res = await api.post<{ job: Job }>(wsPath(workspaceId, `/apps/${appId}/youtube/analyze`), { channel: input.trim(), relation: rel }, { idempotencyKey: newIdempotencyKey("yt") });
      setJobId(res.job.id);
    } catch (err) {
      toast.error("Couldn’t start the analysis", errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="Analyze a YouTube channel" description="Yours, a competitor’s or a creator’s. The numbers come straight from YouTube’s public data; the AI reading is labelled as interpretation.">
      {list.data && !list.data.configured ? (
        <Notice tone="warning" title="Not connected">
          YouTube analysis isn’t set up on this deployment yet (YOUTUBE_API_KEY).
        </Notice>
      ) : can("analytics.write") ? (
        <Card className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-[1fr_12rem]">
            <Field label="Channel" hint="A channel link, @handle, channel ID (UC…) or a link to one of its videos.">
              {(ids) => (
                <Input
                  id={ids.id}
                  aria-describedby={ids.describedBy}
                  value={channel}
                  onChange={(e) => setChannel(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && channel.trim().length > 1 && !running && void analyze(channel, relation)}
                  placeholder="https://www.youtube.com/@channel"
                />
              )}
            </Field>
            <Field label="Whose channel?">{(ids) => <Select id={ids.id} options={RELATIONS} value={relation} onChange={(e) => setRelation(e.target.value as YouTubeChannelRelation)} />}</Field>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button icon={<Search aria-hidden />} onClick={() => void analyze(channel, relation)} loading={busy || running} disabled={channel.trim().length < 2}>
              Analyze
            </Button>
            <CostEstimate operation="analytics.youtube_channel" fetchEstimate={fetchEstimate(workspaceId)} note="Only charged when the AI reading runs. YouTube data is free." />
          </div>
          {jobId ? <JobProgress job={job.job} title="Analysing YouTube channel" onRetry={() => void job.retry()} retrying={job.retrying} /> : null}
        </Card>
      ) : null}
      <QueryState query={list} feature="YouTube analysis">
        {(data) =>
          data.items.length ? (
            <div className="space-y-6">
              {data.items.length > 1 ? (
                <div className="flex flex-wrap gap-2" role="tablist" aria-label="Analysed channels">
                  {data.items.map((a) => (
                    <button
                      key={a.id}
                      type="button"
                      role="tab"
                      aria-selected={a.id === current}
                      onClick={() => setSelected(a.id)}
                      className={`rounded-full px-3 py-1.5 text-footnote font-medium transition-colors ${a.id === current ? "bg-ink text-surface" : "bg-mist text-ink-2 hover:text-ink"}`}
                    >
                      {a.channel.title}
                    </button>
                  ))}
                </div>
              ) : null}
              {current ? <AnalysisDetail workspaceId={workspaceId} id={current} canRun={can("analytics.write") && data.configured && !running} onReanalyze={(a) => void analyze(a.channel.id, a.relation)} /> : null}
            </div>
          ) : (
            <Card tone="well">
              <EmptyState icon={<SquarePlay aria-hidden />} title="No channels analysed yet" description="Paste a channel above to see what its recent uploads did, and what that may mean for your app." />
            </Card>
          )
        }
      </QueryState>
    </Section>
  );
}

function AnalysisDetail({ workspaceId, id, canRun, onReanalyze }: { workspaceId: string; id: string; canRun: boolean; onReanalyze: (a: YouTubeChannelAnalysis) => void }) {
  const q = useApiQuery<{ analysis: YouTubeChannelAnalysis }>(wsPath(workspaceId, `/youtube-analyses/${id}`));
  return <QueryState query={q} feature="YouTube analysis">{({ analysis }) => <AnalysisBody a={analysis} canRun={canRun} onReanalyze={() => onReanalyze(analysis)} />}</QueryState>;
}

function AnalysisBody({ a, canRun, onReanalyze }: { a: YouTubeChannelAnalysis; canRun: boolean; onReanalyze: () => void }) {
  const s = a.stats;
  const byId = new Map(a.videos.map((v) => [v.videoId, v]));
  const top = s.topByViews.map((vid) => byId.get(vid)).filter((v): v is YouTubeVideoStat => Boolean(v));
  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <p className="flex flex-wrap items-center gap-2 text-headline font-semibold">
            <ExtLink href={a.channel.url} className="hover:underline">
              {a.channel.title}
            </ExtLink>
            {a.channel.handle ? <span className="text-body-sm font-normal text-ink-2">{a.channel.handle}</span> : null}
            <Badge tone={a.relation === "mine" ? "accent" : "neutral"}>{RELATION_LABEL[a.relation]}</Badge>
          </p>
          <p className="text-footnote text-ink-2">
            YouTube Data API · fetched {fmtDate(a.fetchedAt, true)} UTC · {s.videosAnalyzed} recent uploads · {a.quota.units} quota units
          </p>
        </div>
        {canRun ? (
          <Button size="sm" variant="outline" icon={<RefreshCw aria-hidden />} onClick={onReanalyze}>
            Analyze again
          </Button>
        ) : null}
      </div>

      <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Subscribers" value={a.channel.subscriberCount === null ? "Hidden" : num(a.channel.subscriberCount)} detail="YouTube rounds public counts" />
        <Stat label="Median views" value={num(s.medians.views)} />
        <Stat label="Median likes" value={num(s.medians.likes)} />
        <Stat label="Median comments" value={num(s.medians.comments)} />
        <Stat label="Median engagement" value={pct(s.medians.engagementRate)} detail="(likes + comments) ÷ views" />
        <Stat label="Uploads a week" value={num(s.cadence.uploadsPerWeek, 1)} />
      </div>

      {s.videosAnalyzed ? (
        <>
          <Card padding="none" className="overflow-x-auto">
            <p className="px-5 pt-4 text-body-sm font-medium">Most viewed</p>
            <VideoTable videos={top} />
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <GroupTable title="By length" hint="YouTube’s API doesn’t say which uploads are Shorts, so this groups by length only." groups={s.byLength} />
            <PatternTable a={a} />
            <GroupTable title="By day posted (UTC)" groups={s.byWeekday} />
            <GroupTable title="By time posted (UTC)" groups={s.byHour} />
          </div>

          {a.keyFindings.length ? (
            <Card className="space-y-3">
              <p className="flex items-center gap-2 text-body-sm font-medium">
                What the numbers show <Badge>Measured</Badge>
              </p>
              <ul className="list-disc space-y-1.5 pl-5 text-body-sm text-ink-2">
                {a.keyFindings.map((f) => (
                  <li key={f.key}>{f.statement}</li>
                ))}
              </ul>
              <p className="text-footnote text-ink-3">Saved as sourced findings: they show up in Discover and Growth Autopilot can use them.</p>
            </Card>
          ) : null}
        </>
      ) : null}

      <Interpretation a={a} />

      <Notice tone="neutral" title="How to read these numbers">
        <ul className="list-disc space-y-1 pl-4">
          {s.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
          {s.excluded.length ? <li>{s.excluded.length} upload(s) left out: {[...new Set(s.excluded.map((e) => e.reason))].join("; ")}.</li> : null}
        </ul>
      </Notice>

      {a.videos.length ? (
        <details className="text-body-sm">
          <summary className="cursor-pointer text-footnote text-ink-2">All analysed videos ({a.videos.length})</summary>
          <Card padding="none" className="mt-3 overflow-x-auto">
            <VideoTable videos={a.videos} />
          </Card>
        </details>
      ) : null}
    </div>
  );
}

function VideoTable({ videos }: { videos: YouTubeVideoStat[] }) {
  return (
    <table className="w-full min-w-[40rem] text-left text-footnote">
      <thead className="text-ink-3">
        <tr>
          <th className="px-5 py-2 font-medium">Video</th>
          <th className="py-2 font-medium">Posted</th>
          <th className="py-2 font-medium">Length</th>
          <th className="py-2 text-right font-medium">Views</th>
          <th className="py-2 text-right font-medium">Likes</th>
          <th className="py-2 text-right font-medium">Comments</th>
          <th className="px-5 py-2 text-right font-medium" title="Views ÷ the median views of these uploads">
            × median
          </th>
        </tr>
      </thead>
      <tbody className="divide-y divide-line">
        {videos.map((v) => (
          <tr key={v.videoId}>
            <td className="max-w-[18rem] truncate px-5 py-2">
              <ExtLink href={v.url}>{v.title || v.videoId}</ExtLink>
            </td>
            <td className="py-2 tabular text-ink-2">{fmtDate(v.publishedAt)}</td>
            <td className="py-2 tabular text-ink-2">{v.lengthGroup === "live" ? "Live" : dur(v.durationSec)}</td>
            <td className="py-2 text-right tabular">{num(v.views)}</td>
            <td className="py-2 text-right tabular" title={v.likes === null ? "Hidden by the creator" : undefined}>
              {v.likes === null ? "Hidden" : num(v.likes)}
            </td>
            <td className="py-2 text-right tabular" title={v.comments === null ? "Comments are off" : undefined}>
              {v.comments === null ? "Off" : num(v.comments)}
            </td>
            <td className="px-5 py-2 text-right tabular">{v.vsMedian === null ? "—" : `${v.vsMedian.toFixed(1)}×`}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function GroupTable({ title, hint, groups }: { title: string; hint?: string; groups: YouTubeGroupStat[] }) {
  return (
    <Card className="space-y-3">
      <p className="flex items-center gap-1 text-body-sm font-medium">
        {title}
        {hint ? <Hint label="About this table">{hint}</Hint> : null}
      </p>
      <table className="w-full text-left text-footnote">
        <thead className="text-ink-3">
          <tr>
            <th className="py-1 font-medium" />
            <th className="py-1 text-right font-medium">Videos</th>
            <th className="py-1 text-right font-medium">Median views</th>
            <th className="py-1 text-right font-medium">Views a day</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {groups.map((g) => (
            <tr key={g.key} className={g.videos < 3 ? "text-ink-3" : undefined} title={g.videos < 3 ? "Fewer than 3 videos: too few to compare" : undefined}>
              <td className="py-1.5">{g.label}</td>
              <td className="py-1.5 text-right tabular">{g.videos}</td>
              <td className="py-1.5 text-right tabular">{num(g.medianViews)}</td>
              <td className="py-1.5 text-right tabular">{num(g.medianViewsPerDay, 1)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function PatternTable({ a }: { a: YouTubeChannelAnalysis }) {
  return (
    <Card className="space-y-3">
      <p className="text-body-sm font-medium">Title patterns</p>
      <table className="w-full text-left text-footnote">
        <thead className="text-ink-3">
          <tr>
            <th className="py-1 font-medium">Title</th>
            <th className="py-1 text-right font-medium">With: videos · median</th>
            <th className="py-1 text-right font-medium">Without</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {a.stats.titlePatterns.map((p) => (
            <tr key={p.key} className={p.with.videos < 3 || p.without.videos < 3 ? "text-ink-3" : undefined}>
              <td className="py-1.5">{p.label}</td>
              <td className="py-1.5 text-right tabular">
                {p.with.videos} · {num(p.with.medianViews)}
              </td>
              <td className="py-1.5 text-right tabular">
                {p.without.videos} · {num(p.without.medianViews)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function Interpretation({ a }: { a: YouTubeChannelAnalysis }) {
  const i = a.interpretation;
  const byId = new Map(a.videos.map((v) => [v.videoId, v]));
  if (i.status !== "ready") {
    return (
      <Notice tone="neutral" icon={<Sparkles aria-hidden />} title="No AI reading">
        {i.error ?? "Not available."}
      </Notice>
    );
  }
  const notes = new Map(i.findingNotes.map((n) => [n.key, n.interpretation]));
  return (
    <Card className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-body-sm font-medium">What it may mean for your app</p>
        <Badge tone="accent" icon={<Sparkles aria-hidden />} title="Written by an AI model from the numbers above. Not measured; correlation is not cause.">
          Interpretation · {modelDisplayName(i.model, { short: true }) || "AI"}
        </Badge>
      </div>
      {i.summary ? <p className="text-body-sm text-ink">{i.summary}</p> : null}
      {a.keyFindings.some((f) => notes.has(f.key)) ? (
        <ul className="list-disc space-y-1 pl-5 text-body-sm text-ink-2">
          {a.keyFindings
            .filter((f) => notes.has(f.key))
            .map((f) => (
              <li key={f.key}>{notes.get(f.key)}</li>
            ))}
        </ul>
      ) : null}
      {i.hooksToTest.length ? (
        <div className="space-y-2">
          <p className="text-footnote font-medium text-ink-2">Hooks to test</p>
          <ul className="space-y-2">
            {i.hooksToTest.map((h) => (
              <li key={h.hook} className="rounded-lg bg-mist px-4 py-3 text-body-sm">
                <p className="font-medium">“{h.hook}”</p>
                <p className="text-ink-2">{h.angle}</p>
                {h.videoIds.length ? (
                  <p className="mt-1 text-footnote text-ink-3">
                    Inspired by{" "}
                    {h.videoIds.map((vid, n) => (
                      <span key={vid}>
                        {n ? ", " : ""}
                        <ExtLink href={byId.get(vid)?.url ?? `https://www.youtube.com/watch?v=${vid}`}>
                          {byId.get(vid)?.title || vid} <ExternalLink className="inline size-3" aria-hidden />
                        </ExtLink>
                      </span>
                    ))}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {i.formatsToTest.length ? (
        <div className="space-y-2">
          <p className="text-footnote font-medium text-ink-2">Formats to test</p>
          <ul className="list-disc space-y-1 pl-5 text-body-sm">
            {i.formatsToTest.map((f) => (
              <li key={f.format}>
                <span className="font-medium">{f.format}</span> <span className="text-ink-2">— {f.why}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {i.cautions.length ? (
        <div className="space-y-1">
          <p className="text-footnote font-medium text-ink-2">Caveats</p>
          <ul className="list-disc space-y-1 pl-5 text-footnote text-ink-2">
            {i.cautions.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {i.validation.notes.length ? <p className="text-footnote text-ink-3">{i.validation.notes.join(" ")}</p> : null}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Stats of videos published to a connected YouTube channel
// ---------------------------------------------------------------------------

const POST_METRICS: { metric: MetricObservation["metric"]; label: string; fmt: (v: number) => string }[] = [
  { metric: "views", label: "Views", fmt: (v) => num(v) },
  { metric: "likes", label: "Likes", fmt: (v) => num(v) },
  { metric: "comments", label: "Comments", fmt: (v) => num(v) },
  { metric: "watch_time_sec", label: "Watch time", fmt: (v) => (v >= 3600 ? `${(v / 3600).toFixed(1)} h` : `${Math.round(v / 60)} min`) },
  { metric: "avg_view_duration_sec", label: "Avg. view", fmt: (v) => dur(Math.round(v)) },
  { metric: "shares", label: "Shares", fmt: (v) => num(v) },
  { metric: "followers_gained", label: "Subscribers", fmt: (v) => num(v) },
];

function PostStats({ workspaceId, appId }: { workspaceId: string; appId: string }) {
  const toast = useToast();
  const { can } = useWorkspace();
  const conns = useApiQuery<Page<ConnectedAccount>>(wsPath(workspaceId, `/apps/${appId}/analytics/connections`));
  const obs = useApiQuery<Page<MetricObservation>>(wsPath(workspaceId, `/apps/${appId}/observations`), { query: { source: "youtube", limit: 200 } });
  const pubs = useApiQuery<Page<Publication>>(wsPath(workspaceId, `/apps/${appId}/publications`), { retry: false });
  const [jobId, setJobId] = useState<string | null>(null);
  const job = useJob(workspaceId, jobId, {
    onSettled: (j) => {
      void conns.refetch();
      void obs.refetch();
      if (j.status === "succeeded") toast.success("YouTube stats synced", "Each number shows YouTube’s own definition.");
    },
  });
  const accounts = (conns.data?.items ?? []).filter((c) => c.provider === "youtube");
  const sync = async (id: string) => {
    try {
      const res = await api.post<{ job: Job }>(wsPath(workspaceId, `/analytics/connections/${id}/sync`), { appId }, { idempotent: true });
      setJobId(res.job.id);
    } catch (err) {
      toast.error("Sync didn’t start", errorMessage(err));
    }
  };
  const rows = groupByPost(obs.data?.items ?? []);
  const pubById = new Map((pubs.data?.items ?? []).map((p) => [p.id, p]));
  return (
    <Section title="Your YouTube posts" description="Stats for videos you published from MuseLaunch to a connected channel, as YouTube reports them for each video.">
      {!accounts.length ? (
        <Card tone="well" className="text-body-sm text-ink-2">
          Connect YouTube in the calendar to publish. MuseLaunch then reads each video’s views, likes and comments, plus watch time, shares and subscribers when you allow YouTube Analytics access.
        </Card>
      ) : (
        accounts.map((c) => (
          <Card key={c.id} className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0 space-y-1">
              <p className="flex items-center gap-2 text-body-sm font-medium">
                {c.displayName} <StatusPill status={statusKindOf(c.status === "connected" ? "succeeded" : c.status === "revoked" ? "cancelled" : "failed")}>{c.status}</StatusPill>
              </p>
              <p className="text-footnote text-ink-2">Last sync: {c.lastSyncAt ? `${fmtDate(c.lastSyncAt, true)} UTC` : "not yet"}</p>
              {c.lastError ? <p className="text-footnote text-ink-3">{c.lastError}</p> : null}
              {c.limitations.length ? <p className="text-footnote text-ink-3">{c.limitations.join(" ")}</p> : null}
            </div>
            <Button size="sm" variant="outline" icon={<RefreshCw aria-hidden />} onClick={() => void sync(c.id)} disabled={c.status !== "connected" || !can("analytics.write")}>
              Sync stats
            </Button>
          </Card>
        ))
      )}
      {jobId ? <JobProgress job={job.job} title="Syncing YouTube stats" onRetry={() => void job.retry()} retrying={job.retrying} /> : null}
      {rows.length ? (
        <Card padding="none" className="overflow-x-auto">
          <table className="w-full min-w-[44rem] text-left text-footnote">
            <thead className="text-ink-3">
              <tr>
                <th className="px-5 py-2 font-medium">Video</th>
                {POST_METRICS.map((m) => (
                  <th key={m.metric} className="py-2 text-right font-medium">
                    {m.label}
                  </th>
                ))}
                <th className="px-5 py-2 text-right font-medium">Fetched</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((r) => {
                const pub = pubById.get(r.publicationId);
                return (
                  <tr key={r.publicationId}>
                    <td className="px-5 py-2">{pub?.remoteUrl ? <ExtLink href={pub.remoteUrl}>{pub.remoteId ?? "Video"}</ExtLink> : (pub?.remoteId ?? r.publicationId)}</td>
                    {POST_METRICS.map((m) => {
                      const o = r.byMetric.get(m.metric);
                      return (
                        <td key={m.metric} className="py-2 text-right tabular" title={o?.metricDefinition}>
                          {o ? m.fmt(o.value) : "—"}
                        </td>
                      );
                    })}
                    <td className="px-5 py-2 text-right tabular text-ink-2">{fmtDate(r.fetchedAt, true)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="px-5 pb-4 pt-2 text-footnote text-ink-3">Totals since each video was published, as of the fetch time. Hover a number for YouTube’s definition.</p>
        </Card>
      ) : null}
    </Section>
  );
}

function groupByPost(items: MetricObservation[]) {
  const map = new Map<string, { publicationId: string; byMetric: Map<string, MetricObservation>; fetchedAt: string }>();
  for (const o of items) {
    if (!o.publicationId) continue;
    const row = map.get(o.publicationId) ?? { publicationId: o.publicationId, byMetric: new Map(), fetchedAt: o.provenance.fetchedAt };
    row.byMetric.set(o.metric, o);
    if (o.provenance.fetchedAt > row.fetchedAt) row.fetchedAt = o.provenance.fetchedAt;
    map.set(o.publicationId, row);
  }
  return [...map.values()].sort((a, b) => b.fetchedAt.localeCompare(a.fetchedAt));
}
