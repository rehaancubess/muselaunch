"use client";
/**
 * The first run before its first video exists: one calm screen instead of a build log.
 *
 * - A live loader around the app's own icon. The ring is the run's real progress (finished steps
 *   plus the measured share of the current step's jobs); the moving arc and glow only say "working".
 * - The current task in one sentence, which changes as the run moves on.
 * - The promise: you can leave; you're told when the first videos are ready (in this browser if you
 *   allow it, on your phone if it's linked, and on Home either way).
 * - What Muse has learned so far: real counts as each step finishes, and "What we're testing".
 * - The full step list one tap away ("Show all steps").
 */
import type { NeedsYouItem } from "@muselaunch/contracts";
import { Button, cn } from "@muselaunch/ui";
import { Bell, BellRing, Check, ChevronDown, Smartphone } from "lucide-react";
import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { AppIcon } from "@/components/app-icon";
import { QuickSetup } from "@/components/onboarding/quick-setup";
import { useApiQuery } from "@/lib/query";
import { routes } from "@/lib/routes";
import { useWorkspace } from "@/lib/workspace";
import { currentStep, firstRunPhase, firstRunTabTitle, learnedSoFar, runPercent, shortAppName } from "./first-run";
import { NeedsYouList } from "./needs-you";
import { doingLine, showRecordingFirst } from "./progress-lines";
import { MadeWith, RunSteps, stepLabel } from "./progress";
import type { AutopilotDetail } from "./types";

/** Opt-in to a browser notification when this run's first videos are ready (kept per run, this browser only). */
export const notifyKey = (runId: string) => `ml.notifyFirstRun.${runId}`;

function notificationPermission(): NotificationPermission | "unsupported" {
  return typeof window !== "undefined" && "Notification" in window ? Notification.permission : "unsupported";
}

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function minutesAgo(iso: string, now: number): string {
  const m = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  return m < 1 ? "just now" : m === 1 ? "1 minute ago" : m < 60 ? `${m} minutes ago` : `${Math.floor(m / 60)} h ${m % 60} min ago`;
}

function Loader({ pct, appId }: { pct: number; appId: string }) {
  const { workspaceId, apps } = useWorkspace();
  const app = apps.find((a) => a.id === appId);
  const gid = useId().replace(/:/g, "");
  const r = 54;
  const c = 2 * Math.PI * r;
  return (
    <div className="relative mx-auto size-36 sm:size-44" role="progressbar" aria-label="How far Muse has got" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
      {/* Soft glow behind the icon (decorative). */}
      <span aria-hidden className="absolute inset-[22%] rounded-full bg-accent/20 blur-2xl motion-safe:animate-[ml-breathe_3.2s_ease-in-out_infinite]" />
      {/* Real progress. */}
      <svg viewBox="0 0 120 120" className="absolute inset-0 -rotate-90" aria-hidden>
        <circle cx="60" cy="60" r={r} fill="none" stroke="var(--color-line)" strokeWidth="3" />
        <circle
          cx="60"
          cy="60"
          r={r}
          fill="none"
          stroke="var(--color-accent)"
          strokeWidth="3.5"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - Math.max(0.02, pct / 100))}
          className="transition-[stroke-dashoffset] duration-1000 ease-out"
        />
      </svg>
      {/* "Working": a comet circling inside the ring (hidden with reduced motion). */}
      <svg viewBox="0 0 120 120" className="absolute inset-0 motion-safe:animate-[spin_2.6s_linear_infinite] motion-reduce:hidden" aria-hidden>
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="var(--color-accent)" stopOpacity="0" />
            <stop offset="1" stopColor="var(--color-accent)" stopOpacity="0.9" />
          </linearGradient>
        </defs>
        <circle cx="60" cy="60" r="45" fill="none" stroke={`url(#${gid})`} strokeWidth="2" strokeLinecap="round" strokeDasharray="70 213" />
        <circle cx="105" cy="60" r="2.4" fill="var(--color-accent)" transform="rotate(-62 60 60)" />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center">
        <AppIcon app={app} workspaceId={workspaceId} size={64} className="shadow-raised" />
      </span>
    </div>
  );
}

function NotifyMe({ runId }: { runId: string }) {
  const [perm, setPerm] = useState<NotificationPermission | "unsupported">("unsupported");
  const [on, setOn] = useState(false);
  useEffect(() => {
    setPerm(notificationPermission());
    setOn(readFlag(notifyKey(runId)));
  }, [runId]);
  const devices = useApiQuery<{ items: unknown[] }>("/v1/me/devices", { staleTime: 60_000, retry: false });
  const phone = (devices.data?.items.length ?? 0) > 0;

  const enable = async () => {
    const p = perm === "granted" ? "granted" : await Notification.requestPermission();
    setPerm(p);
    if (p === "granted") {
      try {
        localStorage.setItem(notifyKey(runId), "1");
      } catch {
        /* no storage: the notice can't be remembered across reloads */
      }
      setOn(true);
    }
  };

  return (
    <div className="flex flex-col items-center gap-2.5">
      {perm !== "unsupported" && perm !== "denied" ? (
        on && perm === "granted" ? (
          <p className="inline-flex items-center gap-1.5 text-footnote font-medium text-ink">
            <BellRing className="size-4 text-accent" aria-hidden />
            We’ll notify you in this browser while MuseLaunch is open
          </p>
        ) : (
          <Button variant="secondary" icon={<Bell className="size-4" aria-hidden />} onClick={() => void enable()}>
            Notify me when it’s ready
          </Button>
        )
      ) : null}
      {phone ? (
        <p className="inline-flex items-center gap-1.5 text-footnote text-ink-2">
          <Smartphone className="size-3.5" aria-hidden />
          Your phone gets a notification too.
        </p>
      ) : null}
    </div>
  );
}

