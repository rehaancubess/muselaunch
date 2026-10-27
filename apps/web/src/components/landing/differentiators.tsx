import { ArrowRight, Lock } from "lucide-react";
import type { ReactNode } from "react";

/** Schematic diagrams only: they explain how things work and never imitate output or results. */

function DepthDiagram() {
  return (
    <figure className="relative mx-auto aspect-[4/3] w-full overflow-hidden rounded-[28px] bg-mist" aria-label="Diagram: layers in an object-aware scene">
      <svg viewBox="0 0 400 300" className="absolute inset-0 size-full" aria-hidden>
        {/* frame */}
        <rect x="122" y="22" width="156" height="256" rx="22" fill="#fff" stroke="var(--ml-line-strong)" />
        {/* layer 1: app demo behind */}
        <rect x="136" y="40" width="128" height="150" rx="12" fill="var(--ml-accent-soft)" />
        <rect x="150" y="58" width="70" height="8" rx="4" fill="var(--ml-accent)" opacity=".55" />
        <rect x="150" y="76" width="100" height="6" rx="3" fill="var(--ml-accent)" opacity=".25" />
        <rect x="150" y="90" width="88" height="6" rx="3" fill="var(--ml-accent)" opacity=".25" />
        <rect x="150" y="110" width="100" height="26" rx="8" fill="#fff" opacity=".9" />
        {/* layer 2: presenter (cutout) */}
        <circle cx="200" cy="168" r="26" fill="var(--ml-ink)" opacity=".86" />
        <path d="M146 278c4-44 26-68 54-68s50 24 54 68z" fill="var(--ml-ink)" opacity=".86" />
        {/* layer 3: tracked phone with glow */}
        <rect x="226" y="196" width="30" height="54" rx="7" fill="none" stroke="var(--ml-accent)" strokeWidth="7" opacity=".18" />
        <rect x="226" y="196" width="30" height="54" rx="7" fill="#fff" stroke="var(--ml-accent)" strokeWidth="2" />
        <rect x="231" y="203" width="20" height="40" rx="3" fill="var(--ml-accent-soft)" />
        {/* layer 4: anchored label */}
        <path d="M256 210 L300 182" stroke="var(--ml-ink-3)" strokeWidth="1.2" strokeDasharray="3 3" />
        <rect x="294" y="166" width="78" height="26" rx="13" fill="#fff" stroke="var(--ml-line-strong)" />
        <rect x="306" y="176" width="54" height="6" rx="3" fill="var(--ml-ink-3)" />
        {/* numbered markers */}
        {[
          [126, 46, "1"],
          [128, 150, "2"],
          [262, 254, "3"],
          [370, 160, "4"],
        ].map(([x, y, t]) => (
          <g key={String(t)}>
            <circle cx={Number(x)} cy={Number(y)} r="10" fill="var(--ml-ink)" />
            <text x={Number(x)} y={Number(y) + 4} textAnchor="middle" fontSize="11" fontWeight="600" fill="#fff">
              {t}
            </text>
          </g>
        ))}
      </svg>
      <figcaption className="absolute inset-x-4 bottom-3 text-center text-caption text-ink-3">Schematic, not a render</figcaption>
    </figure>
  );
}

function GuardianDiagram() {
  const box = "rounded-xl bg-white p-4 shadow-raised";
  const chip = "inline-flex h-6 items-center rounded-full bg-mist px-2.5 text-caption font-medium text-ink";
  return (
    <figure className="grid w-full gap-3 rounded-[28px] bg-mist p-5 sm:p-7" aria-label="Diagram: cloud agents create, the local guardian checks, you approve">
      <div className={box}>
        <p className="mb-2 text-caption text-ink-3">Cloud agents create</p>
        <div className="flex flex-wrap gap-1.5">
          <span className={chip}>Muse Wonder</span>
          <span className={chip}>Muse Spark 1.3</span>
          <span className={chip}>SAM 3.1</span>
        </div>
      </div>
      <ArrowRight className="mx-auto size-4 rotate-90 text-ink-3" aria-hidden />
      <div className={`${box} ring-1 ring-accent/30`}>
        <p className="mb-2 flex items-center gap-1.5 text-caption text-accent-ink">
          <Lock className="size-3" aria-hidden /> Local guardian checks, privately
        </p>
        <div className="flex flex-wrap gap-1.5">
          <span className="inline-flex h-6 items-center rounded-full bg-accent-soft px-2.5 text-caption font-medium text-accent-ink">Muse Glimmer</span>
          <span className={chip}>Deterministic rules</span>
        </div>
        <ul className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 text-caption text-ink-2">
          <li>Unsupported claims</li>
          <li>Tone drift</li>
          <li>Prohibited phrases</li>
          <li>CTA and platform fit</li>
        </ul>
      </div>
      <ArrowRight className="mx-auto size-4 rotate-90 text-ink-3" aria-hidden />
      <div className={box}>
        <p className="text-caption text-ink-3">You approve the exact version</p>
      </div>
    </figure>
  );
}

