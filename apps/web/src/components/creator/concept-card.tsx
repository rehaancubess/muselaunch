"use client";
import type { AspectRatio, CampaignVariant, Claim, Composition } from "@muselaunch/contracts";
import { Badge, Button, Dialog, SegmentedControl, Select, StatusPill, Tooltip, cn, humanizeStatus, statusKindOf, useToast } from "@muselaunch/ui";
import { Brain, CheckCircle2, Clapperboard, FileSearch, Target } from "lucide-react";
import Link from "next/link";
import { useRef, useState } from "react";
import { api, errorMessage, newIdempotencyKey, wsPath } from "@/lib/api";
import type { JobResponse } from "@/lib/api-types";
import { WorkspaceCostEstimate } from "@/lib/estimate";
import { ANGLE_LABEL, CHANNEL_LABEL } from "@/lib/labels";
import { useInvalidate } from "@/lib/query";
import { routes } from "@/lib/routes";

export interface ConceptCardProps {
  variant: CampaignVariant;
  /** Compositions produced from this concept. */
  produced: Composition[];
  campaignId: string;
  workspaceId: string;
  claims: Map<string, Claim>;
  runHref?: string;
  canEdit: boolean;
  onJob: (job: JobResponse["job"]) => void;
}

/** A strategically distinct concept: angle, hook, audience, rationale, evidence, memory influence. */
export function ConceptCard({ variant: v, produced, campaignId, workspaceId, claims, runHref, canEdit, onJob }: ConceptCardProps) {
  const toast = useToast();
  const invalidate = useInvalidate();
  const [busy, setBusy] = useState<"select" | "produce" | "reject" | null>(null);
  const [produceOpen, setProduceOpen] = useState(false);
  const [aspect, setAspect] = useState<AspectRatio>("9:16");
  const [duration, setDuration] = useState("15");
  const [expanded, setExpanded] = useState(false);
  const idem = useRef(newIdempotencyKey("produce"));
  const campaignPath = wsPath(workspaceId, `/campaigns/${campaignId}`);
  const selected = v.status === "selected" || v.status === "produced";
  const linkedClaims = v.claimIds.map((id) => claims.get(id)).filter((c): c is Claim => Boolean(c));

  const decide = async (action: "select" | "reject") => {
    setBusy(action);
    try {
      await api.post(`${campaignPath}/variants/${v.id}/${action}`);
      await invalidate(campaignPath);
      if (action === "reject") toast.toast({ title: "Concept set aside", description: "Muse remembers this so future concepts avoid the same angle." });
    } catch (e) {
      toast.error(action === "select" ? "Couldn’t select the concept" : "Couldn’t set the concept aside", errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const select = () => decide("select");

  const produce = async () => {
    setBusy("produce");
    try {
      const r = await api.post<JobResponse>(`${campaignPath}/variants/${v.id}/produce`, { aspectRatio: aspect, targetDurationSec: Number(duration) }, { idempotencyKey: idem.current });
      onJob(r.job);
      setProduceOpen(false);
      idem.current = newIdempotencyKey("produce");
      await invalidate(campaignPath);
      toast.success("Production started", "Muse is writing the storyboard. The composition and preview render follow automatically.");
    } catch (e) {
      toast.error("Couldn’t start production", errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <article
      className={cn(
        "flex flex-col rounded-2xl bg-surface p-5 shadow-raised transition-shadow",
        selected && "shadow-[0_0_0_1.5px_var(--ml-accent),0_8px_24px_-12px_rgb(51_85_255/0.35)]",
        v.status === "rejected" && "opacity-60",
      )}
      aria-labelledby={`concept-${v.id}`}
    >
      <div className="mb-4 flex flex-wrap items-center gap-1.5">
        <Badge tone="neutral">{ANGLE_LABEL[v.angleType]}</Badge>
        {produced.length ? <StatusPill status="success">Produced</StatusPill> : v.status === "rejected" ? <StatusPill status="cancelled">Set aside</StatusPill> : v.status !== "proposed" ? <StatusPill status={statusKindOf(v.status)}>{humanizeStatus(v.status)}</StatusPill> : null}
        {v.memoryRefs.length ? (
          <Tooltip content={`Shaped by ${v.memoryRefs.length} of your saved preferences (Muse Glimmer memory).`}>
            <span>
              <Badge tone="accent" icon={<Brain aria-hidden />}>
                Uses your preferences
              </Badge>
            </span>
          </Tooltip>
        ) : null}
      </div>
      <h3 id={`concept-${v.id}`} className="text-headline font-semibold text-balance">
        {v.title}
      </h3>
      <blockquote className="mt-3 border-l-2 border-ink pl-3 text-body text-ink text-pretty">“{v.hook}”</blockquote>
      <dl className="mt-5 space-y-3 text-body-sm">
        <div>
          <dt className="text-caption text-ink-3">For</dt>
          <dd className="text-ink">{v.audience}</dd>
        </div>
        <div>
          <dt className="text-caption text-ink-3">Message</dt>
          <dd className="text-ink">{v.keyMessage}</dd>
        </div>
        <div>
          <dt className="text-caption text-ink-3">Why this could work</dt>
          <dd className={cn("text-ink-2 text-pretty", !expanded && "line-clamp-3")}>{v.rationale}</dd>
          {v.rationale.length > 180 ? (
            <button type="button" className="mt-1 text-footnote font-medium text-accent hover:underline" onClick={() => setExpanded((x) => !x)} aria-expanded={expanded}>
              {expanded ? "Show less" : "Read more"}
            </button>
          ) : null}
        </div>
        <div className="flex items-start gap-2 rounded-lg bg-mist px-3 py-2">
          <Target className="mt-0.5 size-3.5 shrink-0 text-ink-2" aria-hidden />
          <p className="text-footnote text-ink-2">
            <span className="text-ink">Test:</span> {v.hypothesis} <span className="text-ink-3">Measured by {v.successMetric.metric}.</span>
          </p>
        </div>
      </dl>
      <div className="mt-4 flex flex-wrap gap-1.5">
        {linkedClaims.map((c) => (
          <Tooltip key={c.id} content={c.state === "verified" ? "Verified claim" : "Claim not verified yet; it won’t be stated until you verify it"}>
            <span>
              <Badge tone={c.state === "verified" ? "success" : "warning"} icon={<CheckCircle2 aria-hidden />} className="max-w-56">
                <span className="truncate">{c.text}</span>
              </Badge>
            </span>
          </Tooltip>
        ))}
        {v.findingIds.length ? (
          runHref ? (
            <Link href={runHref} className="inline-flex h-[22px] items-center gap-1 rounded-full border border-line-strong px-2 text-caption font-medium text-ink-2 hover:bg-mist">
              <FileSearch className="size-3" aria-hidden />
              {v.findingIds.length} research finding{v.findingIds.length === 1 ? "" : "s"}
            </Link>
          ) : (
            <Badge tone="outline" icon={<FileSearch aria-hidden />}>
              {v.findingIds.length} research finding{v.findingIds.length === 1 ? "" : "s"}
            </Badge>
          )
        ) : (
          <Badge tone="outline">No research findings cited</Badge>
        )}
        {v.channels.slice(0, 3).map((c) => (
          <Badge key={c} tone="outline">
            {CHANNEL_LABEL[c]}
          </Badge>
        ))}
      </div>
      {canEdit ? (
        <div className="mt-auto flex flex-wrap gap-2 pt-6">
          {v.status === "rejected" ? (
            <Button variant="ghost" className="flex-1" loading={busy === "select"} onClick={select}>
              Bring back
            </Button>
          ) : produced.length ? (
            <>
              <Button className="flex-1" icon={<Clapperboard className="size-4" aria-hidden />} asChild>
                <Link href={routes.app(workspaceId, v.appId).studio(produced[0]!.id)}>
                  <Clapperboard className="size-4" aria-hidden />
                  Open in Studio
                </Link>
              </Button>
              <Button variant="ghost" onClick={() => setProduceOpen(true)}>
                Another format
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" loading={busy === "reject"} onClick={() => decide("reject")}>
                Set aside
              </Button>
              {v.status === "proposed" ? (
                <Button variant="secondary" className="flex-1" loading={busy === "select"} onClick={select}>
                  Select
                </Button>
              ) : (
                <Button className="flex-1" icon={<Clapperboard className="size-4" aria-hidden />} onClick={() => setProduceOpen(true)}>
                  Produce
                </Button>
              )}
            </>
          )}
        </div>
      ) : null}
      <Dialog
        open={produceOpen}
        onOpenChange={setProduceOpen}
        title={`Produce “${v.title}”`}
        description="Muse Spark writes the storyboard, then builds an editable composition from your real screenshots and renders a preview."
        footer={
          <>
            <Button variant="ghost" onClick={() => setProduceOpen(false)}>
              Cancel
            </Button>
            <Button loading={busy === "produce"} onClick={produce}>
              Start production
            </Button>
          </>
        }
      >
        <div className="space-y-5">
          <div className="space-y-2">
            <p className="text-footnote font-medium">Format</p>
            <SegmentedControl<AspectRatio> label="Aspect ratio" value={aspect} onChange={setAspect} items={(["9:16", "1:1", "4:5", "16:9"] as const).map((a) => ({ value: a, label: a }))} />
          </div>
          <div className="w-40 space-y-2">
            <label htmlFor={`dur-${v.id}`} className="text-footnote font-medium">
              Length
            </label>
            <Select id={`dur-${v.id}`} value={duration} onChange={(e) => setDuration(e.target.value)} options={[6, 10, 15, 20, 30, 45, 60].map((s) => ({ value: String(s), label: `${s} seconds` }))} />
          </div>
          <WorkspaceCostEstimate operation="storyboard.generate" note="Includes the storyboard. The preview render costs a few more credits; final renders are estimated when you export." />
        </div>
      </Dialog>
    </article>
  );
}
