"use client";
import { SegmentedControl, cn } from "@muselaunch/ui";
import { BarChart3, Clapperboard, Compass } from "lucide-react";
import { useState, type ReactNode } from "react";

type Tab = "discover" | "creator" | "insights";

const PANELS: Record<Tab, { title: string; body: string; points: string[] }> = {
  discover: {
    title: "Know what’s working before you make anything",
    body: "Track competitors, creators and communities in a stories-style row. Muse Wonder researches the market for your app and turns findings into campaign opportunities that fit your product, not generic trends.",
    points: ["Every finding links to its source and the date it was retrieved", "Interpretations are labelled separately from what sources actually say", "Creator outreach is drafted for your approval, never sent on its own"],
  },
  creator: {
    title: "Ask for a campaign. Get real, editable videos.",
    body: "Muse proposes strategically different concepts, writes scripts and storyboards, then builds compositions from your real screenshots and recordings and renders them with HyperFrames. Edit by talking to it.",
    points: ["“Make the opening punchier” changes that scene and leaves the others untouched", "SAM 3.1 cuts you out of your own footage to stand in front of the app", "Download MP4s, stills, carousels and captions ready to post"],
  },
  insights: {
    title: "See what moved the numbers, and what to try next",
    body: "Connect RevenueCat, store analytics and social insights, or import CSVs. Muse compares experiments, explains what may have worked, and recommends the next one.",
    points: ["Every metric shows its source and how it was attributed", "Correlation is never presented as proof", "No connected data means no charts, not estimated ones"],
  },
};

/** Abstract wireframes: shapes only, deliberately free of numbers, names or results. */
function Wireframe({ tab }: { tab: Tab }) {
  const bar = "rounded-full bg-mist-2";
  if (tab === "discover") {
    return (
      <div className="flex h-full flex-col gap-6 p-6 sm:p-8">
        <div className="flex gap-4">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="flex flex-col items-center gap-2">
              <div className={cn("size-12 rounded-full p-[2px] sm:size-14", i < 3 ? "bg-accent/70" : "bg-line-strong")}>
                <div className="size-full rounded-full border-2 border-white bg-mist" />
              </div>
              <div className={cn(bar, "h-1.5 w-10")} />
            </div>
          ))}
        </div>
        {[0, 1].map((i) => (
          <div key={i} className="space-y-3 rounded-xl bg-white p-4 shadow-raised">
            <div className={cn(bar, "h-2.5 w-3/5")} />
            <div className={cn(bar, "h-2 w-full")} />
            <div className={cn(bar, "h-2 w-4/5")} />
            <div className="flex gap-2 pt-1">
              <div className="h-5 w-24 rounded-full border border-line" />
              <div className="h-5 w-20 rounded-full border border-line" />
            </div>
          </div>
        ))}
      </div>
    );
  }
  if (tab === "creator") {
    return (
      <div className="flex h-full flex-col gap-4 p-6 sm:p-8">
        <div className="flex flex-1 gap-4">
          <div className="hidden w-28 flex-col gap-2 sm:flex">
            {Array.from({ length: 5 }, (_, i) => (
              <div key={i} className={cn("h-9 rounded-md", i === 1 ? "bg-accent-soft ring-1 ring-accent/40" : "bg-white shadow-raised")} />
            ))}
          </div>
          <div className="flex flex-1 items-center justify-center rounded-xl bg-white shadow-raised">
            <div className="relative aspect-[9/16] h-[78%] rounded-[18px] bg-ink/90 p-1.5">
              <div className="size-full rounded-[13px] bg-[linear-gradient(160deg,#2a2d3a,#15161c)]" />
              <div className="absolute inset-x-4 bottom-6 space-y-1.5">
                <div className="h-2 w-4/5 rounded-full bg-white/80" />
                <div className="h-2 w-1/2 rounded-full bg-white/50" />
              </div>
            </div>
          </div>
          <div className="hidden w-40 flex-col gap-3 rounded-xl bg-white p-3 shadow-raised md:flex">
            <div className={cn(bar, "h-2 w-3/4")} />
            <div className={cn(bar, "h-2 w-full")} />
            <div className="mt-auto h-8 rounded-lg border border-line" />
          </div>
        </div>
        <div className="space-y-1.5 rounded-xl bg-white p-3 shadow-raised">
          <div className="flex gap-1">
            {[18, 26, 14, 22, 20].map((w, i) => (
              <div key={i} className={cn("h-6 rounded-[5px]", i === 1 ? "bg-accent/80" : "bg-mist-2")} style={{ width: `${w}%` }} />
            ))}
          </div>
          <div className="flex gap-1">
            <div className="h-3 w-[46%] rounded-[4px] bg-mist" />
            <div className="h-3 w-[30%] rounded-[4px] bg-mist" />
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="flex h-full flex-col gap-4 p-6 sm:p-8">
      <div className="grid grid-cols-3 gap-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="space-y-2 rounded-xl bg-white p-4 shadow-raised">
            <div className={cn(bar, "h-2 w-1/2")} />
            <div className="h-5 w-3/4 rounded-md bg-mist" />
            <div className="h-4 w-16 rounded-full border border-dashed border-line-strong" />
          </div>
        ))}
      </div>
      <div className="relative flex-1 rounded-xl bg-white p-4 shadow-raised">
        <div className="absolute inset-x-4 bottom-8 top-6 flex flex-col justify-between">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-px w-full bg-line" />
          ))}
        </div>
        <svg className="absolute inset-x-4 bottom-8 top-6 h-[calc(100%-56px)] w-[calc(100%-32px)]" viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden>
          <path d="M0 30 C 15 28, 25 31, 40 24 S 70 18, 100 12" fill="none" stroke="var(--ml-line-strong)" strokeWidth="0.8" strokeDasharray="2 1.6" vectorEffect="non-scaling-stroke" />
        </svg>
      </div>
    </div>
  );
}

const ICON: Record<Tab, ReactNode> = { discover: <Compass aria-hidden />, creator: <Clapperboard aria-hidden />, insights: <BarChart3 aria-hidden /> };

export function TabsShowcase() {
  const [tab, setTab] = useState<Tab>("creator");
  const p = PANELS[tab];
  return (
    <div className="space-y-10">
      <div className="flex justify-center">
        <SegmentedControl<Tab>
          label="MuseLaunch sections"
          size="lg"
          value={tab}
          onChange={setTab}
          items={(["discover", "creator", "insights"] as const).map((t) => ({ value: t, label: t[0]!.toUpperCase() + t.slice(1), icon: ICON[t] }))}
        />
      </div>
      <div key={tab} className="grid items-center gap-10 animate-fade-in lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] lg:gap-16">
        <div className="space-y-5">
          <h3 className="text-title-1 font-semibold text-balance">{p.title}</h3>
          <p className="text-headline font-normal text-ink-2 text-pretty">{p.body}</p>
          <ul className="space-y-3 border-t border-line pt-5">
            {p.points.map((pt) => (
              <li key={pt} className="flex gap-3 text-body text-ink">
                <span aria-hidden className="mt-[9px] size-1.5 shrink-0 rounded-full bg-accent" />
                {pt}
              </li>
            ))}
          </ul>
        </div>
        <div className="aspect-[4/3] w-full overflow-hidden rounded-[28px] bg-mist" role="img" aria-label={`Illustration of the ${tab} screen layout`}>
          <Wireframe tab={tab} />
        </div>
      </div>
    </div>
  );
}
