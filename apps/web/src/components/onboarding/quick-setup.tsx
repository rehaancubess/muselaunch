"use client";
/**
 * Quick setup: three light questions answered while Autopilot works on the first run (it never waits
 * for them). Shown on the app's first run's progress screen, to members who can change content, until
 * it's finished or dismissed (per app, stored on the app: PUT /apps/:appId/quick-setup).
 *
 *  1. Your app's footage: only when the app has no screenshots or recordings (e.g. added from its
 *     website): the existing screen-recording card (RecordingFirst).
 *  2. Where do you post?: the platforms (WherePostPicker; available ones start the connect flow).
 *  3. How often?: the Always on pace (PUT /apps/:appId/always-on), the plan's suggestion picked;
 *     paces above the plan are shown but disabled with the plan that allows them. "Not now" leaves it off.
 *
 * Every step has Skip and the card can be closed. When the quick setup isn't showing, this renders
 * exactly what the progress screen showed before (the recording card when footage is missing).
 */
import type { AlwaysOnPace, App, AutopilotProgress } from "@muselaunch/contracts";
import { Button, Notice, Skeleton, cn, useToast } from "@muselaunch/ui";
import { Check, Lock, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useId, useState, type ReactNode } from "react";
import { useAlwaysOn } from "@/features/autopilot/always-on";
import { RecordingFirst, useRecordingState } from "@/features/autopilot/media-ask";
import { PLATFORM_LABEL, suggestedPace } from "@/features/publishing/posting-lines";
import { useConnectionReturn, WherePostPicker } from "@/features/publishing/where-you-post";
import { api, errorMessage, wsPath } from "@/lib/api";
import type { Page } from "@/lib/api-types";
import { useInvalidate, useQueryClient } from "@/lib/query";
import { routes } from "@/lib/routes";
import { useWorkspace } from "@/lib/workspace";

type StepKey = "footage" | "post" | "pace";
const STEP_NAME: Record<StepKey, string> = { footage: "Your app’s footage", post: "Where you post", pace: "How often" };
const nf = new Intl.NumberFormat("en-US");

/** Survives the trip to a platform's sign-in and back (per app, this tab only). */
const stepKey = (appId: string) => `ml.quickSetup.step.${appId}`;
function readStep(appId: string): StepKey | null {
  try {
    const v = window.sessionStorage.getItem(stepKey(appId));
    return v === "footage" || v === "post" || v === "pace" ? v : null;
  } catch {
    return null;
  }
}
function writeStep(appId: string, step: StepKey | null) {
  try {
    if (step) window.sessionStorage.setItem(stepKey(appId), step);
    else window.sessionStorage.removeItem(stepKey(appId));
  } catch {
    /* private mode: the quick setup just starts from the top again */
  }
}

/**
 * On the progress screen in place of the recording card: `footage` is whether that card would show
 * (no screenshots or recordings yet), `first` whether this is the app's first run.
 */
export function QuickSetup({ appId, source, footage, first }: { appId: string; source: AutopilotProgress["source"]; footage: boolean; first: boolean }) {
  const { apps, can, appsLoading } = useWorkspace();
  const app = apps.find((a) => a.id === appId);
  // A connect flow started from step 2 comes back here: finish it on this page.
  useConnectionReturn();
  const [closed, setClosed] = useState(false);
  const [finished, setFinished] = useState<string | null>(null);
  const offer = first && can("content.write") && Boolean(app) && !app?.quickSetup && !closed;
  const fallback = footage ? <RecordingFirst appId={appId} source={source} /> : null;
  if (finished)
    return (
      <div className="space-y-8">
        <AllSet summary={finished} onClose={() => setFinished(null)} />
        {fallback}
      </div>
    );
  if (appsLoading || !offer || !app) return fallback;
  return (
    <QuickSetupCard
      app={app}
      source={source}
      footage={footage}
      onClosed={() => setClosed(true)}
      onFinished={(summary) => {
        setClosed(true);
        setFinished(summary);
      }}
    />
  );
}