const LOOP = ["Research with sources", "Pick an audience", "Write a testable hypothesis", "Create concepts and videos", "Verify: lint, claims, guardian", "Checkpoint with you", "Render and draft the calendar", "Measure real results", "Learn and start the next round"];

function LoopDiagram() {
  return (
    <figure className="w-full rounded-[28px] bg-mist p-5 sm:p-7" aria-label="Diagram: the Growth Autopilot loop and its limits">
      <ol className="grid gap-2 sm:grid-cols-3">
        {LOOP.map((s, i) => (
          <li key={s} className="flex items-center gap-2.5 rounded-xl bg-white px-3 py-2.5 shadow-raised">
            <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-ink text-[11px] font-semibold tabular text-white">{i + 1}</span>
            <span className="text-footnote font-medium text-ink">{s}</span>
          </li>
        ))}
      </ol>
      <div className="mt-4 rounded-xl border border-dashed border-line-strong px-4 py-3">
        <p className="text-caption font-medium text-ink">Brakes on every loop</p>
        <p className="mt-1 text-caption text-ink-2">Credit budget, iteration cap, an auto-approve threshold per step, a full decision log with citations, and nothing posts without a person approving it.</p>
      </div>
    </figure>
  );
}

function Row({ title, body, points, visual, flip }: { title: string; body: string; points: string[]; visual: ReactNode; flip?: boolean }) {
  return (
    <div className="grid items-center gap-10 lg:grid-cols-2 lg:gap-16">
      <div className={flip ? "lg:order-2" : undefined}>
        <h3 className="text-title-1 font-semibold text-balance">{title}</h3>
        <p className="mt-4 text-headline font-normal text-ink-2 text-pretty">{body}</p>
        <ul className="mt-6 space-y-3 border-t border-line pt-5">
          {points.map((p) => (
            <li key={p} className="flex gap-3 text-body text-ink">
              <span aria-hidden className="mt-[9px] size-1.5 shrink-0 rounded-full bg-accent" />
              {p}
            </li>
          ))}
        </ul>
      </div>
      <div className={flip ? "lg:order-1" : undefined}>{visual}</div>
    </div>
  );
}

export function Differentiators() {
  return (
    <div className="space-y-24 md:space-y-32">
      <Row
        title="Video edits that know what’s in the frame."
        body="Record yourself holding your phone. SAM 3.1 finds and tracks you and the phone through the clip, Muse Spark decides which effects support the message, and HyperFrames renders it."
        points={["Your app demo plays behind you, not on top of you", "The phone stays highlighted as it moves, and labels follow it", "Your real app recording appears on the phone in your hand"]}
        visual={<DepthDiagram />}
      />
      <Row
        flip
        title="A brand guardian that runs locally."
        body="Muse Glimmer, self-hosted, reviews every video version, caption and post against your verified claims, voice and past decisions before you approve. Rules run alongside it, and each finding says which one raised it."
        points={["Flags claims your App DNA can’t support", "Catches tone drift and phrases you’ve banned", "Suggests one-click fixes you can review first"]}
        visual={<GuardianDiagram />}
      />
      <Row
        title="An autopilot with brakes."
        body="Give Muse Wonder a goal. It works through a real marketing loop using the same tools you do, checks its own output, and stops for you at every checkpoint that matters."
        points={["Every audience choice cites the research behind it", "Each round is an experiment with a hypothesis", "What it learns is remembered for the next round"]}
        visual={<LoopDiagram />}
      />
    </div>
  );
}

export const DEMO_SEQUENCE = [
  { title: "Import your app", text: "Paste a store link. Muse Spark builds your App DNA from the real listing and screenshots, with evidence for every fact." },
  { title: "Set a goal", text: "Growth Autopilot researches possible audiences with citations, picks one, and proposes distinct campaigns." },
  { title: "Get real videos", text: "Compositions are built from your actual app recordings and rendered by HyperFrames." },
  { title: "Talk to your footage", text: "Upload a clip of yourself and say what you want. Muse Voice Transcribe takes the instruction; SAM and Spark do the object-aware edit, in three hook variants." },
  { title: "Let the guardian check", text: "Glimmer reviews each variant locally and flags or fixes issues before you approve." },
  { title: "Approve, post, learn", text: "Posts are drafted on a calendar you approve. Real or clearly labelled imported results feed the next round." },
];
