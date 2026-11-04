"use client";
import { TEXT_POST_CHANNELS, clampSlides, slideLimits, stillAspect, type AspectRatio, type CampaignGoal, type Channel, type Deliverable, type DeliverableKind, type StoreTarget } from "@muselaunch/contracts";
import { Button, ChoiceChips, Field, IconButton, Input, Notice, PageHeader, SegmentedControl, Select, Textarea, cn, useToast } from "@muselaunch/ui";
import { ArrowLeft, ChevronDown, Minus, Plus, Trash2 } from "lucide-react";
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
const KINDS: DeliverableKind[] = ["short_video", "app_demo", "feature_promo", "launch_announcement", "app_trailer", "screenshot_graphic", "carousel", "static_ad", "thumbnail", "store_screenshots", "text_post", "product_hunt_assets", "caption_pack", "outreach_pack"];
const ASPECTS: AspectRatio[] = ["9:16", "1:1", "4:5", "16:9"];
const VIDEO_KINDS = new Set<DeliverableKind>(["short_video", "app_demo", "feature_promo", "launch_announcement", "app_trailer"]);
/** Kinds whose frame is fixed (thumbnails 16:9; store sets by store) or that have none (text). */
const FIXED_FRAME = new Set<DeliverableKind>(["thumbnail", "store_screenshots", "text_post", "caption_pack", "outreach_pack", "product_hunt_assets"]);

type Row = { kind: DeliverableKind; aspectRatio: AspectRatio; count: number; durationSec?: number; slides?: number; store?: StoreTarget; channel?: Channel };

/** A row with the fields its kind needs (store sets: store + slides in the store's frame; carousels: slides; text posts: where). */
function shapeRow(r: Row): Row {
  if (r.kind === "store_screenshots") {
    const store = r.store ?? "ios";
    return { kind: r.kind, count: r.count, store, slides: clampSlides("store_screenshots", r.slides, store), aspectRatio: stillAspect("store_screenshots", null, store) };
  }
  if (r.kind === "carousel") return { kind: r.kind, count: r.count, slides: clampSlides("carousel", r.slides), aspectRatio: stillAspect("carousel", r.aspectRatio) };
  if (r.kind === "thumbnail") return { kind: r.kind, count: r.count, aspectRatio: "16:9" };
  if (r.kind === "text_post") return { kind: r.kind, count: r.count, aspectRatio: "1:1", channel: TEXT_POST_CHANNELS.includes(r.channel as never) ? r.channel : "x" };
  return { kind: r.kind, count: r.count, aspectRatio: r.aspectRatio, durationSec: r.durationSec };
}

/** Defaults: 3 vertical videos, length chosen per idea, music automatic. Everything else is under "More options". */
const DEFAULT_ROWS: Row[] = [{ kind: "short_video", aspectRatio: "9:16", count: 3 }];

