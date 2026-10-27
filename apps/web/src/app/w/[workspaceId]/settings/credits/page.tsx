"use client";
import type { CreditLedgerEntry, ModelUsageEvent } from "@muselaunch/contracts";
import { Badge, EmptyState, PageHeader, ProgressBar, Section, Skeleton, StatusPill, cn, jobLabel, type BadgeTone } from "@muselaunch/ui";
import { Cpu, ReceiptText } from "lucide-react";
import BillingRoot from "@/features/billing";
import { QueryState } from "@/components/states";
import { wsPath } from "@/lib/api";
import type { CreditsResponse, UsagePage } from "@/lib/api-types";

import { relativeTime } from "@/lib/labels";
import { useApiQuery } from "@/lib/query";
import { useWorkspace } from "@/lib/workspace";

const LEDGER: Record<CreditLedgerEntry["type"], { label: string; tone: BadgeTone; sign: 1 | -1 | 0 }> = {
  grant: { label: "Granted", tone: "success", sign: 1 },
  reserve: { label: "Reserved", tone: "neutral", sign: -1 },
  consume: { label: "Used", tone: "neutral", sign: 0 },
  release: { label: "Released", tone: "accent", sign: 1 },
  refund: { label: "Refunded", tone: "success", sign: 1 },
  adjust: { label: "Adjusted", tone: "outline", sign: 0 },
  expire: { label: "Expired", tone: "warning", sign: -1 },
};

function usd(n: number) {
  return n < 0.01 && n > 0 ? "<$0.01" : `$${n.toFixed(2)}`;
}

