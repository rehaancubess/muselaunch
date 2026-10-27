"use client";
/**
 * Owner: module F. Plan, credits, plan limits, usage by model/task/day, upgrade requests and
 * (for ADMIN_UIDS only) operator ops. Rendered on /w/[workspaceId]/settings/credits.
 * Payments are not enabled in the beta: upgrades are recorded requests, never a fake checkout.
 */
import type { Plan, PlanId, Subscription, UpgradeRequestRecord, UsageSummary } from "@muselaunch/contracts";
import { Badge, Button, Card, Notice, ProgressBar, Section, SegmentedControl, Skeleton, Stat, Textarea, useToast } from "@muselaunch/ui";
import { CreditCard, ShieldAlert } from "lucide-react";
import { useState } from "react";
import { QueryState } from "@/components/states";
import { api, errorMessage, wsPath } from "@/lib/api";
import type { CreditsResponse } from "@/lib/api-types";
import { useApiQuery } from "@/lib/query";
import { useRouteIds, useWorkspace } from "@/lib/workspace";

type PlansResponse = {
  plans: Plan[];
  current: { plan: Plan; subscription: Subscription & { stored: boolean } };
  payments: { enabled: boolean; provider: string; message?: string };
  allowancePolicy: string;
};
type Quota = { used: number; limit: number };
type QuotasResponse = { plan: Plan; day: string; timezone: string; concurrentJobs: Quota; finalRendersPerDay: Quota; researchRunsPerDay: Quota };
type GroupBy = UsageSummary["groupBy"];

const fmtUsd = (v: number) => `$${v < 0.01 && v > 0 ? v.toFixed(4) : v.toFixed(2)}`;
const fmtDay = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

export default function BillingRoot() {
  const { workspaceId } = useRouteIds();
  if (!workspaceId) return null;
  return (
    <div className="space-y-12">
      <PlanSection workspaceId={workspaceId} />
      <QuotaSection workspaceId={workspaceId} />
      <UsageSection workspaceId={workspaceId} />
      <LedgerSection workspaceId={workspaceId} />
      <AdminSection workspaceId={workspaceId} />
    </div>
  );
}

