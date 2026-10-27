"use client";
import type { Channel, SourceRef, TrackedCreator } from "@muselaunch/contracts";
import { Badge, Button, Dialog, Field, Input, Notice, Section, Select, Sheet, Skeleton, SourceChip, Textarea, useToast } from "@muselaunch/ui";
import { RefreshCw, Trash2 } from "lucide-react";
import { useState } from "react";
import { QueryState } from "@/components/states";
import { api, errorMessage, wsPath } from "@/lib/api";
import { CHANNEL_LABEL } from "@/lib/labels";
import { useApiQuery, useInvalidate } from "@/lib/query";
import { useWorkspace } from "@/lib/workspace";

export type StoryRowItem = {
  id: string;
  kind: TrackedCreator["kind"];
  channel: Channel;
  handle: string;
  displayName: string;
  url?: string;
  lastObservedAt?: string;
  observationCount: number;
  hasRecent: boolean;
  lastRefreshError?: string;
  latest?: { text: string; kind?: string; source: SourceRef; observedAt?: string };
};

type Obs = { text: string; sources: SourceRef[]; observedAt?: string; confidence?: number; origin: "tracker" | "research" };
export type CompetitorProfile = {
  name: string;
  trackers: { id: string; channel: Channel; handle: string; url?: string; lastObservedAt?: string; lastRefreshError?: string }[];
  positioning: Obs[];
  hooks: Obs[];
  formats: Obs[];
  other: Obs[];
  comparison: { topic: string; them: string; themSources: SourceRef[]; us: string; usClaims: { id: string; text: string }[] }[];
  researchComparison: { topic: string; them: string; themSources: SourceRef[]; us: string; usVerified: boolean }[];
  ourVerifiedClaims: { id: string; text: string }[];
  lastObservedAt?: string;
  notes: string[];
};

const TRACK_CHANNELS: Channel[] = ["instagram", "tiktok", "youtube", "x", "linkedin", "threads", "reddit", "facebook", "producthunt", "website", "other"];
const KIND_LABEL: Record<TrackedCreator["kind"], string> = { competitor: "Competitor", creator: "Creator", inspiration: "Inspiration", community: "Community" };

export function AddTrackerDialog({ appId, open, onOpenChange }: { appId: string; open: boolean; onOpenChange: (o: boolean) => void }) {
  const { workspaceId } = useWorkspace();
  const toast = useToast();
  const invalidate = useInvalidate();
  const [channel, setChannel] = useState<Channel>("youtube");
  const [kind, setKind] = useState<TrackedCreator["kind"]>("competitor");
  const [handle, setHandle] = useState("");
  const [url, setUrl] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    try {
      await api.post(wsPath(workspaceId, `/apps/${appId}/trackers`), { channel, kind, handle, url: url || undefined, notes });
      toast.success("Now tracking", `${handle} on ${CHANNEL_LABEL[channel]}. Use “Check tracked accounts” to gather sourced observations.`);
      await invalidate(wsPath(workspaceId, `/apps/${appId}/trackers`));
      setHandle("");
      setUrl("");
      setNotes("");
      onOpenChange(false);
    } catch (e) {
      toast.error("Couldn’t add the account", errorMessage(e));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Track an account"
      description="MuseLaunch observes public pages only (no logins, no copying creators’ videos). Every observation links to its source."
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save} loading={saving} disabled={!handle.trim()}>
            Track
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Type">
            {({ id }) => <Select id={id} value={kind} onChange={(e) => setKind(e.target.value as TrackedCreator["kind"])} options={Object.entries(KIND_LABEL).map(([value, label]) => ({ value, label }))} />}
          </Field>
          <Field label="Channel">
            {({ id }) => <Select id={id} value={channel} onChange={(e) => setChannel(e.target.value as Channel)} options={TRACK_CHANNELS.map((c) => ({ value: c, label: CHANNEL_LABEL[c] }))} />}
          </Field>
        </div>
        <Field label="Handle or name">{({ id }) => <Input id={id} placeholder="@account" value={handle} onChange={(e) => setHandle(e.target.value)} />}</Field>
        <Field label="Public profile URL" optional hint="Helps find the right account.">
          {({ id }) => <Input id={id} placeholder="https://" value={url} onChange={(e) => setUrl(e.target.value)} />}
        </Field>
        <Field label="Notes" optional>
          {({ id }) => <Textarea id={id} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />}
        </Field>
      </div>
    </Dialog>
  );
}