export function FirstRunStudying({ detail, needs }: { detail: AutopilotDetail; needs: NeedsYouItem[] }) {
  const { workspaceId, apps } = useWorkspace();
  const ap = detail.autopilot;
  const { steps, source, media, madeWith } = detail.progress;
  const app = apps.find((a) => a.id === ap.appId);
  const name = shortAppName(app?.name ?? "your app");
  const pct = runPercent(steps);
  const phase = firstRunPhase(steps);
  const cur = currentStep(steps);
  const videos = ap.compositionIds.length || ap.budget.variants;
  const learned = learnedSoFar(steps);
  const learnDone = steps.some((s) => s.key === "learn" && s.state === "done");
  const [showSteps, setShowSteps] = useState(false);
  const [now, setNow] = useState(0);
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  // No screenshots or recordings yet (e.g. added from a website): the quick setup asks for a recording up front.
  const [askedEarly, setAskedEarly] = useState(false);
  if (media?.ask === "early" && !askedEarly) setAskedEarly(true);
  const recordingFirst = showRecordingFirst({ ask: media?.ask, shownBefore: askedEarly, status: ap.status, videosBuilt: ap.compositionIds.length });
  const r = routes.app(workspaceId, ap.appId);

  // A background tab shows how far it has got.
  useEffect(() => {
    const before = document.title;
    document.title = firstRunTabTitle(pct, phase, name);
    return () => {
      document.title = before;
    };
  }, [pct, phase, name]);

  const title = phase === "studying" ? `Getting to know ${name}` : "Making your first videos";
  const sub =
    phase === "studying"
      ? `Muse is studying ${name}: what it does, who it’s for and what your audience talks about. Your first videos come right after.`
      : `Muse has studied ${name} and is now making videos of your real app, then checking every fact and your brand.`;
  const task = cur ? stepLabel(cur, source, videos) : "Finishing up";
  const taskLine = cur ? doingLine(cur.key, source, media) : null;
  const live = cur?.live;
  const jobs = live && live.total > 1 ? `${live.done} of ${live.total} done` : null;

  return (
    <div className="mx-auto max-w-2xl space-y-10 pb-6">
      <section className="space-y-7 pt-2 text-center sm:pt-6" aria-labelledby="first-run-title">
        <Loader pct={pct} appId={ap.appId} />
        <div className="space-y-2.5">
          {phase === "making" ? (
            <p className="mx-auto inline-flex items-center gap-1.5 rounded-full bg-success-soft px-3 py-1 text-footnote font-medium text-success motion-safe:animate-scale-in">
              <Check className="size-3.5" strokeWidth={2.5} aria-hidden />
              Finished studying {name}
            </p>
          ) : null}
          <p className="text-caption font-medium uppercase tracking-[0.08em] text-accent tabular">
            {pct}% · {phase === "studying" ? "Studying your app" : "Making your videos"}
          </p>
          <h1 id="first-run-title" className="text-title-2 font-semibold text-ink text-balance sm:text-title-1">
            {title}
          </h1>
          <p className="mx-auto max-w-lg text-body text-ink-2 text-pretty">{sub}</p>
        </div>

        {/* The current task, in one sentence; it fades in again whenever it changes. */}
        <div className="mx-auto flex max-w-md items-start justify-center gap-3 rounded-2xl bg-mist/70 px-5 py-3.5 text-left" aria-live="polite">
          <span aria-hidden className="mt-1.5 flex size-2 shrink-0 rounded-full bg-accent motion-safe:animate-pulse-dot" />
          <div key={`${cur?.key}-${taskLine}`} className="min-w-0 motion-safe:animate-rise-in">
            <p className="text-body-sm font-medium text-ink text-pretty">{task}</p>
            {taskLine ? (
              <p className="text-footnote text-ink-2 text-pretty">
                {taskLine}
                {jobs ? ` · ${jobs}` : ""}
              </p>
            ) : null}
          </div>
        </div>
      </section>

      {/* The promise. */}
      <section className="space-y-4 rounded-3xl border border-line bg-surface px-6 py-6 text-center shadow-raised" aria-label="We’ll let you know">
        <div className="space-y-1">
          <p className="text-headline font-semibold text-ink">You don’t need to wait here</p>
          <p className="mx-auto max-w-md text-body-sm text-ink-2 text-pretty">
            {phase === "studying" ? "Studying an app properly takes a while." : "Making and checking real videos takes a while."} Close this page whenever you like: your first videos will be waiting on Home for your OK, and nothing is posted without you.
          </p>
          {now ? <p className="text-caption text-ink-3">Started {minutesAgo(ap.createdAt, now)}</p> : null}
        </div>
        <NotifyMe runId={ap.id} />
      </section>

      {needs.length ? (
        <section className="space-y-3" aria-labelledby={`needs-${ap.id}`}>
          <h2 id={`needs-${ap.id}`} className="text-headline font-semibold">
            Needs you
          </h2>
          <NeedsYouList items={needs} />
        </section>
      ) : null}

      {learned.length || ap.hypothesis || ap.audience ? (
        <section className="space-y-4" aria-labelledby="first-run-learned">
          <h2 id="first-run-learned" className="text-headline font-semibold text-ink">
            What Muse has learned so far
          </h2>
          {learned.length ? (
            <ul className="flex flex-wrap gap-2" aria-label="Found so far">
              {learned.map((l) => (
                <li key={l.key} className="inline-flex items-center gap-1.5 rounded-full bg-accent-soft px-3 py-1.5 text-footnote font-medium text-accent-ink motion-safe:animate-scale-in">
                  <Check className="size-3.5" strokeWidth={2.5} aria-hidden />
                  {l.label}
                </li>
              ))}
            </ul>
          ) : null}
          {learnDone ? (
            <p className="text-footnote text-ink-2">
              <Link href={r.brand} className="font-medium text-accent hover:underline">
                Check what we learned
              </Link>
              {" · "}fix anything that’s off and Muse uses your version.
            </p>
          ) : null}
          {ap.hypothesis || ap.audience ? (
            <div className="space-y-1.5 rounded-2xl bg-mist/60 p-5 motion-safe:animate-rise-in">
              <h3 className="text-footnote font-medium text-ink-2">What we’re testing</h3>
              {ap.hypothesis ? <p className="text-body-sm text-ink text-pretty">{ap.hypothesis.statement}</p> : null}
              {ap.audience ? <p className="text-footnote text-ink-2 text-pretty">Who it’s for: {ap.audience.description}</p> : null}
            </div>
          ) : null}
        </section>
      ) : null}

      <QuickSetup appId={ap.appId} source={source} footage={recordingFirst} first />

      <div className="space-y-4 border-t border-line pt-5">
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
          <MadeWith names={madeWith} />
          <button type="button" aria-expanded={showSteps} onClick={() => setShowSteps((o) => !o)} className="inline-flex items-center gap-1 text-footnote font-medium text-accent hover:underline">
            {showSteps ? "Hide the steps" : "Show all steps"}
            <ChevronDown className={cn("size-3.5 transition-transform", showSteps && "rotate-180")} aria-hidden />
          </button>
        </div>
        {showSteps ? <RunSteps detail={detail} className="pt-2" /> : null}
      </div>
    </div>
  );
}

