"use client";
/**
 * Owner: module E (Growth & distribution). The Discover tab body (tracked accounts story row,
 * personalised feed with sources, opportunities, creator CRM). Rendered by
 * .../a/[appId]/discover/page.tsx inside <PageContainer width="wide">.
 */
import type { Channel, Job, SourceRef } from "@muselaunch/contracts";
import { Badge, Button, Card, EmptyState, JobProgress, Notice, SegmentedControl, Select, Skeleton, SourceChip, StoryRingRow, Tabs, TabsContent, TabsList, TabsTrigger, formatShortDate, useToast } from "@muselaunch/ui";
import { Bookmark, Compass, FlaskConical, Megaphone, RefreshCw, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { QueryState } from "@/components/states";
import { api, errorMessage, wsPath } from "@/lib/api";
import { useJob } from "@/lib/jobs";
import { CHANNEL_LABEL } from "@/lib/labels";
import { useApiQuery, useInvalidate } from "@/lib/query";
import { routes } from "@/lib/routes";
import { useWorkspace } from "@/lib/workspace";
import { ProspectsPanel } from "./prospects";
import { AddTrackerDialog, TrackerSheet, type StoryRowItem } from "./trackers";

export interface DiscoverRootProps {
  appId: string;
}

type FeedItem = {
  id: string;
  type: "opportunity" | "finding" | "tracker_update";
  refId: string;
  title: string;
  summary: string;
  interpretation?: string;
  proposedAngle?: string;
  audience?: string;
  channels: Channel[];
  contentType?: string;
  effort?: "low" | "medium" | "high";
  geography: string[];
  tags: string[];
  sources: SourceRef[];
  retrievedAt: string;
  observedAt: string;
  confidence: number;
  score: number;
  freshness: number;
  rank: number;
  status?: "new" | "saved" | "dismissed" | "used";
  campaignId?: string;
  trackerId?: string;
  provenance: "research" | "tracked_account";
};
type FeedResponse = { items: FeedItem[]; nextCursor: string | null; excluded: { unsourced: number; duplicates: number; filtered: number }; generatedAt: string };

const TYPE_LABEL: Record<FeedItem["type"], string> = { opportunity: "Opportunity", finding: "Research finding", tracker_update: "Tracked account" };
const CONTENT_LABEL: Record<string, string> = { short_video: "Short video", carousel: "Carousel", static: "Static", thread: "Thread", long_video: "Long video", community_post: "Community post", creator_collab: "Creator collab", launch: "Launch" };

function freshnessLabel(observedAt: string) {
  const days = Math.floor((Date.now() - Date.parse(observedAt)) / 86_400_000);
  return days <= 0 ? "Today" : days === 1 ? "Yesterday" : days < 14 ? `${days} days old` : days < 60 ? `${Math.round(days / 7)} weeks old` : `${Math.round(days / 30)} months old`;
}

export default function DiscoverRoot({ appId }: DiscoverRootProps) {
  const { workspaceId, app } = useWorkspace();
  const toast = useToast();
  const invalidate = useInvalidate();
  const [adding, setAdding] = useState(false);
  const [openTracker, setOpenTracker] = useState<string | null>(null);
  const [refreshJob, setRefreshJob] = useState<Job | null>(null);
  const stories = useApiQuery<{ items: StoryRowItem[] }>(wsPath(workspaceId, `/apps/${appId}/trackers/stories`));
  const live = useJob(workspaceId, refreshJob?.id, { initial: refreshJob, onSettled: () => void invalidate(wsPath(workspaceId, `/apps/${appId}`), wsPath(workspaceId, "/trackers")) });

  const refresh = async (ids: string[] = []) => {
    try {
      const r = await api.post<{ job: Job }>(wsPath(workspaceId, `/apps/${appId}/trackers/refresh`), { trackedCreatorIds: ids }, { idempotent: true });
      setRefreshJob(r.job);
    } catch (e) {
      toast.error("Couldn’t check tracked accounts", errorMessage(e));
    }
  };

  return (
    <div className="space-y-8">
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-headline font-semibold">Tracked accounts</h2>
          <Button size="sm" variant="ghost" icon={<RefreshCw aria-hidden />} onClick={() => refresh()} disabled={!stories.data?.items.length || live.connection === "live" || live.connection === "polling"}>
            Check tracked accounts
          </Button>
        </div>
        {stories.isLoading ? (
          <div className="flex gap-4">
            {Array.from({ length: 5 }, (_, i) => (
              <Skeleton key={i} className="size-16" rounded="full" />
            ))}
          </div>
        ) : (
          <StoryRingRow
            onAdd={() => setAdding(true)}
            addLabel="Track"
            items={(stories.data?.items ?? []).map((s) => ({ id: s.id, label: s.displayName, sublabel: `${CHANNEL_LABEL[s.channel]} · ${s.kind}`, ring: s.hasRecent ? "new" : s.observationCount ? "seen" : "none", onClick: () => setOpenTracker(s.id) }))}
          />
        )}
        {refreshJob ? <JobProgress job={live.job} title="Checking tracked accounts" variant="row" onCancel={() => void live.cancel()} /> : null}
      </div>

      <Tabs defaultValue="feed">
        <TabsList label="Discover sections">
          <TabsTrigger value="feed">For {app?.name ?? "your app"}</TabsTrigger>
          <TabsTrigger value="creators">Creators</TabsTrigger>
        </TabsList>
        <TabsContent value="feed" className="pt-6">
          <Feed appId={appId} />
        </TabsContent>
        <TabsContent value="creators" className="pt-6">
          <ProspectsPanel appId={appId} />
        </TabsContent>
      </Tabs>

      <AddTrackerDialog appId={appId} open={adding} onOpenChange={setAdding} />
      <TrackerSheet trackerId={openTracker} onOpenChange={(o) => (o ? null : setOpenTracker(null))} onRefresh={(ids) => void refresh(ids)} />
    </div>
  );
}

function Feed({ appId }: { appId: string }) {
  const { workspaceId } = useWorkspace();
  const [types, setTypes] = useState<"all" | FeedItem["type"]>("all");
  const [channel, setChannel] = useState("");
  const [effort, setEffort] = useState("");
  const [contentType, setContentType] = useState("");
  const [maxAgeDays, setMaxAgeDays] = useState("");
  const [savedOnly, setSavedOnly] = useState(false);
  const query = { types: types === "all" ? undefined : types, channel: channel || undefined, effort: effort || undefined, contentType: contentType || undefined, maxAgeDays: maxAgeDays || undefined, savedOnly: savedOnly || undefined, limit: 50 };
  const q = useApiQuery<FeedResponse>(wsPath(workspaceId, `/apps/${appId}/discover/feed`), { query });
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <SegmentedControl<"all" | FeedItem["type"]>
          size="sm"
          label="Type"
          value={types}
          onChange={setTypes}
          items={[
            { value: "all", label: "All" },
            { value: "opportunity", label: "Opportunities" },
            { value: "finding", label: "Findings" },
            { value: "tracker_update", label: "Tracked" },
          ]}
        />
        <Select aria-label="Channel" selectSize="sm" value={channel} onChange={(e) => setChannel(e.target.value)} options={[{ value: "", label: "Any channel" }, ...(["tiktok", "instagram", "youtube", "x", "linkedin", "reddit", "producthunt", "threads"] as Channel[]).map((c) => ({ value: c, label: CHANNEL_LABEL[c] }))]} />
        <Select aria-label="Format" selectSize="sm" value={contentType} onChange={(e) => setContentType(e.target.value)} options={[{ value: "", label: "Any format" }, ...Object.entries(CONTENT_LABEL).map(([value, label]) => ({ value, label }))]} />
        <Select aria-label="Effort" selectSize="sm" value={effort} onChange={(e) => setEffort(e.target.value)} options={[{ value: "", label: "Any effort" }, { value: "low", label: "Low effort" }, { value: "medium", label: "Medium effort" }, { value: "high", label: "High effort" }]} />
        <Select aria-label="Trend age" selectSize="sm" value={maxAgeDays} onChange={(e) => setMaxAgeDays(e.target.value)} options={[{ value: "", label: "Any age" }, { value: "7", label: "Last 7 days" }, { value: "30", label: "Last 30 days" }, { value: "90", label: "Last 90 days" }]} />
        <Button size="sm" variant={savedOnly ? "secondary" : "ghost"} icon={<Bookmark aria-hidden />} onClick={() => setSavedOnly((v) => !v)} aria-pressed={savedOnly}>
          Saved
        </Button>
      </div>
      <QueryState query={q} feature="Discover feed" skeleton={<FeedSkeleton />}>
        {(feed) =>
          feed.items.length ? (
            <div className="space-y-4">
              {feed.items.map((i) => (
                <FeedCard key={i.id} item={i} appId={appId} />
              ))}
              {feed.excluded.unsourced ? <p className="text-caption text-ink-3">{feed.excluded.unsourced} item(s) without a checkable source are hidden.</p> : null}
            </div>
          ) : (
            <EmptyState
              icon={<Compass aria-hidden />}
              title="Nothing in your feed yet"
              description="Use Research market above, or track competitors and creators. Every card here links to the public sources it’s based on."
            />
          )
        }
      </QueryState>
    </div>
  );
}

