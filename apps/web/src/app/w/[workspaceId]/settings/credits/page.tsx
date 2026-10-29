"use client";
import { modelDisplayName, type ModelUsageEvent } from "@muselaunch/contracts";
import { EmptyState, PageHeader, Section, Skeleton, StatusPill } from "@muselaunch/ui";
import { Cpu, ReceiptText } from "lucide-react";
import BillingRoot from "@/features/billing";
import { QueryState } from "@/components/states";
import { wsPath } from "@/lib/api";
import type { UsagePage } from "@/lib/api-types";

import { relativeTime } from "@/lib/labels";
import { useApiQuery } from "@/lib/query";
import { useWorkspace } from "@/lib/workspace";

function usd(n: number) {
  return n < 0.01 && n > 0 ? "<$0.01" : `$${n.toFixed(2)}`;
}

function Usage({ workspaceId }: { workspaceId: string }) {
  const q = useApiQuery<UsagePage>(wsPath(workspaceId, "/usage"), { query: { limit: 50 } });
  return (
    <Section title="Recent model calls" description="Each AI and media provider call, one by one, with tokens and estimated cost. Recorded even when a call fails.">
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
                        <span className="font-medium text-ink">{modelDisplayName(u.model)}</span>
                        <span className="block text-caption text-ink-3">
                          {u.model !== modelDisplayName(u.model) ? `${u.model} · ` : ""}
                          {u.provider === "glimmer" ? "Self-hosted" : u.provider === "baseten" ? "Baseten" : u.provider}
                        </span>
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
  return (
    <div className="space-y-12">
      <PageHeader title="Credits & billing" description="Credits pay for AI and rendering work. Each costly action shows its estimate first; unused reservations are released automatically." className="pb-0" />
      <BillingRoot />
      <Usage workspaceId={workspaceId} />
    </div>
  );
}
