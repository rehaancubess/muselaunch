"use client";
import type { Campaign } from "@muselaunch/contracts";
import { Button, EmptyState, List, ListRow, Notice, Section, Skeleton, StatusPill, statusKindOf } from "@muselaunch/ui";
import { ArrowUp, Clapperboard, Dna, Plus, Rocket } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { PageContainer } from "@/components/page-container";
import { QueryState } from "@/components/states";
import { AppIcon } from "@/components/app-icon";
import { AgentRunsList } from "@/features/agents";
import { AutopilotHome } from "@/features/autopilot/home";
import { STATUS_COPY, statusKind } from "@/features/autopilot/types";
import { WalkthroughPrompt } from "@/features/media/walkthrough";
import { useActiveAutopilot } from "@/components/shell/autopilot-chip";
import { wsPath } from "@/lib/api";
import type { Page } from "@/lib/api-types";
import { CHANNEL_LABEL, GOAL_LABEL, campaignStatusLabel, relativeTime } from "@/lib/labels";
import { useApiQuery } from "@/lib/query";
import { routes } from "@/lib/routes";
import { useCurrentApp, useWorkspace } from "@/lib/workspace";

function suggestions(appName: string) {
  return [
    { label: "Launch Reels", text: `Create five vertical Reels introducing ${appName}, with a premium, minimal Apple-style look.` },
    { label: "Feature demo", text: `Make a 20-second demo of ${appName}'s most useful feature, using real screen recordings on an animated iPhone.` },
    { label: "Founder story", text: `Plan a founder-story video for ${appName}: why I built it and who it's for.` },
    { label: "Store screenshots", text: `Design a set of App Store screenshot graphics for ${appName} that highlight verified features.` },
  ];
}

