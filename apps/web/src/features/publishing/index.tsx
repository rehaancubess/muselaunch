"use client";
/**
 * Owner: module E. Marketing calendar, approvals and authorised publishing / export packages.
 * Rendered by .../a/[appId]/calendar/page.tsx inside <PageContainer width="wide">.
 */
import type { Approval } from "@muselaunch/contracts";
import { Badge, Button, EmptyState, IconButton, List, ListRow, Notice, Section, SegmentedControl, Sheet, Skeleton, StatusPill, useToast } from "@muselaunch/ui";
import { BellRing, CalendarDays, ChevronLeft, ChevronRight, Link2, Plus } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { QueryState } from "@/components/states";
import { wsPath } from "@/lib/api";
import type { Page } from "@/lib/api-types";
import { CHANNEL_LABEL } from "@/lib/labels";
import { useApiQuery, useInvalidate } from "@/lib/query";
import { useWorkspace } from "@/lib/workspace";
import { ApprovalCard } from "./approval-card";
import { ConnectionsPanel } from "./connections";
import { NewPostDialog } from "./new-post";
import { POST_STATUS_KIND, PostSheet } from "./post-sheet";
import type { CalendarItem, CalendarResponse } from "./types";

export { ApprovalCard } from "./approval-card";
export { ConnectionsPanel } from "./connections";

export interface CalendarRootProps {
  appId: string;
}

const DAY = 86_400_000;
type Filter = "all" | "attention" | "scheduled" | "posted";

const matches = (f: Filter, i: CalendarItem) =>
  f === "all" ||
  (f === "attention" && ["draft", "awaiting_approval", "manual_post_needed", "failed"].includes(i.status)) ||
  (f === "scheduled" && ["scheduled", "publishing"].includes(i.status)) ||
  (f === "posted" && ["published", "manually_posted"].includes(i.status));