function Usage({ workspaceId }: { workspaceId: string }) {
  const q = useApiQuery<UsagePage>(wsPath(workspaceId, "/usage"), { query: { limit: 50 } });
  return (
    <Section title="Model calls" description="Every AI and media provider call, with tokens and estimated cost. Recorded even when a call fails.">
      <QueryState query={q} feature="Usage" skeleton={<Skeleton className="h-40" rounded="xl" />}>
        {(data) =>
          data.items.length ? (
            <div className="overflow-x-auto rounded-xl bg-surface shadow-raised">
              <table className="w-full min-w-[640px] text-left text-footnote">
                <thead className="border-b border-line text-caption text-ink-3">
                  <tr>
                    <th className="px-4 py-2.5 font-medium">Model</th>
                    <th className="px-4 py-2.5 font-medium">Task</th>
                    <th className="px-4 py-2.5 text-right font-medium">Tokens in / out</th>
                    <th className="px-4 py-2.5 text-right font-medium">Est. cost</th>
                    <th className="px-4 py-2.5 font-medium">Result</th>
                    <th className="px-4 py-2.5 text-right font-medium">When</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {data.items.map((u: ModelUsageEvent) => (
                    <tr key={u.id}>
                      <td className="px-4 py-2.5">
                        <span className="font-medium text-ink">{u.model}</span>
                        <span className="block text-caption text-ink-3">{u.provider === "glimmer" ? "Self-hosted" : u.provider}</span>
                      </td>
                      <td className="max-w-56 truncate px-4 py-2.5 text-ink-2">{u.task}</td>
                      <td className="px-4 py-2.5 text-right tabular text-ink-2">{u.inputTokens != null ? `${u.inputTokens.toLocaleString()} / ${(u.outputTokens ?? 0).toLocaleString()}` : u.images ? `${u.images} image${u.images === 1 ? "" : "s"}` : u.audioSeconds ? `${Math.round(u.audioSeconds)}s audio` : "—"}</td>
                      <td className="px-4 py-2.5 text-right tabular">{usd(u.costUsdEstimate)}</td>
                      <td className="px-4 py-2.5">
                        <StatusPill status={u.status === "ok" ? "success" : "failed"}>{u.status === "ok" ? (u.cacheHit ? "Cached" : "OK") : (u.errorCode ?? "Error")}</StatusPill>
                      </td>
                      <td className="px-4 py-2.5 text-right text-ink-3">{relativeTime(u.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="rounded-xl bg-mist/60">
              <EmptyState size="sm" icon={<Cpu aria-hidden />} title="No model calls yet" description="Calls appear here as soon as Muse analyses an app, researches or edits." />
            </div>
          )
        }
      </QueryState>
    </Section>
  );
}

export default function CreditsPage() {
  const { workspaceId } = useWorkspace();
  const q = useApiQuery<CreditsResponse>(wsPath(workspaceId, "/billing/credits"), { refetchInterval: 15_000 });
  return (
    <div className="space-y-12">
      <PageHeader title="Credits & billing" description="Credits pay for AI and rendering work. Each action shows its estimate first; unused reservations are released automatically." className="pb-0" />
      <QueryState
        query={q}
        feature="Credits"
        skeleton={
          <div className="grid gap-4 sm:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-28" rounded="xl" />
            ))}
          </div>
        }
      >
        {(d) => {
          const pct = d.spend.ceilingUsd > 0 ? (d.spend.monthUsd / d.spend.ceilingUsd) * 100 : 0;
          return (
            <div className="space-y-12">
              <div className="grid gap-4 sm:grid-cols-3">
                <div className="space-y-1 rounded-xl bg-surface p-5 shadow-raised">
                  <p className="text-footnote text-ink-2">Available</p>
                  <p className="text-display font-semibold tabular">{d.balance.available.toLocaleString()}</p>
                  <p className="text-footnote text-ink-3">{d.plan.name}: {d.plan.monthlyCredits.toLocaleString()} credits a month</p>
                </div>
                <div className="space-y-1 rounded-xl bg-surface p-5 shadow-raised">
                  <p className="text-footnote text-ink-2">Reserved by running jobs</p>
                  <p className="text-display font-semibold tabular text-ink-2">{d.balance.reserved.toLocaleString()}</p>
                  <p className="text-footnote text-ink-3">{d.balance.lifetimeConsumed.toLocaleString()} used since you joined</p>
                </div>
                <div className="space-y-3 rounded-xl bg-surface p-5 shadow-raised">
                  <p className="text-footnote text-ink-2">Provider spend this month</p>
                  <p className="text-title-1 font-semibold tabular">
                    {usd(d.spend.monthUsd)} <span className="text-body font-normal text-ink-3">of {usd(d.spend.ceilingUsd)}</span>
                  </p>
                  <ProgressBar value={pct} tone={pct > 90 ? "danger" : "accent"} label="Spend against monthly safety ceiling" />
                  <p className="text-caption text-ink-3">AI work pauses at the ceiling so costs can’t run away.</p>
                </div>
              </div>

              <Section title="Activity">
                {d.ledger.length ? (
                  <ul className="divide-y divide-line overflow-hidden rounded-xl bg-surface shadow-raised">
                    {d.ledger.map((e) => {
                      const l = LEDGER[e.type];
                      return (
                        <li key={e.id} className="flex items-center gap-3 px-4 py-3">
                          <Badge tone={l.tone} className="w-20 justify-center">
                            {l.label}
                          </Badge>
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-body-sm text-ink">{e.operation ? jobLabel(e.operation) : e.reason}</p>
                            <p className="truncate text-caption text-ink-3">
                              {e.operation ? `${e.reason}, ` : ""}
                              {relativeTime(e.createdAt)}
                            </p>
                          </div>
                          <p className={cn("shrink-0 text-body-sm font-medium tabular", l.sign > 0 ? "text-success" : l.sign < 0 ? "text-ink" : "text-ink-2")}>
                            {l.sign > 0 ? "+" : l.sign < 0 ? "−" : ""}
                            {e.credits.toLocaleString()}
                          </p>
                          <p className="hidden w-24 shrink-0 text-right text-caption tabular text-ink-3 sm:block">{e.balanceAfter.available.toLocaleString()} left</p>
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <EmptyState size="sm" icon={<ReceiptText aria-hidden />} title="No credit activity yet" />
                )}
              </Section>
            </div>
          );
        }}
      </QueryState>
      <Usage workspaceId={workspaceId} />
      <BillingRoot />
    </div>
  );
}