function PlanSection({ workspaceId }: { workspaceId: string }) {
  const toast = useToast();
  const { can } = useWorkspace();
  const plans = useApiQuery<PlansResponse>(wsPath(workspaceId, "/billing/plans"));
  const credits = useApiQuery<CreditsResponse>(wsPath(workspaceId, "/billing/credits"));
  const requests = useApiQuery<{ items: UpgradeRequestRecord[] }>(wsPath(workspaceId, "/billing/upgrade-requests"));
  const [choosing, setChoosing] = useState<PlanId | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const request = async (planId: PlanId) => {
    setBusy(true);
    try {
      const res = await api.post<{ message: string }>(wsPath(workspaceId, "/billing/upgrade-request"), { planId, note: note || undefined });
      toast.success("Request recorded", res.message);
      setChoosing(null);
      setNote("");
      void requests.refetch();
    } catch (err) {
      toast.error("Couldn’t record the request", errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section title="Plan & credits">
      <QueryState query={plans} feature="Plans" skeleton={<Skeleton className="h-40" rounded="xl" />}>
        {(p) => (
          <div className="space-y-5">
            <Card className="grid gap-6 sm:grid-cols-4">
              <Stat label="Plan" value={p.current.plan.name} detail={p.current.subscription.provider === "manual" ? "Set by MuseLaunch" : "Beta"} />
              <Stat label="Available credits" value={credits.data ? credits.data.balance.available.toLocaleString() : "—"} detail={credits.data?.balance.reserved ? `${credits.data.balance.reserved} reserved for running work` : undefined} />
              <Stat label="Monthly credits" value={p.current.plan.monthlyCredits.toLocaleString()} detail={`Period ${fmtDay(p.current.subscription.currentPeriodStart)} – ${fmtDay(p.current.subscription.currentPeriodEnd)}`} />
              <Stat label="AI spend this month" value={credits.data ? fmtUsd(credits.data.spend.monthUsd) : "—"} detail={credits.data ? `Safety limit ${fmtUsd(credits.data.spend.ceilingUsd)}` : undefined} />
            </Card>
            <p className="text-footnote text-ink-2">{p.allowancePolicy}</p>
            {!p.payments.enabled ? (
              <Notice tone="info" icon={<CreditCard aria-hidden />} title="Payments aren't enabled in the beta">
                {(p.payments.message ?? "").replace(/^Payments aren['’]t enabled in the beta\.?\s*/i, "") || "Request an upgrade and an operator will switch your plan; nothing is charged."}
              </Notice>
            ) : null}
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {p.plans.map((plan) => {
                const current = plan.id === p.current.plan.id;
                const pending = requests.data?.items.find((r) => r.planId === plan.id && r.status === "recorded");
                return (
                  <Card key={plan.id} tone={current ? "well" : "raised"} className="flex flex-col gap-3">
                    <div className="flex items-center justify-between">
                      <span className="text-body-sm font-semibold">{plan.name}</span>
                      {current ? <Badge tone="accent">Current</Badge> : pending ? <Badge tone="warning">Requested</Badge> : null}
                    </div>
                    <p className="text-title-3 font-semibold tabular">{plan.monthlyCredits.toLocaleString()} <span className="text-footnote font-normal text-ink-2">credits / month</span></p>
                    <ul className="space-y-0.5 text-footnote text-ink-2">
                      <li>{plan.limits.apps} apps · {plan.limits.members} members</li>
                      <li>{plan.limits.concurrentJobs} tasks at once</li>
                      <li>{plan.limits.finalRendersPerDay} final renders / day</li>
                      <li>{plan.limits.researchRunsPerDay} research runs / day</li>
                      <li>Videos up to {plan.limits.maxVideoSec}s</li>
                    </ul>
                    {!current && can("billing.manage") ? (
                      choosing === plan.id ? (
                        <div className="space-y-2">
                          <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Anything we should know? (optional)" aria-label="Note" />
                          <div className="flex gap-2">
                            <Button size="sm" loading={busy} onClick={() => void request(plan.id)}>
                              Send request
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => setChoosing(null)}>
                              Cancel
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <Button size="sm" variant="outline" className="mt-auto" onClick={() => setChoosing(plan.id)} disabled={Boolean(pending)}>
                          {pending ? "Request sent" : "Request this plan"}
                        </Button>
                      )
                    ) : null}
                  </Card>
                );
              })}
            </div>
          </div>
        )}
      </QueryState>
    </Section>
  );
}

function QuotaSection({ workspaceId }: { workspaceId: string }) {
  const q = useApiQuery<QuotasResponse>(wsPath(workspaceId, "/billing/quotas"), { refetchInterval: 30_000 });
  return (
    <Section title="Plan limits" description="Daily limits reset at midnight UTC. Failed or cancelled work doesn't count.">
      <QueryState query={q} feature="Plan limits" skeleton={<Skeleton className="h-24" rounded="xl" />}>
        {(d) => (
          <Card className="grid gap-6 sm:grid-cols-3">
            <Meter label="Tasks running now" q={d.concurrentJobs} />
            <Meter label={`Final renders today`} q={d.finalRendersPerDay} />
            <Meter label={`Research runs today`} q={d.researchRunsPerDay} />
          </Card>
        )}
      </QueryState>
    </Section>
  );
}

function Meter({ label, q }: { label: string; q: Quota }) {
  const pct = q.limit ? Math.round((q.used / q.limit) * 100) : 0;
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between text-footnote">
        <span className="text-ink-2">{label}</span>
        <span className="tabular font-medium">
          {q.used} / {q.limit}
        </span>
      </div>
      <ProgressBar value={pct} tone={pct >= 100 ? "danger" : "accent"} label={`${label}: ${q.used} of ${q.limit}`} />
    </div>
  );
}

function UsageSection({ workspaceId }: { workspaceId: string }) {
  const [groupBy, setGroupBy] = useState<GroupBy>("model");
  const usage = useApiQuery<UsageSummary>(wsPath(workspaceId, "/billing/usage/summary"), { query: { groupBy }, placeholderData: (prev) => prev });
  return (
    <Section
      title="Usage (last 30 days)"
      description="Every AI and provider call is metered. Cost is MuseLaunch's estimated provider cost, not your credit price."
      actions={
        <SegmentedControl<GroupBy>
          label="Group usage by"
          size="sm"
          value={groupBy}
          onChange={setGroupBy}
          items={[
            { value: "model", label: "Model" },
            { value: "task", label: "Task" },
            { value: "provider", label: "Provider" },
            { value: "day", label: "Day" },
          ]}
        />
      }
    >
      <QueryState query={usage} feature="Usage" skeleton={<Skeleton className="h-48" rounded="xl" />}>
        {(u) => (
          <div className="space-y-4">
            {groupBy === "day" && u.rows.length > 1 ? <DailyCostChart rows={u.rows} /> : null}
            <Card padding="none" className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-left text-body-sm">
                <thead className="text-footnote text-ink-3">
                  <tr className="border-b border-line">
                    <th className="px-5 py-2 font-medium">{groupBy === "day" ? "Day (UTC)" : groupBy[0]!.toUpperCase() + groupBy.slice(1)}</th>
                    <th className="px-3 py-2 text-right font-medium">Calls</th>
                    <th className="px-3 py-2 text-right font-medium">Errors</th>
                    <th className="px-3 py-2 text-right font-medium">Tokens in / out</th>
                    <th className="px-3 py-2 text-right font-medium">Images · frames · audio</th>
                    <th className="px-5 py-2 text-right font-medium">Cost</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {u.rows.length ? (
                    u.rows.map((r) => (
                      <tr key={r.key}>
                        <td className="px-5 py-2 font-medium">{r.key}</td>
                        <td className="px-3 py-2 text-right tabular">{r.calls}</td>
                        <td className="px-3 py-2 text-right tabular">{r.errors || "—"}</td>
                        <td className="px-3 py-2 text-right tabular">
                          {r.inputTokens.toLocaleString()} / {r.outputTokens.toLocaleString()}
                        </td>
                        <td className="px-3 py-2 text-right tabular">
                          {r.images} · {r.frames} · {r.audioSeconds}s
                        </td>
                        <td className="px-5 py-2 text-right tabular">{fmtUsd(r.costUsd)}</td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={6} className="px-5 py-6 text-center text-ink-3">
                        No metered calls in this period.
                      </td>
                    </tr>
                  )}
                </tbody>
                {u.rows.length ? (
                  <tfoot className="border-t border-line-strong font-semibold">
                    <tr>
                      <td className="px-5 py-2">Total</td>
                      <td className="px-3 py-2 text-right tabular">{u.totals.calls}</td>
                      <td className="px-3 py-2 text-right tabular">{u.totals.errors || "—"}</td>
                      <td className="px-3 py-2 text-right tabular">
                        {u.totals.inputTokens.toLocaleString()} / {u.totals.outputTokens.toLocaleString()}
                      </td>
                      <td className="px-3 py-2 text-right tabular">
                        {u.totals.images} · {u.totals.frames} · {u.totals.audioSeconds}s
                      </td>
                      <td className="px-5 py-2 text-right tabular">{fmtUsd(u.totals.costUsd)}</td>
                    </tr>
                  </tfoot>
                ) : null}
              </table>
            </Card>
            <p className="text-footnote text-ink-2">
              Credits in this period: {u.credits.consumed} used · {u.credits.granted} granted · {u.credits.released} returned from failed or cancelled work.
              {u.truncated ? " Only the newest 20,000 calls are included." : ""}
            </p>
          </div>
        )}
      </QueryState>
    </Section>
  );
}

/** Single-series bar chart of daily provider cost (the table above is its accessible view). */
function DailyCostChart({ rows }: { rows: UsageSummary["rows"] }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 640;
  const H = 140;
  const pad = { l: 44, r: 8, t: 10, b: 22 };
  const max = Math.max(...rows.map((r) => r.costUsd), 0.0001);
  const bw = (W - pad.l - pad.r) / rows.length;
  const y = (v: number) => pad.t + (H - pad.t - pad.b) * (1 - v / max);
  const labelIdx = new Set([0, Math.floor(rows.length / 2), rows.length - 1]);
  return (
    <Card className="relative">
      <p className="mb-2 text-footnote font-medium text-ink-2">Estimated provider cost per day (USD)</p>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={`Daily cost over ${rows.length} days, highest ${fmtUsd(max)}`}>
        <line x1={pad.l} x2={W - pad.r} y1={y(0)} y2={y(0)} className="stroke-line" strokeWidth={1} />
        <line x1={pad.l} x2={W - pad.r} y1={y(max)} y2={y(max)} className="stroke-line" strokeWidth={1} strokeDasharray="2 4" />
        <text x={pad.l - 6} y={y(max) + 4} textAnchor="end" className="fill-ink-3 text-[11px]">
          {fmtUsd(max)}
        </text>
        <text x={pad.l - 6} y={y(0) + 4} textAnchor="end" className="fill-ink-3 text-[11px]">
          $0
        </text>
        {rows.map((r, i) => {
          const h = Math.max(0, y(0) - y(r.costUsd));
          const x = pad.l + i * bw + 1;
          const w = Math.max(1, bw - 2);
          return (
            <g key={r.key} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              <rect x={pad.l + i * bw} y={pad.t} width={bw} height={H - pad.t - pad.b} fill="transparent" />
              {h > 0 ? <path d={roundedTop(x, y(r.costUsd), w, h, Math.min(4, w / 2, h))} className={hover === i ? "fill-accent-hover" : "fill-accent"} /> : null}
              {labelIdx.has(i) ? (
                <text x={x + w / 2} y={H - 6} textAnchor="middle" className="fill-ink-3 text-[11px]">
                  {r.key.slice(5)}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
      {hover !== null ? (
        <div className="pointer-events-none absolute right-5 top-4 rounded-md bg-ink px-2.5 py-1.5 text-footnote text-white shadow-float">
          {rows[hover]!.key}: {fmtUsd(rows[hover]!.costUsd)} · {rows[hover]!.calls} calls
        </div>
      ) : null}
    </Card>
  );
}

function roundedTop(x: number, y: number, w: number, h: number, r: number) {
  return `M${x},${y + h} L${x},${y + r} Q${x},${y} ${x + r},${y} L${x + w - r},${y} Q${x + w},${y} ${x + w},${y + r} L${x + w},${y + h} Z`;
}

function LedgerSection({ workspaceId }: { workspaceId: string }) {
  const credits = useApiQuery<CreditsResponse>(wsPath(workspaceId, "/billing/credits"));
  if (!credits.data?.ledger.length) return null;
  return (
    <Section title="Credit activity" description="Holds are placed when work starts; unused or failed work returns them.">
      <Card padding="none">
        <ul className="divide-y divide-line">
          {credits.data.ledger.slice(0, 15).map((l) => (
            <li key={l.id} className="flex items-center justify-between gap-3 px-5 py-2.5 text-body-sm">
              <span className="min-w-0 truncate">
                <span className="font-medium capitalize">{l.type}</span> <span className="text-ink-2">· {l.reason}</span>
              </span>
              <span className="shrink-0 text-footnote text-ink-2 tabular">
                {l.type === "grant" || l.type === "release" || l.type === "refund" ? "+" : l.type === "reserve" || l.type === "consume" ? "−" : ""}
                {l.credits} · {new Date(l.createdAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
              </span>
            </li>
          ))}
        </ul>
      </Card>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Operator view (ADMIN_UIDS). Non-admins get 404 and nothing renders.
// ---------------------------------------------------------------------------

type OpsResponse = {
  generatedAt: string;
  spend: { todayUsd: number; todayCalls: number; globalDailyCeilingUsd: number; workspaceMonthlyCeilingUsd: number; pctOfCeiling: number | null };
  jobs: {
    today: Record<string, unknown> | null;
    active: { queued: number; running: number };
    stuckLeases: { jobId: string; workspaceId: string; type: string; expiredForMin: number }[];
    note: string;
  };
  recentFailures: { at: string; workspaceId: string; jobId: string; type: string; code: string; message: string }[];
  providers: { today: { provider: string; calls: number; errors: number; errorRate: number; usd: number }[] };
  upgradeRequests: UpgradeRequestRecord[];
};

function AdminSection({ workspaceId }: { workspaceId: string }) {
  const toast = useToast();
  const ops = useApiQuery<OpsResponse>(wsPath(workspaceId, "/admin/ops"), { retry: false, refetchInterval: 60_000 });
  if (!ops.data) return null;
  const d = ops.data;
  const today = (d.jobs.today ?? {}) as Record<string, number>;
  const apply = async (r: UpgradeRequestRecord) => {
    try {
      await api.post(wsPath(workspaceId, `/admin/workspaces/${r.workspaceId}/plan`), { planId: r.planId, note: `Upgrade request ${r.id}` });
      toast.success("Plan applied", `${r.workspaceId} → ${r.planId}`);
      void ops.refetch();
    } catch (err) {
      toast.error("Couldn’t apply", errorMessage(err));
    }
  };
  return (
    <Section title="Operations" description="Visible to MuseLaunch operators only. Global counters across all workspaces.">
      <Card className="grid gap-6 sm:grid-cols-4">
        <div className="space-y-2">
          <Stat label="AI spend today (all workspaces)" value={fmtUsd(d.spend.todayUsd)} detail={`Ceiling ${fmtUsd(d.spend.globalDailyCeilingUsd)} · ${d.spend.todayCalls} calls`} />
          <ProgressBar value={d.spend.pctOfCeiling ?? 0} tone={(d.spend.pctOfCeiling ?? 0) > 80 ? "danger" : "accent"} label="Share of daily ceiling" />
        </div>
        <Stat label="Jobs today" value={`${today.created ?? 0}`} detail={`${today.succeeded ?? 0} succeeded · ${today.failed ?? 0} failed · ${today.cancelled ?? 0} cancelled`} />
        <Stat label="Active now" value={`${d.jobs.active.running} running`} detail={`${d.jobs.active.queued} queued`} />
        <Stat label="Stuck leases" value={d.jobs.stuckLeases.length} detail={d.jobs.stuckLeases.length ? d.jobs.stuckLeases.slice(0, 2).map((s) => `${s.type} (${s.expiredForMin} min)`).join(", ") : "None"} />
      </Card>
      <p className="text-footnote text-ink-3">{d.jobs.note}</p>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card padding="none">
          <p className="px-5 pt-4 text-footnote font-medium text-ink-2">Provider error rates (today)</p>
          <ul className="divide-y divide-line">
            {d.providers.today.length ? (
              d.providers.today.map((p) => (
                <li key={p.provider} className="flex justify-between px-5 py-2 text-body-sm">
                  <span className="font-medium">{p.provider}</span>
                  <span className="tabular text-ink-2">
                    {p.calls} calls · {(p.errorRate * 100).toFixed(1)}% errors · {fmtUsd(p.usd)}
                  </span>
                </li>
              ))
            ) : (
              <li className="px-5 py-3 text-body-sm text-ink-3">No calls today.</li>
            )}
          </ul>
        </Card>
        <Card padding="none">
          <p className="px-5 pt-4 text-footnote font-medium text-ink-2">Recent failures</p>
          <ul className="max-h-64 divide-y divide-line overflow-auto">
            {d.recentFailures.length ? (
              d.recentFailures.slice(0, 20).map((f) => (
                <li key={`${f.jobId}-${f.at}`} className="px-5 py-2 text-footnote">
                  <span className="font-medium text-ink">{f.type}</span> <Badge tone="danger">{f.code}</Badge> <span className="text-ink-3">{new Date(f.at).toLocaleTimeString()}</span>
                  <span className="block truncate text-ink-2">{f.message}</span>
                </li>
              ))
            ) : (
              <li className="px-5 py-3 text-body-sm text-ink-3">None.</li>
            )}
          </ul>
        </Card>
      </div>
      {d.upgradeRequests.length ? (
        <Card padding="none">
          <p className="flex items-center gap-2 px-5 pt-4 text-footnote font-medium text-ink-2">
            <ShieldAlert className="size-4" aria-hidden /> Upgrade requests
          </p>
          <ul className="divide-y divide-line">
            {d.upgradeRequests.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-3 px-5 py-2.5 text-body-sm">
                <span className="min-w-0 truncate">
                  {r.workspaceId}: {r.fromPlanId} → <span className="font-medium">{r.planId}</span>
                  {r.note ? <span className="text-ink-2"> · {r.note}</span> : null}
                </span>
                <Button size="sm" variant="outline" onClick={() => void apply(r)}>
                  Apply plan
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </Section>
  );
}
