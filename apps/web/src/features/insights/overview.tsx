"use client";
import type { Campaign, Channel, CostOutcome, FunnelStep, InsightMetric, InsightsOverview, MissingMetric } from "@muselaunch/contracts";
import { Badge, Button, Card, Notice, Section, SegmentedControl, Select, Skeleton, Switch } from "@muselaunch/ui";
import { ArrowDownRight, ArrowRight, ArrowUpRight, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { QueryState } from "@/components/states";
import { wsPath } from "@/lib/api";
import type { Page } from "@/lib/api-types";
import { CHANNEL_LABEL } from "@/lib/labels";
import { useApiQuery } from "@/lib/query";
import { routes } from "@/lib/routes";
import { AttributionBadge, Hint, SourceBadge, fmtDate, fmtNumber } from "./shared";

export type SourcesFocus = "revenuecat" | "csv" | "manual" | "links";

type RangeKey = "7" | "28" | "90";
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

const ACTION_LABEL: Partial<Record<MissingMetric["action"], { label: string; focus?: SourcesFocus }>> = {
  connect_revenuecat: { label: "Connect RevenueCat", focus: "revenuecat" },
  import_csv: { label: "Import a CSV", focus: "csv" },
  enter_manually: { label: "Enter numbers", focus: "manual" },
  create_tracked_link: { label: "Add a tracked link", focus: "links" },
  sync_now: { label: "Open data sources", focus: "revenuecat" },
};

export function OverviewView({ workspaceId, appId, onOpenSources }: { workspaceId: string; appId: string; onOpenSources: (focus: SourcesFocus) => void }) {
  const [range, setRange] = useState<RangeKey>("28");
  const [compare, setCompare] = useState(true);
  const [channel, setChannel] = useState<Channel | "">("");
  const [campaignId, setCampaignId] = useState("");
  const q = useMemo(() => {
    const today = Date.now();
    return {
      from: isoDay(today - (Number(range) - 1) * 86_400_000),
      to: isoDay(today),
      compare: compare ? "prev" : "none",
      channel: channel || undefined,
      campaignId: campaignId || undefined,
    };
  }, [range, compare, channel, campaignId]);
  const overview = useApiQuery<InsightsOverview>(wsPath(workspaceId, `/apps/${appId}/insights/overview`), { query: q, placeholderData: (prev) => prev });
  const campaigns = useApiQuery<Page<Campaign>>(wsPath(workspaceId, `/apps/${appId}/campaigns`), { retry: false });

  return (
    <div className="space-y-10">
      <div className="flex flex-wrap items-center gap-3" role="group" aria-label="Filters">
        <SegmentedControl<RangeKey>
          label="Date range"
          size="sm"
          value={range}
          onChange={setRange}
          items={[
            { value: "7", label: "7 days" },
            { value: "28", label: "28 days" },
            { value: "90", label: "90 days" },
          ]}
        />
        <span className="inline-flex items-center gap-2 text-footnote text-ink-2">
          <Switch checked={compare} onCheckedChange={setCompare} label="Compare with previous period" />
          Compare with previous period
        </span>
        <div className="w-44">
          <Select selectSize="sm" aria-label="Channel" value={channel} onChange={(e) => setChannel(e.target.value as Channel | "")} options={[{ value: "", label: "All channels" }, ...Object.entries(CHANNEL_LABEL).map(([value, label]) => ({ value, label }))]} />
        </div>
        {campaigns.data?.items.length ? (
          <div className="w-52">
            <Select selectSize="sm" aria-label="Campaign" value={campaignId} onChange={(e) => setCampaignId(e.target.value)} options={[{ value: "", label: "All campaigns" }, ...campaigns.data.items.map((c) => ({ value: c.id, label: c.name }))]} />
          </div>
        ) : null}
        <span className="text-footnote text-ink-3">UTC days</span>
      </div>

      <QueryState query={overview} feature="Insights" skeleton={<OverviewSkeleton />}>
        {(data) => (
          <div className="space-y-10">
            <MetricGrid metrics={data.metrics} compare={Boolean(data.comparisonRange)} />
            {data.missing.length ? <MissingList missing={data.missing} onAction={(m) => (m.action === "widen_range" ? setRange("90") : ACTION_LABEL[m.action]?.focus && onOpenSources(ACTION_LABEL[m.action]!.focus!))} workspaceId={workspaceId} appId={appId} /> : null}
            <Funnel steps={data.funnel} />
            <CostView cost={data.cost} />
            <Notice tone="neutral" icon={<ShieldCheck aria-hidden />} title="How to read these numbers">
              <ul className="list-disc space-y-1 pl-4">
                {data.disclaimers.map((d) => (
                  <li key={d}>{d}</li>
                ))}
              </ul>
            </Notice>
          </div>
        )}
      </QueryState>
    </div>
  );
}

function OverviewSkeleton() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: 6 }, (_, i) => (
        <Skeleton key={i} className="h-36" rounded="xl" />
      ))}
    </div>
  );
}