/**
 * Tells the person in this browser (if they asked to be notified) when the first run's videos are
 * ready, or when it stops to ask them something. Fires once, on the change itself, while MuseLaunch
 * is open in some tab; the phone app gets its own push from the server.
 */
export function useFirstRunNotice(detail: AutopilotDetail | undefined, firstRun: boolean, appName: string): void {
  const prev = useRef<{ id: string; first: boolean; status: string; phase: string } | null>(null);
  useEffect(() => {
    if (!detail) return;
    const id = detail.autopilot.id;
    const status = detail.autopilot.status;
    const phase = firstRunPhase(detail.progress.steps);
    const p = prev.current;
    prev.current = { id, first: firstRun, status, phase };
    if (!p || p.id !== id || !p.first) return;
    if (!readFlag(notifyKey(id)) || notificationPermission() !== "granted") return;
    const studied = firstRun && p.phase === "studying" && phase === "making";
    if (studied) {
      try {
        new Notification(`Muse has finished studying ${appName}`, { body: "Now making your first videos. You’ll get one more note when they’re ready.", icon: "/icon.svg", tag: `ml-first-run-studied-${id}` });
      } catch {
        /* notifications unavailable */
      }
      return;
    }
    if (p.status === status) return;
    const ready = !firstRun && status !== "failed" && status !== "cancelled";
    const asks = firstRun && status === "awaiting_user";
    if (!ready && !asks) return;
    const posts = detail.posts.filter((x) => x.status === "awaiting_approval").length;
    const body = ready
      ? posts
        ? `${appName}: ${posts} ${posts === 1 ? "post is" : "posts are"} waiting for your OK.`
        : `${appName}: open MuseLaunch to watch them.`
      : `${appName}: one quick decision, then Muse carries on.`;
    try {
      if (ready) localStorage.removeItem(notifyKey(id));
      const n = new Notification(ready ? "Your first videos are ready" : "Muse needs you for a moment", { body, icon: "/icon.svg", tag: `ml-first-run-${id}` });
      n.onclick = () => {
        window.focus();
        n.close();
      };
    } catch {
      /* notifications unavailable: Home shows it anyway */
    }
  }, [detail, firstRun, appName]);
}