function Composer({ appName, href }: { appName: string; href: (text: string) => string }) {
  const router = useRouter();
  const [text, setText] = useState("");
  const submit = () => {
    const t = text.trim();
    router.push(href(t));
  };
  return (
    <div className="space-y-4">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="group relative rounded-2xl bg-surface shadow-[0_1px_2px_rgb(16_24_40/0.04),0_0_0_1px_rgb(16_24_40/0.08),0_12px_32px_-16px_rgb(16_24_40/0.16)] transition-shadow focus-within:shadow-[0_0_0_1px_var(--ml-accent),0_0_0_4px_rgb(51_85_255/0.14),0_12px_32px_-16px_rgb(16_24_40/0.16)]"
      >
        <label htmlFor="creator-request" className="sr-only">
          Describe the campaign you want
        </label>
        <textarea
          id="creator-request"
          rows={3}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
          }}
          placeholder={`Describe what you want to make for ${appName}…`}
          className="block w-full resize-none rounded-2xl bg-transparent px-5 pb-14 pt-4 text-body text-ink outline-none placeholder:text-ink-3"
        />
        <div className="absolute inset-x-3 bottom-3 flex items-center justify-between gap-3">
          <p className="hidden pl-2 text-caption text-ink-3 sm:block">You’ll pick goals, channels and see the credit cost before anything runs.</p>
          <Button type="submit" size="sm" className="ml-auto" trailing={<ArrowUp className="size-3.5" aria-hidden />}>
            Plan campaign
          </Button>
        </div>
      </form>
      <div className="flex flex-wrap gap-2">
        {suggestions(appName).map((s) => (
          <button
            key={s.label}
            type="button"
            onClick={() => setText(s.text)}
            className="h-8 rounded-full border border-line bg-surface px-3 text-footnote text-ink-2 transition-colors hover:border-line-strong hover:text-ink"
          >
            {s.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function CampaignRows({ items, wid, appId }: { items: Campaign[]; wid: string; appId: string }) {
  const r = routes.app(wid, appId);
  return (
    <List label="Campaigns">
      {items.map((c) => (
        <ListRow
          key={c.id}
          href={r.campaign(c.id)}
          leading={
            <span className="flex size-10 items-center justify-center rounded-lg bg-mist text-ink-2">
              <Clapperboard className="size-[18px]" aria-hidden />
            </span>
          }
          title={c.name}
          subtitle={`${GOAL_LABEL[c.goal]}${c.channels.length ? ` for ${c.channels.map((ch) => CHANNEL_LABEL[ch]).join(", ")}` : ""}, started ${relativeTime(c.createdAt)}`}
          trailing={<StatusPill status={statusKindOf(c.status)}>{campaignStatusLabel(c.status)}</StatusPill>}
        />
      ))}
    </List>
  );
}

/** Growth Autopilot entry: start one, or jump back into the running loop (one per app). */
function AutopilotCard({ workspaceId, appId }: { workspaceId: string; appId: string }) {
  const r = routes.app(workspaceId, appId);
  const active = useActiveAutopilot(workspaceId, appId);
  const needsYou = active?.status === "awaiting_user";
  return (
    <Link
      href={active ? `${r.autopilot}?loop=${encodeURIComponent(active.id)}` : r.autopilot}
      className="group mb-10 flex flex-col gap-4 rounded-2xl bg-mist/70 p-5 transition-colors hover:bg-mist sm:flex-row sm:items-center sm:p-6"
    >
      <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-accent text-white">
        <Rocket className="size-5" aria-hidden />
      </span>
      {active ? (
        <span className="min-w-0 flex-1 space-y-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-headline font-semibold text-ink">Growth Autopilot is running</span>
            <StatusPill status={statusKind(active.status)}>{STATUS_COPY[active.status]}</StatusPill>
          </span>
          <span className="block truncate text-body-sm text-ink-2">{active.goal}</span>
          <span className="block text-footnote text-ink-3 text-pretty">{needsYou ? "It’s waiting for your decision at a checkpoint." : (active.lastLog?.summary ?? "Working through the loop within your budget.")}</span>
        </span>
      ) : (
        <span className="min-w-0 flex-1 space-y-1">
          <span className="block text-headline font-semibold text-ink">Or let Growth Autopilot run the loop</span>
          <span className="block text-body-sm text-ink-2 text-pretty">
            Give Muse Wonder a goal. It researches, picks an audience with sources, tests a hypothesis, produces and checks the creative, and drafts posts for your approval, within a credit budget you set.
          </span>
        </span>
      )}
      <span className="inline-flex h-9 shrink-0 items-center gap-2 self-start rounded-full bg-ink px-4 text-body-sm font-medium text-white transition-colors group-hover:bg-ink/85 sm:self-center">
        {active ? (needsYou ? "Review checkpoint" : "Open loop") : "Start Growth Autopilot"}
      </span>
    </Link>
  );
}

/**
 * Creator tab. Autopilot on (the default): the app's Home — what Growth Autopilot is doing, what it
 * made, what needs you — with "Create a campaign myself" as the secondary path. Autopilot off ("I'll
 * do it myself"): the hands-on composer and campaign list.
 */
export default function CreatorPage() {
  const { workspace } = useWorkspace();
  const autopilotOn = workspace?.settings.autopilot?.enabled ?? true;
  return autopilotOn ? <HomePage /> : <ManualCreator />;
}

function HomePage() {
  const { app, appId, workspaceId } = useCurrentApp();
  const { can } = useWorkspace();
  return (
    <PageContainer>
      <div className="mx-auto max-w-4xl space-y-8 pb-14 pt-2 md:pt-6">
        <header className="flex items-center gap-3">
          <AppIcon app={app} workspaceId={workspaceId} size={40} />
          <div className="min-w-0">
            <h1 className="truncate text-title-2 font-semibold">{app?.name && app.name !== "New app" ? app.name : "Your app"}</h1>
            <p className="text-footnote text-ink-2">
              Autopilot is on: MuseLaunch does the work, you approve what goes out.{" "}
              <Link href={routes.settings.workspace(workspaceId)} className="font-medium text-accent hover:underline">
                Settings
              </Link>
            </p>
          </div>
        </header>
        <AutopilotHome appId={appId} />
        <WalkthroughPrompt workspaceId={workspaceId} appId={appId} variant="card" canWrite={can("content.write")} />
      </div>
    </PageContainer>
  );
}

function ManualCreator() {
  const { app, appId, workspaceId } = useCurrentApp();
  const { can } = useWorkspace();
  const r = routes.app(workspaceId, appId);
  const campaigns = useApiQuery<Page<Campaign>>(wsPath(workspaceId, `/apps/${appId}/campaigns`), {
    refetchInterval: (q) => (q.state.data?.items.some((c) => c.status === "planning" || c.status === "producing") ? 5000 : false),
  });
  const appName = app?.name ?? "your app";
  const dnaReady = app?.dnaStatus === "confirmed";

  return (
    <PageContainer>
      <div className="mx-auto max-w-3xl pb-14 pt-2 md:pt-8">
        <h1 className="mb-6 text-center text-title-1 font-semibold text-balance md:text-display">What should we make for {appName}?</h1>
        {can("content.write") ? (
          <Composer appName={appName} href={(t) => (t ? `${r.newCampaign}?request=${encodeURIComponent(t)}` : r.newCampaign)} />
        ) : (
          <Notice>You have view access in this workspace. Ask an owner or admin for editor access to create campaigns.</Notice>
        )}
      </div>

      <AutopilotCard workspaceId={workspaceId} appId={appId} />

      {!dnaReady ? (
        <Notice
          tone={app?.dnaStatus === "failed" ? "danger" : "info"}
          icon={<Dna aria-hidden />}
          className="mb-10"
          title={
            app?.dnaStatus === "needs_review"
              ? "Your App DNA is ready to review"
              : app?.dnaStatus === "drafting" || app?.status === "importing"
                ? "Muse is analysing your app"
                : app?.dnaStatus === "failed"
                  ? "App analysis didn’t finish"
                  : "Set up your App DNA"
          }
          action={
            <Button size="sm" variant="secondary" asChild>
              <Link href={r.brand}>{app?.dnaStatus === "needs_review" ? "Review" : "Open"}</Link>
            </Button>
          }
        >
          Campaigns only use product claims you’ve verified. Confirm your features, audiences and claims first for the best results.
        </Notice>
      ) : null}

      <WalkthroughPrompt workspaceId={workspaceId} appId={appId} variant="card" canWrite={can("content.write")} className="mb-10" />

      <Section
        title="Campaigns"
        actions={
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" asChild>
              <Link href={r.autopilot}>
                <Rocket className="size-3.5" aria-hidden />
                Growth Autopilot
              </Link>
            </Button>
            {can("content.write") ? (
              <Button variant="secondary" size="sm" asChild>
                <Link href={r.newCampaign}>
                  <Plus className="size-3.5" aria-hidden />
                  New campaign
                </Link>
              </Button>
            ) : null}
          </div>
        }
      >
        <QueryState
          query={campaigns}
          feature="Campaigns"
          skeleton={
            <div className="space-y-px overflow-hidden rounded-xl shadow-raised">
              {[0, 1, 2].map((i) => (
                <div key={i} className="flex items-center gap-3 bg-surface px-4 py-3">
                  <Skeleton className="size-10" rounded="lg" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-3.5 w-1/3" />
                    <Skeleton className="h-3 w-1/2" />
                  </div>
                </div>
              ))}
            </div>
          }
        >
          {(data) =>
            data.items.length ? (
              <CampaignRows items={data.items} wid={workspaceId} appId={appId} />
            ) : (
              <div className="rounded-2xl bg-mist/60">
                <EmptyState
                  icon={<Clapperboard aria-hidden />}
                  title="No campaigns yet"
                  description="Describe what you want above. Muse researches the market, proposes distinct concepts, then writes, storyboards and renders the ones you choose."
                />
              </div>
            )
          }
        </QueryState>
      </Section>

      <Section title="Recent AI activity" description="What Muse Wonder and Muse Spark did for this app: plans, sources, tool calls and cost for each run." className="mt-14">
        <AgentRunsList workspaceId={workspaceId} appId={appId} limit={5} />
      </Section>
    </PageContainer>
  );
}