export default function CalendarRoot({ appId }: CalendarRootProps) {
  const { workspaceId } = useWorkspace();
  const router = useRouter();
  const search = useSearchParams();
  const toast = useToast();
  const invalidate = useInvalidate();
  const tz = typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : "UTC";
  const [anchor, setAnchor] = useState(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime() - 7 * DAY;
  });
  const [filter, setFilter] = useState<Filter>("all");
  const [openPost, setOpenPost] = useState<string | null>(null);
  const [newPost, setNewPost] = useState(false);
  const [connections, setConnections] = useState(false);
  const calPath = wsPath(workspaceId, `/apps/${appId}/calendar`);
  const cal = useApiQuery<CalendarResponse>(calPath, { query: { from: new Date(anchor).toISOString(), to: new Date(anchor + 42 * DAY).toISOString(), timezone: tz } });
  const approvals = useApiQuery<Page<Approval>>(wsPath(workspaceId, "/approvals"), { query: { appId } });
  const pending = (approvals.data?.items ?? []).filter((a) => a.status === "pending" && a.subject.entity === "scheduledPosts");

  // Returning from an OAuth connection.
  useEffect(() => {
    if (search.get("connections") !== "1") return;
    setConnections(true);
    const status = search.get("status");
    if (status === "connected") toast.success("Account connected", search.get("provider") ?? undefined);
    else if (status) toast.error("Connection didn’t complete", search.get("message") ?? undefined);
    router.replace(window.location.pathname);
  }, [search]); // eslint-disable-line react-hooks/exhaustive-deps

  const refresh = () => invalidate(calPath, wsPath(workspaceId, "/approvals"));
  const label = useMemo(() => `${new Date(anchor).toLocaleDateString(undefined, { month: "short", day: "numeric" })} – ${new Date(anchor + 41 * DAY).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`, [anchor]);

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SegmentedControl<Filter>
          label="Filter posts"
          value={filter}
          onChange={setFilter}
          items={[
            { value: "all", label: "All" },
            { value: "attention", label: "Needs action" },
            { value: "scheduled", label: "Scheduled" },
            { value: "posted", label: "Posted" },
          ]}
        />
        <div className="flex items-center gap-2">
          <Button variant="outline" icon={<Link2 aria-hidden />} onClick={() => setConnections(true)}>
            Connections
          </Button>
          <Button icon={<Plus aria-hidden />} onClick={() => setNewPost(true)}>
            New post
          </Button>
        </div>
      </div>

      {pending.length ? (
        <Section title="Waiting for approval" description="Nothing is published or prepared for posting until this exact version is approved.">
          <div className="grid gap-3 lg:grid-cols-2">
            {pending.map((a) => (
              <div key={a.id} className="space-y-2">
                <ApprovalCard approval={a} compact onDecided={() => void refresh()} />
                <Button size="sm" variant="link" onClick={() => setOpenPost(a.subject.id)}>
                  Review post
                </Button>
              </div>
            ))}
          </div>
        </Section>
      ) : null}

      <QueryState query={cal} feature="Calendar" skeleton={<Skeleton className="h-72 w-full" rounded="xl" />}>
        {(data) => {
          const days = Object.entries(data.days)
            .map(([day, items]) => [day, items.filter((i) => matches(filter, i))] as const)
            .filter(([, items]) => items.length);
          const unscheduled = data.unscheduled.filter((i) => matches(filter, i));
          const due = data.reminders.filter((r) => r.due);
          return (
            <div className="space-y-8">
              {due.length ? (
                <Notice tone="warning" icon={<BellRing aria-hidden />} title={`${due.length} manual post${due.length > 1 ? "s" : ""} due`}>
                  <div className="flex flex-wrap gap-2 pt-1">
                    {due.map((r) => (
                      <Button key={r.postId} size="sm" variant="secondary" onClick={() => setOpenPost(r.postId)}>
                        {CHANNEL_LABEL[r.channel]} · {new Date(r.at).toLocaleString()}
                      </Button>
                    ))}
                  </div>
                </Notice>
              ) : null}

              <Section
                title={label}
                description={`Times shown in ${data.timezone}.`}
                actions={
                  <>
                    <IconButton label="Earlier" onClick={() => setAnchor((a) => a - 28 * DAY)}>
                      <ChevronLeft aria-hidden />
                    </IconButton>
                    <IconButton label="Later" onClick={() => setAnchor((a) => a + 28 * DAY)}>
                      <ChevronRight aria-hidden />
                    </IconButton>
                  </>
                }
              >
                {days.length ? (
                  <div className="space-y-5">
                    {days.map(([day, items]) => (
                      <div key={day} className="space-y-2">
                        <h3 className="text-footnote font-semibold text-ink-2">{new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}</h3>
                        <List label={day}>
                          {items.map((i) => (
                            <PostRow key={i.id} item={i} onOpen={() => setOpenPost(i.id)} />
                          ))}
                        </List>
                      </div>
                    ))}
                  </div>
                ) : (
                  <EmptyState
                    icon={<CalendarDays aria-hidden />}
                    title="Nothing on the calendar in this range"
                    description="Create a post from a rendered video. It stays a draft until it’s approved, then publishes via a connected account or gives you a posting checklist."
                    action={
                      <Button icon={<Plus aria-hidden />} onClick={() => setNewPost(true)}>
                        New post
                      </Button>
                    }
                  />
                )}
              </Section>

              {unscheduled.length ? (
                <Section title="Not scheduled yet">
                  <List label="Unscheduled posts">
                    {unscheduled.map((i) => (
                      <PostRow key={i.id} item={i} onOpen={() => setOpenPost(i.id)} />
                    ))}
                  </List>
                </Section>
              ) : null}
            </div>
          );
        }}
      </QueryState>

      <PostSheet postId={openPost} onOpenChange={(o) => (o ? null : (setOpenPost(null), void refresh()))} />
      <NewPostDialog appId={appId} open={newPost} onOpenChange={setNewPost} onCreated={(id) => (void refresh(), setOpenPost(id))} />
      <Sheet open={connections} onOpenChange={setConnections} title="Connections" description="Accounts MuseLaunch may publish to or send from, after your approval." width="max-w-xl">
        <div className="p-5">
          <ConnectionsPanel appId={appId} />
        </div>
      </Sheet>
    </div>
  );
}

function PostRow({ item, onOpen }: { item: CalendarItem; onOpen: () => void }) {
  const at = item.at ? new Date(item.at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : null;
  return (
    <ListRow
      onClick={onOpen}
      leading={<span className="inline-flex w-14 justify-end text-footnote tabular text-ink-2">{at ?? "—"}</span>}
      title={item.title ?? "Untitled post"}
      subtitle={`${CHANNEL_LABEL[item.channel]} · ${item.mode === "api" ? "via API" : "manual"}${item.lastError && item.status === "failed" ? ` · ${item.lastError}` : ""}`}
      trailing={
        <>
          {item.publication?.mode === "manual_confirmed" ? <Badge tone="outline">Confirmed by you</Badge> : null}
          <StatusPill status={POST_STATUS_KIND(item.status)}>{item.statusLabel.split(" · ")[0]!.replace(/ \(.*\)$/, "")}</StatusPill>
        </>
      }
    />
  );
}
