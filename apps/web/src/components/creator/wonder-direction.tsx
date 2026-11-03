"use client";
import { modelDisplayName, MUSIC_MOOD_INFO, type CreativeDirection } from "@muselaunch/contracts";
import { cn } from "@muselaunch/ui";
import { Clapperboard } from "lucide-react";
import { useState } from "react";

const PACING_LABEL: Record<CreativeDirection["pacing"], string> = { punchy: "Punchy cuts", steady: "Steady rhythm", "slow-burn": "Slow build" };
const shotLabel = (t: string) => t.replace(/-/g, " ");

/** Muse Wonder's creative direction for a concept (Growth Autopilot), as the storyboard received it. */
export function WonderDirection({ direction: d, className }: { direction: CreativeDirection; className?: string }) {
  const [open, setOpen] = useState(false);
  const director = modelDisplayName(d.model, { short: true }) || d.model;
  return (
    <div className={cn("rounded-lg border border-line px-3 py-2.5", className)}>
      <div className="flex items-center gap-2">
        <Clapperboard className="size-3.5 shrink-0 text-ink-2" aria-hidden />
        <p className="text-footnote text-ink">
          <span className="font-medium">Directed by {director}</span>
          <span className="text-ink-3"> · {PACING_LABEL[d.pacing]} · {MUSIC_MOOD_INFO[d.musicMood].label} score</span>
        </p>
      </div>
      <p className={cn("mt-1.5 text-footnote text-ink-2 text-pretty", !open && "line-clamp-2")}>{d.visualMotif}</p>
      {open ? (
        <dl className="mt-2 space-y-1.5 text-footnote">
          <div>
            <dt className="text-ink-3">Hook</dt>
            <dd className="text-ink-2 text-pretty">{d.hookApproach}</dd>
          </div>
          {d.signatureShots.length ? (
            <div>
              <dt className="text-ink-3">Signature shots</dt>
              <dd className="text-ink-2">{d.signatureShots.map(shotLabel).join(", ")}</dd>
            </div>
          ) : null}
          {d.avoid ? (
            <div>
              <dt className="text-ink-3">Avoid</dt>
              <dd className="text-ink-2 text-pretty">{d.avoid}</dd>
            </div>
          ) : null}
          {d.why ? (
            <div>
              <dt className="text-ink-3">Why</dt>
              <dd className="text-ink-2 text-pretty">{d.why}</dd>
            </div>
          ) : null}
        </dl>
      ) : null}
      <button type="button" className="mt-1 text-footnote font-medium text-accent hover:underline" onClick={() => setOpen((x) => !x)} aria-expanded={open}>
        {open ? "Less" : "Full direction"}
      </button>
    </div>
  );
}
