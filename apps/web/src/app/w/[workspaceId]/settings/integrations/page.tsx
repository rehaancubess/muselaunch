"use client";
import { ErrorState, List, ListRow, Notice, PageHeader, ProvenanceBadge, Section, Skeleton, useToast, type Provenance } from "@muselaunch/ui";
import { BarChart3, Bot, Brain, Film, Globe, Image as ImageIcon, Mic, ScanFace, Sparkles, Volume2 } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, type ReactNode } from "react";
import { readLastApp } from "@/components/shell/app-shell";
import { ConnectionsPanel } from "@/features/publishing";
import { errorMessage } from "@/lib/api";
import type { ProviderState, ProviderStatusResponse } from "@/lib/api-types";
import { useApiQuery } from "@/lib/query";
import { routes } from "@/lib/routes";
import { useRuntime } from "@/lib/runtime";
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

/** Toast the result of an OAuth round trip (the callback redirects here with ?connections=1&status=…). */
function OAuthReturnToast() {
  const params = useSearchParams();
  const router = useRouter();
  const toast = useToast();
  useEffect(() => {
    if (params.get("connections") !== "1") return;
    const provider = params.get("provider") ?? "Account";
    const st = params.get("status");
    if (st === "connected") toast.success(`${provider} connected`, params.get("message") ?? undefined);
    else if (st) toast.error(`${provider} wasn’t connected`, params.get("message") ?? undefined);
    router.replace(window.location.pathname);
  }, [params, router, toast]);
  return null;
}

export default function IntegrationsPage() {
  const { workspaceId, apps } = useWorkspace();
  const runtime = useRuntime();
  const fixture = runtime.data?.fixtureMode === true;
  const status = useApiQuery<ProviderStatusResponse>("/v1/status/providers", { staleTime: 60_000 });
  const last = typeof window !== "undefined" ? readLastApp(workspaceId) : null;
  const appId = apps.find((a) => a.id === last)?.id ?? apps[0]?.id;

  return (
    <div className="space-y-12">
      <Suspense>
        <OAuthReturnToast />
      </Suspense>
      {fixture ? <Notice tone="warning" title="Fixture mode">Providers marked “Fixture” answer from labelled test fixtures on this local server. Nothing here reflects a live model.</Notice> : null}
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
                  trailing={
                    fixture && p.state === "live" ? (
                      <ProvenanceBadge kind="restricted" label="Fixture" detail="Fixture mode: answered from labelled test fixtures, not a live model" />
                    ) : (
                      <ProvenanceBadge kind={STATE_BADGE[p.state].kind} label={STATE_BADGE[p.state].label} detail={p.detail} />
                    )
                  }
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

      <Section title="Publishing & outreach accounts" description="Accounts you authorise for posting and creator outreach. Every post and message still waits for an approval.">
        <ConnectionsPanel />
      </Section>

      <Section title="Analytics sources">
        <Notice icon={<BarChart3 aria-hidden />}>
          Connect RevenueCat or import App Store, Play Console and social CSVs from each app’s{" "}
          {appId ? (
            <Link href={routes.app(workspaceId, appId).insights} className="font-medium text-accent hover:underline">
              Insights › Data sources
            </Link>
          ) : (
            "Insights › Data sources"
          )}
          . Imported numbers stay labelled as imported.
        </Notice>
      </Section>

      {status.data ? (
        <p className="text-caption text-ink-3">
          Deployment: jobs run via {status.data.jobDispatch}, files stored in {status.data.storage} storage, data in {status.data.db}.
        </p>
      ) : null}
    </div>
  );
}