function FeedSkeleton() {
  return (
    <div className="space-y-4">
      {Array.from({ length: 3 }, (_, i) => (
        <Skeleton key={i} className="h-40 w-full" rounded="xl" />
      ))}
    </div>
  );
}

function FeedCard({ item, appId }: { item: FeedItem; appId: string }) {
  const { workspaceId, app, can } = useWorkspace();
  const toast = useToast();
  const router = useRouter();
  const invalidate = useInvalidate();
  const [busy, setBusy] = useState<string | null>(null);
  const isOpp = item.type === "opportunity";
  const act = async (name: string, path: string, body: unknown, after?: (r: { campaign?: { id: string } }) => void) => {
    setBusy(name);
    try {
      const r = await api.post<{ campaign?: { id: string } }>(wsPath(workspaceId, `/apps/${appId}/opportunities/${item.refId}/${path}`), body, { idempotent: true });
      after?.(r);
      await invalidate(wsPath(workspaceId, `/apps/${appId}/discover`));
    } catch (e) {
      toast.error("That didn’t work", errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <Card className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={isOpp ? "accent" : "neutral"}>{TYPE_LABEL[item.type]}</Badge>
        {item.contentType ? <Badge tone="outline">{CONTENT_LABEL[item.contentType] ?? item.contentType}</Badge> : null}
        {item.effort ? <Badge tone="outline">{item.effort} effort</Badge> : null}
        {item.channels.slice(0, 3).map((c) => (
          <Badge key={c} tone="neutral">
            {CHANNEL_LABEL[c]}
          </Badge>
        ))}
        <span className="ml-auto text-caption tabular text-ink-3" title={`Score ${item.score} × freshness ${item.freshness}`}>
          {Math.round(item.confidence * 100)}% confidence · {freshnessLabel(item.observedAt)}
        </span>
      </div>
      <div className="space-y-1.5">
        <h3 className="text-headline font-semibold text-balance">{item.title}</h3>
        {item.summary !== item.title ? <p className="text-body-sm text-ink-2 text-pretty">{item.summary}</p> : null}
      </div>
      {item.interpretation || item.proposedAngle ? (
        <div className="space-y-1 rounded-lg bg-mist px-3.5 py-2.5">
          <p className="text-caption font-medium text-ink-3">For {app?.name ?? "your app"} · model interpretation, not a sourced fact</p>
          {item.interpretation ? <p className="text-body-sm text-ink">{item.interpretation}</p> : null}
          {item.proposedAngle ? <p className="text-body-sm text-ink-2">Angle: {item.proposedAngle}</p> : null}
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-1.5">
        {item.sources.slice(0, 4).map((s) => (
          <SourceChip key={s.url ?? `${s.kind}-${s.title}`} source={s} />
        ))}
        {item.sources.length > 4 ? <span className="text-caption text-ink-3">+{item.sources.length - 4} more</span> : null}
        <span className="text-caption text-ink-3">· retrieved {formatShortDate(item.retrievedAt)}</span>
      </div>
      {isOpp ? (
        <div className="flex flex-wrap gap-2">
          {item.status === "used" && item.campaignId ? (
            <Button size="sm" variant="secondary" onClick={() => router.push(routes.app(workspaceId, appId).campaign(item.campaignId!))}>
              Open campaign
            </Button>
          ) : (
            <Button size="sm" icon={<Megaphone aria-hidden />} disabled={!can("content.write")} loading={busy === "campaign"} onClick={() => act("campaign", "campaign", {}, (r) => r.campaign && router.push(routes.app(workspaceId, appId).campaign(r.campaign.id)))}>
              Create campaign
            </Button>
          )}
          <Button size="sm" variant="outline" icon={<FlaskConical aria-hidden />} disabled={!can("content.write")} loading={busy === "investigate"} onClick={() => act("investigate", "investigate", {}, () => toast.success("Research started", "New findings will appear in your feed."))}>
            Investigate
          </Button>
          {item.status !== "saved" && item.status !== "used" ? (
            <Button size="sm" variant="ghost" icon={<Bookmark aria-hidden />} loading={busy === "save"} onClick={() => act("save", "save", {})}>
              Save
            </Button>
          ) : null}
          {item.status !== "used" ? (
            <Button size="sm" variant="ghost" icon={<X aria-hidden />} loading={busy === "dismiss"} onClick={() => act("dismiss", "dismiss", {})}>
              Dismiss
            </Button>
          ) : null}
        </div>
      ) : null}
      {item.type === "tracker_update" && !item.sources.length ? <Notice tone="warning">Unsourced</Notice> : null}
    </Card>
  );
}
