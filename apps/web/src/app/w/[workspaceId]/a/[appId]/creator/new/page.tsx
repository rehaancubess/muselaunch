"use client";
import type { AspectRatio, CampaignGoal, Channel, Deliverable, DeliverableKind } from "@muselaunch/contracts";
import { Button, ChoiceChips, Field, IconButton, Input, Notice, PageHeader, PipelineSteps, SegmentedControl, Select, Textarea, useToast } from "@muselaunch/ui";
import { ArrowLeft, Minus, Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useRef, useState } from "react";
import { PageContainer } from "@/components/page-container";
import { api, errorMessage, isRouteMissing, newIdempotencyKey, wsPath } from "@/lib/api";
import type { CreateCampaignResponse } from "@/lib/api-types";
import { WorkspaceCostEstimate } from "@/lib/estimate";
import { CHANNEL_LABEL, DELIVERABLE_LABEL, GOAL_LABEL } from "@/lib/labels";
import { useInvalidate } from "@/lib/query";
import { routes } from "@/lib/routes";
import { useCurrentApp, useWorkspace } from "@/lib/workspace";

const GOALS: CampaignGoal[] = ["awareness", "launch", "installs", "subscriptions", "feature_announcement", "engagement", "community"];
const CHANNELS: Channel[] = ["instagram", "tiktok", "youtube", "x", "linkedin", "threads", "reddit", "producthunt", "app_store"];
const KINDS: DeliverableKind[] = ["short_video", "app_demo", "feature_promo", "launch_announcement", "app_trailer", "screenshot_graphic", "carousel", "static_ad", "thumbnail", "product_hunt_assets", "caption_pack", "outreach_pack"];
const ASPECTS: AspectRatio[] = ["9:16", "1:1", "4:5", "16:9"];
const VIDEO_KINDS = new Set<DeliverableKind>(["short_video", "app_demo", "feature_promo", "launch_announcement", "app_trailer"]);

type Row = { kind: DeliverableKind; aspectRatio: AspectRatio; count: number; durationSec?: number };

function DeliverableEditor({ rows, onChange }: { rows: Row[]; onChange: (r: Row[]) => void }) {
  const set = (i: number, patch: Partial<Row>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="space-y-2">
      <ul className="divide-y divide-line overflow-hidden rounded-xl bg-surface shadow-raised">
        {rows.map((r, i) => (
          <li key={i} className="flex flex-wrap items-center gap-2 px-3 py-2.5 sm:flex-nowrap">
            <div className="min-w-40 flex-1">
              <Select aria-label="Deliverable type" selectSize="sm" value={r.kind} onChange={(e) => set(i, { kind: e.target.value as DeliverableKind, durationSec: VIDEO_KINDS.has(e.target.value as DeliverableKind) ? r.durationSec : undefined })} options={KINDS.map((k) => ({ value: k, label: DELIVERABLE_LABEL[k] }))} />
            </div>
            <div className="w-24">
              <Select aria-label="Aspect ratio" selectSize="sm" value={r.aspectRatio} onChange={(e) => set(i, { aspectRatio: e.target.value as AspectRatio })} options={ASPECTS.map((a) => ({ value: a, label: a }))} />
            </div>
            {VIDEO_KINDS.has(r.kind) ? (
              <div className="w-28">
                {/* Auto: each concept gets its own length (30–60 s); a fixed length applies to every concept. */}
                <Select aria-label="Length" selectSize="sm" value={r.durationSec ? String(r.durationSec) : "auto"} onChange={(e) => set(i, { durationSec: e.target.value === "auto" ? undefined : Number(e.target.value) })} options={[{ value: "auto", label: "30–60s" }, ...[6, 10, 15, 20, 30, 45, 60].map((s) => ({ value: String(s), label: `${s}s` }))]} />
              </div>
            ) : null}
            <div className="flex items-center gap-1 rounded-full bg-mist px-1" role="group" aria-label="Quantity">
              <IconButton label="Fewer" size="sm" disabled={r.count <= 1} onClick={() => set(i, { count: r.count - 1 })}>
                <Minus className="size-3.5" aria-hidden />
              </IconButton>
              <span className="w-5 text-center text-footnote font-medium tabular" aria-live="polite">
                {r.count}
              </span>
              <IconButton label="More" size="sm" disabled={r.count >= 10} onClick={() => set(i, { count: r.count + 1 })}>
                <Plus className="size-3.5" aria-hidden />
              </IconButton>
            </div>
            <IconButton label="Remove deliverable" size="sm" onClick={() => onChange(rows.filter((_, j) => j !== i))} disabled={rows.length <= 1}>
              <Trash2 className="size-3.5" aria-hidden />
            </IconButton>
          </li>
        ))}
      </ul>
      {rows.length < 12 ? (
        <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" aria-hidden />} onClick={() => onChange([...rows, { kind: "static_ad", aspectRatio: "4:5", count: 1 }])}>
          Add deliverable
        </Button>
      ) : null}
    </div>
  );
}