function AllSet({ summary, onClose }: { summary: string; onClose: () => void }) {
  const { workspaceId } = useWorkspace();
  return (
    <section aria-label="Quick setup done" className="flex items-start gap-3 rounded-2xl bg-success-soft/60 p-4 sm:p-5">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-success text-white">
        <Check className="size-4" strokeWidth={3} aria-hidden />
      </span>
      <div className="min-w-0 flex-1 space-y-0.5 pt-0.5">
        <p className="text-body-sm font-medium text-ink">You’re all set</p>
        <p className="text-footnote text-ink-2 text-pretty">
          {summary} Change it any time in{" "}
          <Link href={routes.settings.workspace(workspaceId)} className="font-medium text-accent hover:underline">
            Settings
          </Link>
          .
        </p>
      </div>
      <button type="button" onClick={onClose} aria-label="Close" className="-mr-1 -mt-1 inline-flex size-11 shrink-0 items-center justify-center rounded-full text-ink-2 hover:bg-mist hover:text-ink focus-visible:outline-none focus-visible:shadow-focus">
        <X className="size-4" aria-hidden />
      </button>
    </section>
  );
}

function QuickSetupCard({ app, source, footage, onClosed, onFinished }: { app: App; source: AutopilotProgress["source"]; footage: boolean; onClosed: () => void; onFinished: (summary: string) => void }) {
  const { workspaceId } = useWorkspace();
  const toast = useToast();
  const qc = useQueryClient();
  const steps: StepKey[] = footage ? ["footage", "post", "pace"] : ["post", "pace"];
  const [current, setCurrent] = useState<StepKey>(() => readStep(app.id) ?? steps[0]!);
  // The footage step goes away once the run has what it needs (or asks in Needs you instead).
  const step: StepKey = steps.includes(current) ? current : "post";
  const at = steps.indexOf(step);
  useEffect(() => writeStep(app.id, step), [app.id, step]);
  const titleId = useId();

  const mark = async (status: "done" | "dismissed") => {
    writeStep(app.id, null);
    try {
      const r = await api.put<{ app: App }>(wsPath(workspaceId, `/apps/${app.id}/quick-setup`), { status });
      qc.setQueryData<Page<App>>([wsPath(workspaceId, "/apps")], (old) => (old ? { ...old, items: old.items.map((a) => (a.id === r.app.id ? r.app : a)) } : old));
    } catch (e) {
      // Not saved: it may be offered again next time, which is harmless.
      toast.error("Couldn’t save that", errorMessage(e));
    }
  };
  const next = () => {
    const n = steps[at + 1];
    if (n) setCurrent(n);
  };
  const finish = (pace: AlwaysOnPace | null) => {
    const where = (() => {
      const c = qc.getQueryData<Page<App>>([wsPath(workspaceId, "/apps")])?.items.find((a) => a.id === app.id)?.postTo;
      if (!c) return null;
      if (c.manual) return "You’ll post the videos yourself.";
      return c.channels.length ? `Posts are drafted for ${c.channels.map((x) => PLATFORM_LABEL[x]).join(", ")}.` : null;
    })();
    const often = pace ? `Always on keeps ${pace === 7 ? "a post a day" : `${pace} post${pace === 1 ? "" : "s"} a week`} ready for your OK.` : "Always on stays off for now.";
    void mark("done");
    onFinished([where, often].filter(Boolean).join(" "));
  };

  return (
    <section aria-labelledby={titleId} className="space-y-5 rounded-2xl bg-surface p-5 shadow-raised ring-1 ring-accent/25 sm:p-6">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1 space-y-1.5">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-footnote font-medium text-ink-2">
            <span className="text-accent-ink">Quick setup</span>
            <span aria-hidden className="text-ink-3">·</span>
            <span>
              {at + 1} of {steps.length}
            </span>
            <span className="flex items-center gap-1" aria-hidden>
              {steps.map((s, i) => (
                <span key={s} className={cn("h-1.5 rounded-full transition-all duration-200", i === at ? "w-4 bg-accent" : i < at ? "w-1.5 bg-accent/60" : "w-1.5 bg-line-strong")} />
              ))}
            </span>
          </p>
          {step !== "footage" ? (
            <h2 id={titleId} className="text-title-3 font-semibold text-ink text-balance">
              {step === "post" ? "Where do you post?" : "How often should Muse post?"}
            </h2>
          ) : (
            <h2 id={titleId} className="sr-only">
              {STEP_NAME.footage}
            </h2>
          )}
          {step === "post" ? <p className="text-body-sm text-ink-2 text-pretty">Pick where you share videos. Autopilot keeps working meanwhile, and nothing is posted without your OK.</p> : null}
          {step === "pace" ? <p className="text-body-sm text-ink-2 text-pretty">Always on keeps about a week of posts ready. You approve each one.</p> : null}
        </div>
        <button
          type="button"
          onClick={() => {
            void mark("dismissed");
            onClosed();
          }}
          aria-label="Close quick setup"
          title="Close quick setup"
          className="-mr-2 -mt-2 inline-flex size-11 shrink-0 items-center justify-center rounded-full text-ink-2 transition-colors hover:bg-mist hover:text-ink focus-visible:outline-none focus-visible:shadow-focus"
        >
          <X className="size-5" aria-hidden />
        </button>
      </div>

      {step === "footage" ? <FootageStep app={app} source={source} onNext={next} /> : null}
      {step === "post" ? <PostStep app={app} onNext={next} /> : null}
      {step === "pace" ? <PaceStep app={app} onDone={finish} /> : null}
    </section>
  );
}

