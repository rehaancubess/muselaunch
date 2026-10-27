"use client";
import type { ConnectedAccount } from "@muselaunch/contracts";
import { Badge, ErrorState, List, ListRow, Notice, PageHeader, ProvenanceBadge, Section, Skeleton, StatusPill, humanizeStatus, statusKindOf, type Provenance } from "@muselaunch/ui";
import { Bot, Clapperboard, Globe, Image as ImageIcon, Mic, Brain, ScanFace, Sparkles, Volume2, Film, Link2 } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { QueryState } from "@/components/states";
import { errorMessage, wsPath } from "@/lib/api";
import type { Page, ProviderState, ProviderStatusResponse } from "@/lib/api-types";
import { relativeTime } from "@/lib/labels";
import { useApiQuery } from "@/lib/query";
import { routes } from "@/lib/routes";
import { useWorkspace } from "@/lib/workspace";

const STATE_BADGE: Record<ProviderState, { kind: Provenance; label: string }> = {
  live: { kind: "live_ai", label: "Live" },
  not_configured: { kind: "not_connected", label: "Not connected" },
  restricted: { kind: "restricted", label: "Restricted" },
  manual_only: { kind: "manual_only", label: "Manual only" },
  pending_approval: { kind: "pending_approval", label: "Awaiting approval" },
};

const ICONS: Record<string, ReactNode> = {
  "muse-wonder": <Bot aria-hidden />,
  "muse-spark": <Sparkles aria-hidden />,
  sam: <ScanFace aria-hidden />,
  "muse-voice": <Mic aria-hidden />,
  "muse-image": <ImageIcon aria-hidden />,
  "image-alt": <ImageIcon aria-hidden />,
  "muse-glimmer": <Brain aria-hidden />,
  tts: <Volume2 aria-hidden />,
  stock: <Film aria-hidden />,
};

function regionName(code: string | null) {
  if (!code) return null;
  try {
    return new Intl.DisplayNames(undefined, { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
}

export default function IntegrationsPage() {
  const { workspaceId } = useWorkspace();
  const status = useApiQuery<ProviderStatusResponse>("/v1/status/providers", { staleTime: 60_000 });
  const connections = useApiQuery<Page<ConnectedAccount>>(wsPath(workspaceId, "/connections"), { retry: false });

  return (
    <div className="space-y-12">
      <PageHeader title="Integrations" description="What’s live on this deployment, what isn’t, and what MuseLaunch uses instead. Nothing unavailable is simulated." className="pb-0" />

      <Section title="AI models & media providers">
        {status.isLoading ? (
          <div className="space-y-px overflow-hidden rounded-xl shadow-raised">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-16 rounded-none" />
            ))}
          </div>
        ) : status.error ? (
          <ErrorState title="Provider status didn’t load" message={errorMessage(status.error)} onRetry={() => status.refetch()} retrying={status.isFetching} />
        ) : status.data ? (
          <div className="space-y-4">
            <List label="Providers">
              {status.data.items.map((p) => (
                <ListRow
                  key={p.id}
                  leading={<span className="flex size-9 items-center justify-center rounded-lg bg-mist text-ink-2 [&_svg]:size-[18px]">{ICONS[p.id] ?? <Globe aria-hidden />}</span>}
                  title={p.label}
                  subtitle={p.role}
                  trailing={<ProvenanceBadge kind={STATE_BADGE[p.state].kind} label={STATE_BADGE[p.state].label} detail={p.detail} />}
                >
                  <p className="mt-0.5 truncate text-caption text-ink-3" title={p.detail}>
                    {p.detail}
                  </p>
                </ListRow>
              ))}
            </List>
            <p className="text-footnote text-ink-2">
              {status.data.country ? (
                <>
                  Provider eligibility uses your country, {regionName(status.data.country)}.{" "}
                  <Link href={routes.settings.workspace(workspaceId)} className="font-medium text-accent hover:underline">
                    Change it
                  </Link>
                  .
                </>
              ) : (
                <>
                  Set your country in{" "}
                  <Link href={routes.settings.workspace(workspaceId)} className="font-medium text-accent hover:underline">
                    settings
                  </Link>{" "}
                  so we can choose eligible providers.
                </>
              )}
            </p>
          </div>
        ) : null}
      </Section>

      <Section title="Connected accounts" description="Publishing, analytics and outreach accounts you’ve authorised. Posting always asks for approval first.">
        <QueryState
          query={connections}
          feature="Account connections"
          unavailable={
            <Notice icon={<Link2 aria-hidden />} title="Account connections aren’t available in this build yet">
              Until they are, export packages and manual posting checklists cover publishing, and CSV imports cover analytics, each labelled as imported.
            </Notice>
          }
        >
          {(data) =>
            data.items.length ? (
              <List label="Connected accounts">
                {data.items.map((a) => (
                  <ListRow
                    key={a.id}
                    leading={<span className="flex size-9 items-center justify-center rounded-lg bg-mist text-ink-2"><Clapperboard className="size-[18px]" aria-hidden /></span>}
                    title={`${humanizeStatus(a.provider)}: ${a.displayName}`}
                    subtitle={`${a.purposes.map(humanizeStatus).join(", ")}${a.lastSyncAt ? `, synced ${relativeTime(a.lastSyncAt)}` : ""}`}
                    trailing={
                      <>
                        {a.capabilities.slice(0, 2).map((c) => (
                          <Badge key={c} tone="outline" className="hidden sm:inline-flex">
                            {humanizeStatus(c)}
                          </Badge>
                        ))}
                        <StatusPill status={statusKindOf(a.status)}>{humanizeStatus(a.status)}</StatusPill>
                      </>
                    }
                  />
                ))}
              </List>
            ) : (
              <Notice>No accounts connected. Connect publishing accounts from the Calendar and analytics sources from Insights.</Notice>
            )
          }
        </QueryState>
      </Section>

      {status.data ? (
        <p className="text-caption text-ink-3">
          Deployment: jobs run via {status.data.jobDispatch}, files stored in {status.data.storage} storage, data in {status.data.db}.
        </p>
      ) : null}
    </div>
  );
}