function NewCampaignInner() {
  const params = useSearchParams();
  const router = useRouter();
  const toast = useToast();
  const invalidate = useInvalidate();
  const { app, appId, workspaceId } = useCurrentApp();
  const { can, credits } = useWorkspace();
  const [request, setRequest] = useState(params.get("request") ?? "");
  const [goal, setGoal] = useState<CampaignGoal>("awareness");
  const [channels, setChannels] = useState<Channel[]>(["instagram", "tiktok"]);
  const [rows, setRows] = useState<Row[]>([{ kind: "short_video", aspectRatio: "9:16", count: 3 }]);
  const [conceptCount, setConceptCount] = useState<"3" | "4" | "5" | "6">("3");
  const [cap, setCap] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [short, setShort] = useState(false);
  const idem = useRef(newIdempotencyKey("campaign"));
  const r = routes.app(workspaceId, appId);
  const opportunityIds = params.getAll("opportunity").slice(0, 10);

  const submit = async () => {
    if (request.trim().length < 8) return setError("Describe what you want in a sentence or two.");
    if (!channels.length) return setError("Pick at least one channel.");
    setError(null);
    setBusy(true);
    try {
      const deliverables: Deliverable[] = rows.map((x) => ({ kind: x.kind, aspectRatio: x.aspectRatio, count: x.count, durationSec: x.durationSec }));
      const res = await api.post<CreateCampaignResponse>(
        wsPath(workspaceId, `/apps/${appId}/campaigns`),
        { request: request.trim(), goal, channels, deliverables, opportunityIds, conceptCount: Number(conceptCount), creditCap: cap ? Number(cap) : undefined },
        { idempotencyKey: idem.current },
      );
      await invalidate(wsPath(workspaceId, `/apps/${appId}/campaigns`));
      router.push(r.campaign(res.campaign.id));
    } catch (e) {
      if (isRouteMissing(e)) setUnavailable(true);
      else toast.error("Couldn’t start the campaign", errorMessage(e));
      idem.current = newIdempotencyKey("campaign");
    } finally {
      setBusy(false);
    }
  };

  return (
    <PageContainer width="wide">
      <Link href={r.creator} className="mb-6 inline-flex items-center gap-1.5 text-footnote font-medium text-ink-2 hover:text-ink">
        <ArrowLeft className="size-3.5" aria-hidden /> Creator
      </Link>
      <PageHeader title="New campaign" description={`Tell Muse what you want for ${app?.name ?? "your app"}. It researches, proposes distinct concepts for you to pick from, then produces the ones you choose.`} />
      <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_340px]">
        <form
          className="min-w-0 space-y-9"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <Field label="What do you want to make?" error={error}>
            {(f) => (
              <Textarea
                id={f.id}
                aria-describedby={f.describedBy}
                invalid={f.invalid}
                rows={4}
                value={request}
                onChange={(e) => setRequest(e.target.value)}
                maxLength={4000}
                autoFocus={!request}
                placeholder="Five promotional Reels introducing the app with a premium, Apple-style look…"
                className="text-body"
              />
            )}
          </Field>
          <fieldset className="space-y-3">
            <legend className="mb-3 text-footnote font-medium">Goal</legend>
            <ChoiceChips label="Goal" value={[goal]} onChange={(v) => v[0] && setGoal(v[0])} options={GOALS.map((g) => ({ value: g, label: GOAL_LABEL[g] }))} />
          </fieldset>
          <fieldset className="space-y-3">
            <legend className="mb-3 text-footnote font-medium">Channels</legend>
            <ChoiceChips label="Channels" multiple value={channels} onChange={(v) => setChannels(v.slice(0, 8))} options={CHANNELS.map((c) => ({ value: c, label: CHANNEL_LABEL[c] }))} />
          </fieldset>
          <fieldset>
            <legend className="mb-3 text-footnote font-medium">Deliverables</legend>
            <DeliverableEditor rows={rows} onChange={setRows} />
          </fieldset>
          <div className="grid gap-6 sm:grid-cols-2">
            <fieldset>
              <legend className="mb-3 text-footnote font-medium">Concepts to compare</legend>
              <SegmentedControl<"3" | "4" | "5" | "6">
                label="Number of concepts"
                value={conceptCount}
                onChange={setConceptCount}
                items={(["3", "4", "5", "6"] as const).map((n) => ({ value: n, label: n }))}
              />
            </fieldset>
            <Field label="Credit limit" optional hint="Muse stops and asks before going over.">
              {(f) => <Input id={f.id} aria-describedby={f.describedBy} type="number" min={1} inputMode="numeric" value={cap} onChange={(e) => setCap(e.target.value)} placeholder={credits ? `Up to ${credits.available}` : "No limit"} />}
            </Field>
          </div>
          {opportunityIds.length ? <Notice tone="info">Building on {opportunityIds.length} opportunit{opportunityIds.length === 1 ? "y" : "ies"} from Discover.</Notice> : null}
        </form>

        <aside>
          <div className="space-y-6 rounded-xl bg-surface p-5 shadow-raised lg:sticky lg:top-20">
            <div className="space-y-1">
              <p className="text-body-sm font-semibold">What happens next</p>
              <p className="text-footnote text-ink-2">You review concepts before any video is produced.</p>
            </div>
            <PipelineSteps orientation="vertical" states={{}} details={{ research: "With cited sources", concept: `${conceptCount} distinct angles`, review: "Nothing posts without you" }} />
            <div className="space-y-4 border-t border-line pt-5">
              <WorkspaceCostEstimate operation="campaign.generate_concepts" params={{ count: Number(conceptCount) }} onEstimate={(e) => setShort(Boolean(e && e.credits > e.available))} note="Producing the concepts you pick is estimated separately." />
              {unavailable ? <Notice tone="warning">Campaign generation isn’t deployed in this build yet, so nothing was started.</Notice> : null}
              <Button size="lg" className="w-full" loading={busy} disabled={!can("content.write") || short} onClick={() => void submit()}>
                Generate concepts
              </Button>
              {!can("content.write") ? <p className="text-footnote text-ink-2">You need editor access to create campaigns.</p> : null}
            </div>
          </div>
        </aside>
      </div>
    </PageContainer>
  );
}

export default function NewCampaignPage() {
  return (
    <Suspense>
      <NewCampaignInner />
    </Suspense>
  );
}