function ObsList({ title, items, empty }: { title: string; items: Obs[]; empty: string }) {
  return (
    <Section title={title}>
      {items.length ? (
        <ul className="space-y-3">
          {items.map((o, i) => (
            <li key={`${o.text}-${i}`} className="space-y-1.5">
              <p className="text-body-sm text-ink">{o.text}</p>
              <div className="flex flex-wrap items-center gap-1.5">
                {o.sources.slice(0, 3).map((s) => (
                  <SourceChip key={s.url ?? s.title} source={s} compact />
                ))}
                {o.confidence !== undefined ? <Badge tone="outline">{Math.round(o.confidence * 100)}% confidence</Badge> : null}
                {o.origin === "research" ? <Badge tone="neutral">From research</Badge> : null}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-footnote text-ink-3">{empty}</p>
      )}
    </Section>
  );
}

/** Tracked account profile: positioning, hooks, formats (each sourced) and comparison vs verified claims. */
export function TrackerSheet({ trackerId, onOpenChange, onRefresh }: { trackerId: string | null; onOpenChange: (o: boolean) => void; onRefresh: (ids: string[]) => void }) {
  const { workspaceId } = useWorkspace();
  const toast = useToast();
  const invalidate = useInvalidate();
  const q = useApiQuery<{ profile: CompetitorProfile }>(trackerId ? wsPath(workspaceId, `/trackers/${trackerId}/profile`) : null);
  const remove = async () => {
    if (!trackerId) return;
    try {
      await api.del(wsPath(workspaceId, `/trackers/${trackerId}`));
      toast.success("Stopped tracking");
      onOpenChange(false);
      await invalidate(wsPath(workspaceId, "/apps"));
    } catch (e) {
      toast.error("Couldn’t remove", errorMessage(e));
    }
  };
  return (
    <Sheet open={Boolean(trackerId)} onOpenChange={onOpenChange} title={q.data?.profile.name ?? "Tracked account"} description={q.data?.profile.lastObservedAt ? `Last observed ${new Date(q.data.profile.lastObservedAt).toLocaleString()}` : "Not observed yet"} width="max-w-xl">
      <div className="space-y-7 p-5">
        {trackerId ? (
          <QueryState query={q} feature="Profile" skeleton={<Skeleton className="h-64 w-full" rounded="xl" />}>
            {({ profile }) => (
              <>
                <div className="flex flex-wrap gap-2">
                  {profile.trackers.map((t) =>
                    t.url ? (
                      <a key={t.id} href={t.url} target="_blank" rel="noopener noreferrer" className="text-footnote text-accent hover:underline">
                        {CHANNEL_LABEL[t.channel]} · @{t.handle}
                      </a>
                    ) : (
                      <span key={t.id} className="text-footnote text-ink-2">
                        {CHANNEL_LABEL[t.channel]} · @{t.handle}
                      </span>
                    ),
                  )}
                </div>
                {profile.trackers.some((t) => t.lastRefreshError) ? <Notice tone="neutral">{profile.trackers.find((t) => t.lastRefreshError)!.lastRefreshError}</Notice> : null}
                <ObsList title="Positioning" items={profile.positioning} empty="No sourced positioning yet." />
                <ObsList title="Recurring hooks" items={profile.hooks} empty="No sourced hooks yet." />
                <ObsList title="Formats" items={profile.formats} empty="No sourced formats yet." />
                {profile.other.length ? <ObsList title="Other observations" items={profile.other} empty="" /> : null}
                <Section title="Compared with your verified claims">
                  {profile.comparison.length ? (
                    <div className="overflow-hidden rounded-xl border border-line">
                      <table className="w-full text-left text-footnote">
                        <thead className="bg-mist text-ink-2">
                          <tr>
                            <th className="px-3 py-2 font-medium">Topic</th>
                            <th className="px-3 py-2 font-medium">Them (sourced)</th>
                            <th className="px-3 py-2 font-medium">You (verified)</th>
                          </tr>
                        </thead>
                        <tbody className="[&>tr+tr]:border-t [&>tr+tr]:border-line">
                          {profile.comparison.map((r) => (
                            <tr key={r.topic} className="align-top">
                              <td className="px-3 py-2 font-medium">{r.topic}</td>
                              <td className="space-y-1 px-3 py-2">
                                <p>{r.them}</p>
                                {r.themSources.slice(0, 1).map((s) => (
                                  <SourceChip key={s.url} source={s} compact />
                                ))}
                              </td>
                              <td className="px-3 py-2">{r.us}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p className="text-footnote text-ink-3">{profile.ourVerifiedClaims.length ? "No comparable, sourced claims found yet." : "Verify claims in App DNA to compare features."}</p>
                  )}
                  {profile.researchComparison.length ? (
                    <ul className="space-y-1 pt-2 text-footnote text-ink-2">
                      {profile.researchComparison.map((r) => (
                        <li key={r.topic}>
                          {r.topic}: {r.them} vs {r.us} {r.usVerified ? null : <Badge tone="warning">Your side unverified</Badge>}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </Section>
                <ul className="space-y-1 text-caption text-ink-3">
                  {profile.notes.map((n) => (
                    <li key={n}>{n}</li>
                  ))}
                </ul>
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" icon={<RefreshCw aria-hidden />} onClick={() => onRefresh(profile.trackers.map((t) => t.id))}>
                    Check again
                  </Button>
                  <Button variant="ghost" icon={<Trash2 aria-hidden />} onClick={remove}>
                    Stop tracking
                  </Button>
                </div>
              </>
            )}
          </QueryState>
        ) : null}
      </div>
    </Sheet>
  );
}