function Actions({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2 pt-1">{children}</div>;
}

function FootageStep({ app, source, onNext }: { app: App; source: AutopilotProgress["source"]; onNext: () => void }) {
  const { workspaceId } = useWorkspace();
  const rec = useRecordingState(workspaceId, app.id);
  const has = rec.state === "processing" || rec.state === "ready";
  if (rec.loading) return <Skeleton className="h-48 w-full" rounded="xl" />;
  return (
    <div className="space-y-4">
      {/* The existing recording card, without its own frame (it's inside this one). */}
      <div className="[&>section]:rounded-none [&>section]:bg-transparent [&>section]:p-0 [&>section]:shadow-none [&>section]:ring-0">
        <RecordingFirst appId={app.id} source={source} />
      </div>
      <Actions>
        {has ? (
          <Button size="lg" onClick={onNext}>
            Next
          </Button>
        ) : null}
        <Button size="lg" variant="ghost" onClick={onNext}>
          {has ? "Skip" : "Skip for now"}
        </Button>
      </Actions>
    </div>
  );
}

function PostStep({ app, onNext }: { app: App; onNext: () => void }) {
  const chosen = Boolean(app.postTo && (app.postTo.manual || app.postTo.channels.length));
  return (
    <div className="space-y-4">
      <WherePostPicker app={app} back="autopilot" beforeConnect={() => writeStep(app.id, "post")} />
      <Actions>
        {chosen ? (
          <Button size="lg" onClick={onNext}>
            Next
          </Button>
        ) : null}
        <Button size="lg" variant="ghost" onClick={onNext}>
          Skip
        </Button>
      </Actions>
    </div>
  );
}

function PaceStep({ app, onDone }: { app: App; onDone: (pace: AlwaysOnPace | null) => void }) {
  const { workspaceId } = useWorkspace();
  const toast = useToast();
  const invalidate = useInvalidate();
  const q = useAlwaysOn(workspaceId, app.id);
  const s = q.data;
  const [pick, setPick] = useState<AlwaysOnPace | null>(null);
  const [busy, setBusy] = useState(false);
  const name = useId();
  if (q.isLoading) return <Skeleton className="h-40 w-full" rounded="xl" />;
  if (!s) {
    return (
      <div className="space-y-4">
        <Notice tone="warning">{q.error ? errorMessage(q.error) : "Always on isn’t available right now."} You can set it later in Settings.</Notice>
        <Actions>
          <Button size="lg" variant="ghost" onClick={() => onDone(null)}>
            Skip
          </Button>
        </Actions>
      </div>
    );
  }
  const pace: AlwaysOnPace = pick ?? (s.settings.enabled ? s.settings.postsPerWeek : suggestedPace(s));
  const option = s.options.find((o) => o.postsPerWeek === pace);
  const monthly = option ? Math.round((option.weeklyCredits * 30) / 7) : 0;
  const fits = monthly <= s.plan.monthlyCredits;
  const turnOn = async () => {
    setBusy(true);
    try {
      const r = await api.put<{ start: { started: boolean; reason?: string } | null }>(wsPath(workspaceId, `/apps/${app.id}/always-on`), { enabled: true, postsPerWeek: pace });
      if (r.start?.reason) toast.toast({ title: "Always on is on, waiting for credits", description: r.start.reason, tone: "neutral" });
      await invalidate(wsPath(workspaceId, `/apps/${app.id}/always-on`), wsPath(workspaceId, "/needs-you"));
      onDone(pace);
    } catch (e) {
      toast.error("Couldn’t turn on Always on", errorMessage(e));
      setBusy(false);
    }
  };
  return (
    <div className="space-y-4">
      <fieldset>
        <legend className="sr-only">How often to post</legend>
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
          {s.options.map((o) => {
            const on = o.postsPerWeek === pace;
            return (
              <label
                key={o.postsPerWeek}
                className={cn(
                  "relative flex min-h-[72px] cursor-pointer flex-col justify-between gap-1 rounded-xl border px-3.5 py-3 transition-colors duration-150 focus-within:shadow-focus",
                  on ? "border-accent bg-accent-soft" : "border-line bg-surface hover:border-line-strong",
                  !o.allowed && "cursor-not-allowed border-dashed bg-mist/60 hover:border-line",
                )}
              >
                <input type="radio" name={name} value={o.postsPerWeek} checked={on} disabled={!o.allowed || busy} onChange={() => setPick(o.postsPerWeek)} className="sr-only" />
                <span className="flex items-center justify-between gap-2">
                  <span className={cn("text-body-sm font-medium", on ? "text-accent-ink" : o.allowed ? "text-ink" : "text-ink-3")}>{o.label}</span>
                  {on ? <Check className="size-4 text-accent" aria-hidden /> : !o.allowed ? <Lock className="size-3.5 text-ink-3" aria-hidden /> : null}
                </span>
                <span className="text-caption text-ink-3">{o.allowed ? (o.postsPerWeek === suggestedPace(s) ? "Suggested for your plan" : `${s.plan.name} plan`) : `Needs ${o.minPlan?.name ?? "a bigger"} plan`}</span>
              </label>
            );
          })}
        </div>
      </fieldset>
      {option ? (
        <p className={cn("text-footnote text-pretty", fits ? "text-ink-2" : "text-warning")}>
          {fits
            ? `Up to about ${nf.format(option.weeklyCredits)} credits a week, within your ${s.plan.name} plan’s ${nf.format(s.plan.monthlyCredits)} a month.`
            : `Up to about ${nf.format(option.weeklyCredits)} credits a week, more than your ${s.plan.name} plan’s ${nf.format(s.plan.monthlyCredits)} a month: Muse asks before it runs out.`}
        </p>
      ) : null}
      <Actions>
        <Button size="lg" loading={busy} onClick={() => void turnOn()}>
          {s.settings.enabled ? "Keep this pace" : "Turn on"}
        </Button>
        <Button size="lg" variant="ghost" disabled={busy} onClick={() => onDone(s.settings.enabled ? s.settings.postsPerWeek : null)}>
          Not now
        </Button>
      </Actions>
    </div>
  );
}