function MetricGrid({ metrics, compare }: { metrics: InsightMetric[]; compare: boolean }) {
  const measured = metrics.filter((m) => m.value !== null || m.byCurrency);
  const unmeasured = metrics.filter((m) => m.value === null && !m.byCurrency);
  return (
    <Section title="Results" description="Only measured numbers are shown. Each one names its source, definition and how it's attributed.">
      {measured.length ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {measured.map((m) => (
            <MetricCard key={m.metric} m={m} compare={compare} />
          ))}
        </div>
      ) : (
        <Card tone="well" className="text-body-sm text-ink-2">
          Nothing is measured for this range yet. Connect a source or import data below; MuseLaunch never fills gaps with estimates.
        </Card>
      )}
      {unmeasured.length ? (
        <p className="text-footnote text-ink-3">
          Not measured for this range: {unmeasured.map((m) => m.label).join(", ")}.
        </p>
      ) : null}
    </Section>
  );
}

function MetricCard({ m, compare }: { m: InsightMetric; compare: boolean }) {
  const primary = m.sources.find((s) => s.observationCount > 0) ?? m.sources[0];
  const others = m.sources.filter((s) => s !== primary);
  const delta = m.comparison?.deltaPct ?? null;
  return (
    <Card className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-footnote font-medium text-ink-2">{m.label}</span>
        <Hint>
          <p className="font-medium">Definition</p>
          <p>{m.definition || "—"}</p>
          {m.window ? (
            <p className="mt-1">
              Window: {fmtDate(m.window.start, true)} – {fmtDate(m.window.end, true)} UTC
            </p>
          ) : null}
          {m.observationIds.length ? <p className="mt-1">Based on {m.observationIds.length} observation{m.observationIds.length > 1 ? "s" : ""}.</p> : null}
        </Hint>
      </div>
      <div className="text-title-2 font-semibold tabular">
        {m.value !== null ? (
          fmtNumber(m.value, m.unit, m.currency)
        ) : m.byCurrency ? (
          <span className="flex flex-col text-headline">
            {m.byCurrency.map((c) => (
              <span key={c.currency}>{fmtNumber(c.value, "currency", c.currency)}</span>
            ))}
          </span>
        ) : (
          <span className="text-ink-3">Not measured</span>
        )}
      </div>
      {compare && m.comparison ? (
        <p className="flex items-center gap-1 text-footnote text-ink-2">
          {delta === null ? (
            <span>{m.comparison.value === null ? "Previous period not measured" : "No comparable change"}</span>
          ) : (
            <>
              {delta > 0 ? <ArrowUpRight className="size-3.5" aria-hidden /> : delta < 0 ? <ArrowDownRight className="size-3.5" aria-hidden /> : <ArrowRight className="size-3.5" aria-hidden />}
              <span className="tabular">
                {delta > 0 ? "+" : ""}
                {delta}% vs previous period ({fmtNumber(m.comparison.value!, m.unit, m.currency)})
              </span>
            </>
          )}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-1.5">
        {primary ? <SourceBadge source={primary} /> : null}
        <AttributionBadge level={m.attribution} />
      </div>
      <div className="mt-auto space-y-1 text-footnote text-ink-3">
        {primary ? <p>{primary.label}</p> : null}
        {m.coverage && m.coverage.daysWithData < m.coverage.daysInRange ? (
          <p>
            Data for {m.coverage.daysWithData} of {m.coverage.daysInRange} days
          </p>
        ) : null}
        {others.map((s) => (
          <p key={s.source}>
            Also reported by {s.label}: {s.value === null ? "several currencies" : fmtNumber(s.value, m.unit, s.currency)} (not added)
          </p>
        ))}
        {m.notes
          .filter((n) => !n.startsWith("Data covers"))
          .slice(0, 2)
          .map((n) => (
            <p key={n}>{n}</p>
          ))}
      </div>
    </Card>
  );
}

function MissingList({ missing, onAction, workspaceId, appId }: { missing: MissingMetric[]; onAction: (m: MissingMetric) => void; workspaceId: string; appId: string }) {
  return (
    <Section title="Not measured yet" description="These are missing on purpose: nothing is estimated. Here's what would measure them.">
      <Card padding="none">
        <ul className="divide-y divide-line">
          {missing.map((m) => {
            const action = ACTION_LABEL[m.action];
            return (
              <li key={m.metric} className="flex flex-col gap-2 px-5 py-3.5 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="text-body-sm font-medium">{m.label}</p>
                  <p className="text-footnote text-ink-2">{m.reason}</p>
                </div>
                {m.action === "publish_post" ? (
                  <Button asChild size="sm" variant="outline">
                    <Link href={routes.app(workspaceId, appId).calendar}>Open calendar</Link>
                  </Button>
                ) : m.action === "widen_range" ? (
                  <Button size="sm" variant="outline" onClick={() => onAction(m)}>
                    Show 90 days
                  </Button>
                ) : action ? (
                  <Button size="sm" variant="outline" onClick={() => onAction(m)}>
                    {action.label}
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      </Card>
    </Section>
  );
}

function Funnel({ steps }: { steps: FunnelStep[] }) {
  return (
    <Section title="Funnel" description="Each step shows its own source. Rates are only shown when both steps are attributed to the same campaign.">
      <Card padding="none">
        <ol className="divide-y divide-line">
          {steps.map((s, i) => (
            <li key={s.metric} className="grid gap-2 px-5 py-3.5 sm:grid-cols-[minmax(0,10rem)_minmax(0,8rem)_1fr] sm:items-center">
              <span className="text-body-sm font-medium">
                <span className="mr-2 text-ink-3 tabular">{i + 1}</span>
                {s.label}
              </span>
              <span className={s.value === null ? "text-body-sm text-ink-3" : "text-body-sm font-semibold tabular"}>{s.value === null ? "Not measured" : fmtNumber(s.value, s.metric === "revenue" ? "currency" : "count")}</span>
              <span className="flex flex-wrap items-center gap-1.5 text-footnote text-ink-2">
                {s.sourceLabel ? <span>{s.sourceLabel}</span> : null}
                <AttributionBadge level={s.attribution} />
                {s.imported ? <Badge tone="outline">Imported/manual</Badge> : null}
                {i > 0 ? (
                  s.conversionFromPrevious !== null ? (
                    <Badge tone="accent">{(s.conversionFromPrevious * 100).toFixed(1)}% of previous step</Badge>
                  ) : s.conversionNote ? (
                    <span className="text-ink-3">{s.conversionNote}</span>
                  ) : null
                ) : null}
              </span>
            </li>
          ))}
        </ol>
      </Card>
    </Section>
  );
}

function CostView({ cost }: { cost: CostOutcome }) {
  return (
    <Section title="Cost vs outcome" description="What making content cost, next to measured outcomes. Ratios appear only when both are measured for the same scope.">
      <div className="grid gap-4 md:grid-cols-2">
        <Card className="space-y-3">
          <p className="text-footnote font-medium text-ink-2">Costs</p>
          <dl className="space-y-2 text-body-sm">
            <div className="flex justify-between gap-4">
              <dt className="flex items-center gap-1">
                AI provider cost <Hint>{cost.costs.contentUsd.definition}</Hint>
              </dt>
              <dd className="tabular">
                {fmtNumber(cost.costs.contentUsd.value, "currency", "USD")} <span className="text-ink-3">· {cost.costs.contentUsd.calls} calls</span>
              </dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="flex items-center gap-1">
                Credits used <Hint>{cost.costs.creditsConsumed.definition}</Hint>
              </dt>
              <dd className="tabular">{cost.costs.creditsConsumed.value}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt>Ad spend</dt>
              <dd className="tabular">{cost.costs.adSpend ? cost.costs.adSpend.map((a) => `${fmtNumber(a.value, "currency", a.currency)}${a.imported ? " (imported)" : ""}`).join(" · ") : <span className="text-ink-3">Not imported</span>}</dd>
            </div>
          </dl>
        </Card>
        <Card className="space-y-3">
          <p className="text-footnote font-medium text-ink-2">Outcomes</p>
          <dl className="space-y-2 text-body-sm">
            {cost.outcomes.map((o) => (
              <div key={o.metric} className="flex justify-between gap-4">
                <dt className="capitalize">{o.metric.replace(/_/g, " ")}</dt>
                <dd className="text-right tabular">
                  {o.value === null ? <span className="text-ink-3">Not measured</span> : fmtNumber(o.value, o.metric === "revenue" ? "currency" : "count", o.currency)}
                  {o.sourceLabel ? <span className="block text-caption text-ink-3">{o.sourceLabel}</span> : null}
                </dd>
              </div>
            ))}
          </dl>
          {cost.ratios.map((r) => (
            <p key={r.label} className="text-footnote text-ink-2">
              <span className="font-medium">{r.label}:</span> {fmtNumber(r.value, r.currency ? "currency" : "count", r.currency)} — {r.basis}
            </p>
          ))}
        </Card>
      </div>
      {cost.unknowns.length ? (
        <ul className="list-disc space-y-1 pl-5 text-footnote text-ink-2">
          {cost.unknowns.map((u) => (
            <li key={u}>{u}</li>
          ))}
        </ul>
      ) : null}
    </Section>
  );
}