function DeliverableEditor({ rows, onChange }: { rows: Row[]; onChange: (r: Row[]) => void }) {
  const set = (i: number, patch: Partial<Row>) => onChange(rows.map((r, j) => (j === i ? shapeRow({ ...r, ...patch }) : r)));
  return (
    <div className="space-y-2">
      <ul className="divide-y divide-line overflow-hidden rounded-xl bg-surface shadow-raised">
        {rows.map((r, i) => {
          const video = VIDEO_KINDS.has(r.kind);
          return (
            <li key={i} className="flex flex-wrap items-center gap-2 px-3 py-2.5 sm:flex-nowrap">
              <div className="min-w-40 flex-1">
                <Select
                  aria-label="What to make"
                  selectSize="sm"
                  value={r.kind}
                  onChange={(e) => {
                    const kind = e.target.value as DeliverableKind;
                    // Videos are made vertical (9:16); other sizes are one tap away in the editor.
                    set(i, { kind, aspectRatio: VIDEO_KINDS.has(kind) ? "9:16" : r.aspectRatio === "9:16" || r.aspectRatio === "9:19.5" ? "4:5" : r.aspectRatio, durationSec: VIDEO_KINDS.has(kind) ? r.durationSec : undefined });
                  }}
                  options={KINDS.map((k) => ({ value: k, label: DELIVERABLE_LABEL[k] }))}
                />
              </div>
              {video ? (
                <div className="w-32">
                  {/* Auto: each idea gets its own length (30–60 s); a fixed length applies to every idea. */}
                  <Select aria-label="Length" selectSize="sm" value={r.durationSec ? String(r.durationSec) : "auto"} onChange={(e) => set(i, { durationSec: e.target.value === "auto" ? undefined : Number(e.target.value) })} options={[{ value: "auto", label: "Auto length" }, ...[6, 10, 15, 20, 30, 45, 60].map((s) => ({ value: String(s), label: `${s} s` }))]} />
                </div>
              ) : r.kind === "store_screenshots" ? (
                <div className="w-36">
                  <Select
                    aria-label="Store"
                    selectSize="sm"
                    value={r.store ?? "ios"}
                    onChange={(e) => set(i, { store: e.target.value as StoreTarget })}
                    options={[
                      { value: "ios", label: "App Store" },
                      { value: "android", label: "Google Play" },
                    ]}
                  />
                </div>
              ) : r.kind === "text_post" ? (
                <div className="w-32">
                  <Select aria-label="Where" selectSize="sm" value={r.channel ?? "x"} onChange={(e) => set(i, { channel: e.target.value as Channel })} options={TEXT_POST_CHANNELS.map((c) => ({ value: c, label: CHANNEL_LABEL[c] }))} />
                </div>
              ) : !FIXED_FRAME.has(r.kind) ? (
                <div className="w-24">
                  <Select aria-label="Size" selectSize="sm" value={r.aspectRatio} onChange={(e) => set(i, { aspectRatio: e.target.value as AspectRatio })} options={(r.kind === "carousel" ? (["4:5", "1:1"] as AspectRatio[]) : ASPECTS).map((a) => ({ value: a, label: a }))} />
                </div>
              ) : null}
              {r.kind === "carousel" || r.kind === "store_screenshots" ? (
                <div className="w-28">
                  <Select
                    aria-label="Slides"
                    selectSize="sm"
                    value={String(r.slides ?? 6)}
                    onChange={(e) => set(i, { slides: Number(e.target.value) })}
                    options={(() => {
                      const l = slideLimits(r.kind === "carousel" ? "carousel" : "store_screenshots", r.store);
                      return Array.from({ length: l.max - l.min + 1 }, (_, k) => ({ value: String(l.min + k), label: `${l.min + k} slides` }));
                    })()}
                  />
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
              <IconButton label="Remove" size="sm" onClick={() => onChange(rows.filter((_, j) => j !== i))} disabled={rows.length <= 1}>
                <Trash2 className="size-3.5" aria-hidden />
              </IconButton>
            </li>
          );
        })}
      </ul>
      {rows.length < 12 ? (
        <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" aria-hidden />} onClick={() => onChange([...rows, { kind: "static_ad", aspectRatio: "4:5", count: 1 }])}>
          Add something else
        </Button>
      ) : null}
      <p className="text-caption text-ink-3">Videos are made vertical (9:16) with music chosen for each idea; make other sizes from the editor’s Format switch. Store screenshots use the store’s own size and only real screens of your app.</p>
    </div>
  );
}

/** What a row adds in brackets: a video's length, a store set's store and slides, a carousel's slides and shape, a text post's channel. */
function detail(r: Row): string {
  if (VIDEO_KINDS.has(r.kind)) return r.durationSec ? ` (${r.durationSec} s)` : "";
  if (r.kind === "store_screenshots") return ` (${r.store === "android" ? "Google Play" : "App Store"}, ${r.slides ?? 6} slides)`;
  if (r.kind === "carousel") return ` (${r.slides ?? 6} slides, ${r.aspectRatio})`;
  if (r.kind === "text_post") return ` (${CHANNEL_LABEL[r.channel ?? "x"]})`;
  if (FIXED_FRAME.has(r.kind)) return r.kind === "thumbnail" ? " (16:9)" : "";
  return ` (${r.aspectRatio})`;
}

/** "3 short videos · Instagram, TikTok · length chosen per idea": the defaults in one line. */
function summary(rows: Row[], channels: Channel[], goal: CampaignGoal): string {
  const what = rows.map((r) => `${r.count} ${DELIVERABLE_LABEL[r.kind].toLowerCase()}${r.count > 1 && !/(s|outreach)$/i.test(DELIVERABLE_LABEL[r.kind]) ? "s" : ""}${detail(r)}`).join(", ");
  const autoLength = rows.some((r) => VIDEO_KINDS.has(r.kind) && !r.durationSec);
  return [what, channels.map((c) => CHANNEL_LABEL[c]).join(", "), autoLength ? "length chosen per idea (30–60 s)" : null, goal !== "awareness" ? GOAL_LABEL[goal] : null].filter(Boolean).join(" · ");
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
  const [rows, setRows] = useState<Row[]>(DEFAULT_ROWS);
  const [conceptCount, setConceptCount] = useState<"3" | "4" | "5" | "6">("3");
  const [cap, setCap] = useState("");
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [short, setShort] = useState(false);
  const idem = useRef(newIdempotencyKey("campaign"));
  const r = routes.app(workspaceId, appId);
  const opportunityIds = params.getAll("opportunity").slice(0, 10);

  const submit = async () => {
    if (request.trim().length < 8) return setError("Describe what you want in a sentence or two.");
    if (!channels.length) {
      setMore(true);
      return setError("Pick at least one channel under More options.");
    }
    setError(null);
    setBusy(true);
    try {
      const deliverables: Deliverable[] = rows.map((x) => ({ kind: x.kind, aspectRatio: x.aspectRatio, count: x.count, durationSec: x.durationSec, ...(x.slides ? { slides: x.slides } : {}), ...(x.store ? { store: x.store } : {}), ...(x.channel ? { channel: x.channel } : {}) }));
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

  const next = [
    ["Research", "what your audience talks about, with sources"],
    ["Ideas", `${conceptCount} different ideas for you to pick from`],
    ["Videos", "a plan and an editable video for each idea you pick"],
    ["Checks", "facts and brand. Nothing is posted without you"],
  ];

  return (
    <PageContainer width="wide">
      <Link href={r.create()} className="mb-6 inline-flex items-center gap-1.5 text-footnote font-medium text-ink-2 hover:text-ink">
        <ArrowLeft className="size-3.5" aria-hidden /> Create
      </Link>
      <PageHeader title="New campaign" description={`Tell Muse what you want for ${app?.name ?? "your app"}. It researches, writes different ideas for you to pick from, then makes the ones you choose.`} />
      <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_340px]">
        <form
          className="min-w-0 space-y-6"
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

          <div className="space-y-2">
            <p className="text-footnote text-ink-2 text-pretty">
              <span className="font-medium text-ink">Makes: </span>
              {summary(rows, channels, goal)}
            </p>
            <button type="button" aria-expanded={more} onClick={() => setMore((v) => !v)} className="inline-flex items-center gap-1 text-footnote font-medium text-accent hover:underline">
              More options
              <ChevronDown className={cn("size-3.5 transition-transform", more && "rotate-180")} aria-hidden />
            </button>
          </div>

          {more ? (
            <div className="space-y-8 border-t border-line pt-6">
              <fieldset className="space-y-3">
                <legend className="mb-3 text-footnote font-medium">Goal</legend>
                <ChoiceChips label="Goal" value={[goal]} onChange={(v) => v[0] && setGoal(v[0])} options={GOALS.map((g) => ({ value: g, label: GOAL_LABEL[g] }))} />
              </fieldset>
              <fieldset className="space-y-3">
                <legend className="mb-3 text-footnote font-medium">Channels</legend>
                <ChoiceChips label="Channels" multiple value={channels} onChange={(v) => setChannels(v.slice(0, 8))} options={CHANNELS.map((c) => ({ value: c, label: CHANNEL_LABEL[c] }))} />
              </fieldset>
              <fieldset>
                <legend className="mb-3 text-footnote font-medium">What to make</legend>
                <DeliverableEditor rows={rows} onChange={setRows} />
              </fieldset>
              <div className="grid gap-6 sm:grid-cols-2">
                <fieldset>
                  <legend className="mb-3 text-footnote font-medium">Ideas to pick from</legend>
                  <SegmentedControl<"3" | "4" | "5" | "6"> label="Number of ideas" value={conceptCount} onChange={setConceptCount} items={(["3", "4", "5", "6"] as const).map((n) => ({ value: n, label: n }))} />
                </fieldset>
                <Field label="Credit limit" optional hint="Muse stops and asks before going over.">
                  {(f) => <Input id={f.id} aria-describedby={f.describedBy} type="number" min={1} inputMode="numeric" value={cap} onChange={(e) => setCap(e.target.value)} placeholder={credits ? `Up to ${credits.available}` : "No limit"} />}
                </Field>
              </div>
            </div>
          ) : null}
          {opportunityIds.length ? <Notice tone="info">Building on {opportunityIds.length} opportunit{opportunityIds.length === 1 ? "y" : "ies"} from what Muse found.</Notice> : null}
        </form>

        <aside>
          <div className="space-y-6 rounded-xl bg-surface p-5 shadow-raised lg:sticky lg:top-20">
            <div className="space-y-1">
              <p className="text-body-sm font-semibold">What happens next</p>
              <p className="text-footnote text-ink-2">You pick the ideas before any video is made.</p>
            </div>
            <ol className="space-y-3">
              {next.map(([what, rest], i) => (
                <li key={what} className="flex gap-3 text-body-sm">
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-mist text-caption font-semibold tabular text-ink">{i + 1}</span>
                  <span className="text-ink-2 text-pretty">
                    <span className="font-medium text-ink">{what}:</span> {rest}
                  </span>
                </li>
              ))}
            </ol>
            <div className="space-y-4 border-t border-line pt-5">
              <WorkspaceCostEstimate operation="campaign.generate_concepts" params={{ count: Number(conceptCount) }} onEstimate={(e) => setShort(Boolean(e && e.credits > e.available))} note="Making the ideas you pick is estimated separately." />
              {unavailable ? <Notice tone="warning">Campaign generation isn’t deployed in this build yet, so nothing was started.</Notice> : null}
              <Button size="lg" className="w-full" loading={busy} disabled={!can("content.write") || short} onClick={() => void submit()}>
                Write ideas
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
