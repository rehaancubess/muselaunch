"use client";
/**
 * "Always on": Autopilot keeps researching and keeps about a week of posts ready at a pace the plan
 * allows (once a week … every day). Every post still waits for the publish approval in Needs you.
 *
 *  - AlwaysOnSettings: the switch, "How often to post" (paces above the plan are shown but disabled
 *    with the plan that allows them), the weekly credit estimate vs the plan's monthly credits, and
 *    the optional weekly email (only with Gmail connected). Settings → Autopilot and Creator.
 *  - AlwaysOnStatusLine: "Always on · 3 posts a week · next post Thu 7 PM" (+ where the time comes from).
 *  - AlwaysOnWeek: Creator's "This week": the status line and the weekly summary, or the settings
 *    card when it's off.
 *
 * Data: GET/PUT /apps/:appId/always-on (the API checks the pace against the plan and the permissions).
 */
import type { AlwaysOnPace, AlwaysOnPostLine, AlwaysOnStatus, Channel } from "@muselaunch/contracts";
import { Badge, Card, Notice, Skeleton, SourceChip, Switch, cn, useToast } from "@muselaunch/ui";
import { CalendarClock, Check, Lock, Mail, Repeat, Sparkles } from "lucide-react";
import Link from "next/link";
import { useId, useState } from "react";
import { AppIcon } from "@/components/app-icon";
import { api, errorMessage, wsPath } from "@/lib/api";
import { CHANNEL_LABEL } from "@/lib/labels";
import { useApiQuery, useInvalidate } from "@/lib/query";
import { routes } from "@/lib/routes";
import { useWorkspace } from "@/lib/workspace";

const PACE_WORDS: Record<number, string> = { 1: "1 post a week", 3: "3 posts a week", 5: "5 posts a week", 7: "Every day" };
const nf = new Intl.NumberFormat("en-US");

export function useAlwaysOn(workspaceId: string, appId: string | null | undefined) {
  return useApiQuery<AlwaysOnStatus>(appId ? wsPath(workspaceId, `/apps/${appId}/always-on`) : null, { staleTime: 10_000, refetchInterval: 60_000, retry: false });
}

function timeIn(tz: string | undefined) {
  return (iso?: string, withDate = false) =>
    iso ? new Date(iso).toLocaleString("en-US", { weekday: "short", ...(withDate ? { month: "short", day: "numeric" } : {}), hour: "numeric", minute: "2-digit", timeZone: tz || "UTC" }).replace(":00", "") : "";
}

/** Where a post's time comes from, in plain words (never presented as research when it's a suggestion). */
export function basisLabel(b?: AlwaysOnPostLine["timeBasis"]): string | null {
  return b === "your_youtube" ? "based on your YouTube views" : b === "your_results" ? "based on your results" : b === "suggested" ? "suggested time" : null;
}

/** "Always on · 3 posts a week · next post Thu 7 PM (suggested time)". */
export function AlwaysOnStatusLine({ status, className }: { status: AlwaysOnStatus; className?: string }) {
  const { workspace } = useWorkspace();
  const at = timeIn(workspace?.settings.defaultTimezone);
  if (!status.settings.enabled) return null;
  const basis = basisLabel(status.next?.timeBasis);
  return (
    // A span (not a p): it also sits inside link cards.
    <span className={cn("flex flex-wrap items-center gap-x-1.5 gap-y-1 text-footnote text-ink-2", className)}>
      <span className="inline-flex items-center gap-1 font-medium text-ink">
        <span className="size-1.5 rounded-full bg-success" aria-hidden />
        Always on
      </span>
      <span aria-hidden>·</span>
      <span>{PACE_WORDS[status.settings.postsPerWeek]?.replace(/^Every day$/, "every day")}</span>
      <span aria-hidden>·</span>
      {status.next ? (
        <span title={status.next.timeReason}>
          next post {at(status.next.at)}
          {basis ? <span className="text-ink-3"> ({basis})</span> : null}
        </span>
      ) : (
        <span>making the next posts</span>
      )}
    </span>
  );
}

/** "How often to post": every pace, the ones above the plan disabled with the plan that allows them. */
function PacePicker({ status, value, disabled, onChange }: { status: AlwaysOnStatus; value: number; disabled: boolean; onChange: (p: AlwaysOnPace) => void }) {
  const name = useId();
  return (
    <fieldset className="space-y-2.5">
      <legend className="text-body-sm font-medium text-ink">How often to post</legend>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {status.options.map((o) => {
          const on = o.postsPerWeek === value;
          const off = disabled || !o.allowed;
          return (
            <label
              key={o.postsPerWeek}
              className={cn(
                "relative flex min-h-[68px] cursor-pointer flex-col justify-between gap-1 rounded-lg border px-3 py-2.5 transition-colors duration-150 focus-within:shadow-focus",
                on ? "border-accent bg-accent-soft" : "border-line bg-surface hover:border-line-strong",
                off && "cursor-not-allowed",
                !o.allowed && "border-dashed bg-mist/60 hover:border-line",
              )}
            >
              <input type="radio" name={name} value={o.postsPerWeek} checked={on} disabled={off} onChange={() => onChange(o.postsPerWeek)} className="sr-only" />
              <span className="flex items-center justify-between gap-2">
                <span className={cn("text-body-sm font-medium", on ? "text-accent-ink" : o.allowed ? "text-ink" : "text-ink-3")}>{o.label}</span>
                {on ? <Check className="size-3.5 text-accent" aria-hidden /> : !o.allowed ? <Lock className="size-3 text-ink-3" aria-hidden /> : null}
              </span>
              <span className="text-caption text-ink-3">{o.allowed ? `up to ${nf.format(o.weeklyCredits)} credits a week` : `${o.minPlan?.name ?? "A bigger"} plan or higher`}</span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

/**
 * The Always-on setting for one app. Changing it needs editor access (content.write), the same as
 * starting Autopilot; the pace is checked against the plan again by the API.
 */
export function AlwaysOnSettings({ appId, showApp, className }: { appId: string; showApp?: boolean; className?: string }) {
  const { workspaceId, workspace, apps, can } = useWorkspace();
  const toast = useToast();
  const invalidate = useInvalidate();
  const q = useAlwaysOn(workspaceId, appId);
  const [busy, setBusy] = useState<string | null>(null);
  const app = apps.find((a) => a.id === appId);
  const canChange = can("content.write");
  const s = q.data;
  const save = async (key: string, patch: { enabled?: boolean; postsPerWeek?: AlwaysOnPace; emailSummary?: boolean }, done: (r: { status: AlwaysOnStatus; start: { started: boolean; reason?: string } | null }) => [string, string?]) => {
    setBusy(key);
    try {
      const r = await api.put<{ status: AlwaysOnStatus; start: { started: boolean; reason?: string } | null }>(wsPath(workspaceId, `/apps/${appId}/always-on`), patch);
      const [title, body] = done(r);
      toast.success(title, body);
      await invalidate(wsPath(workspaceId, `/apps/${appId}/always-on`), wsPath(workspaceId, `/apps/${appId}/autopilots`), wsPath(workspaceId, "/needs-you"));
    } catch (err) {
      toast.error("Couldn’t save", errorMessage(err));
    } finally {
      setBusy(null);
    }
  };
  if (q.isLoading) return <Skeleton className={cn("h-48 w-full", className)} rounded="xl" />;
  if (!s) return <Notice tone="warning" className={className}>{q.error ? errorMessage(q.error) : "Always on isn’t available right now."}</Notice>;
  const on = s.settings.enabled;
  const pace = s.settings.postsPerWeek;
  const est = s.estimate;
  const toggleId = `ao-${appId}`;
  const emailId = `ao-email-${appId}`;
  return (
    <div className={cn("divide-y divide-line rounded-xl bg-surface shadow-raised", className)}>
      <label className="flex items-start justify-between gap-4 p-5 sm:p-6" htmlFor={toggleId}>
        <span className="flex min-w-0 items-start gap-3">
          {showApp ? <AppIcon app={app} workspaceId={workspaceId} size={36} className="mt-0.5" /> : null}
          <span className="min-w-0 space-y-1">
            <span className="flex flex-wrap items-center gap-2">
              <span className="text-body font-medium text-ink">{showApp && app ? `Always on for ${app.name}` : "Always on"}</span>
              {on ? <Badge tone="success">On</Badge> : null}
            </span>
            <span className="block text-footnote text-ink-2 text-pretty">
              Autopilot keeps going: it researches every week, makes new videos when the coming week runs short and tells you what to post and when. Every post still waits for your approval.
            </span>
            {on ? <AlwaysOnStatusLine status={s} className="pt-1" /> : null}
          </span>
        </span>
        <Switch
          id={toggleId}
          label="Always on"
          checked={on}
          disabled={!canChange || busy !== null}
          onCheckedChange={(v) =>
            void save("enabled", v ? { enabled: true, postsPerWeek: pace } : { enabled: false }, (r) =>
              v
                ? r.start?.reason
                  ? ["Always on is on, waiting for credits", r.start.reason]
                  : ["Always on is on", `Aiming for ${PACE_WORDS[pace]?.toLowerCase()}. You approve every post in Needs you.`]
                : ["Always on is off", "The current run finishes; nothing new starts on its own."],
            )
          }
        />
      </label>

      <div className="space-y-4 p-5 sm:p-6">
        <PacePicker
          status={s}
          value={pace}
          disabled={!canChange || busy !== null}
          onChange={(p) => void save("pace", { postsPerWeek: p }, () => [`${PACE_WORDS[p]} it is`, on ? "From the next round of videos." : undefined])}
        />
        {s.requestedPostsPerWeek ? (
          <Notice tone="warning">
            Your {s.plan.name} plan allows up to {PACE_WORDS[s.plan.postsPerWeek]?.toLowerCase()}, so Always on uses that instead of {PACE_WORDS[s.requestedPostsPerWeek]?.toLowerCase()}.
          </Notice>
        ) : null}
        <div className="flex flex-col gap-1 rounded-lg bg-mist/70 px-4 py-3 text-footnote text-ink-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
          <span className="text-pretty">
            Up to about <span className="font-medium text-ink tabular">{nf.format(est.weeklyCredits)}</span> credits a week (about {nf.format(est.monthlyCredits)} a month): {pace === 1 ? "one video" : `${pace} videos`} at up to {nf.format(est.perVideo)} each, plus {nf.format(est.sweep)} for the weekly research.
          </span>
          <span className={cn("shrink-0 font-medium", est.fitsPlan ? "text-success" : "text-warning")}>
            {est.fitsPlan ? `Fits your ${s.plan.name} plan (${nf.format(s.plan.monthlyCredits)} a month)` : `More than your ${s.plan.name} plan’s ${nf.format(s.plan.monthlyCredits)} a month`}
          </span>
        </div>
        {!est.fitsPlan ? (
          <p className="text-footnote text-ink-2 text-pretty">
            Always on never spends past what you have: when credits run short it stops and asks you in Needs you, with a lower pace or more credits.{" "}
            <Link href={routes.settings.credits(workspaceId)} className="font-medium text-accent hover:underline">
              Credits & billing
            </Link>
          </p>
        ) : null}
        {on ? (
          <p className="text-footnote text-ink-3">
            This week: {nf.format(s.week.used)} of {nf.format(s.week.allowance)} credits used · {nf.format(Math.max(0, s.available))} left in the workspace
          </p>
        ) : null}
        {!canChange ? <p className="text-footnote text-ink-3">Only editors, admins and owners can change this.</p> : null}
      </div>

      <label className="flex items-start justify-between gap-4 p-5 sm:p-6" htmlFor={emailId}>
        <span className="flex min-w-0 items-start gap-3">
          <Mail className="mt-0.5 size-4 shrink-0 text-ink-3" aria-hidden />
          <span className="min-w-0 space-y-1">
            <span className="block text-body-sm font-medium text-ink">Email me the weekly summary</span>
            <span className="block text-footnote text-ink-2 text-pretty">
              {s.gmail.connected ? (
                <>
                  Once a week, from your connected Gmail ({s.gmail.address}) to that same address: what was posted, what’s ready, what research found and what needs you. Off unless you turn it on.
                  {s.gmail.lastSentAt ? ` Last sent ${new Date(s.gmail.lastSentAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}.` : ""}
                </>
              ) : (
                <>
                  Needs Gmail:{" "}
                  <Link href={routes.settings.integrations(workspaceId)} className="font-medium text-accent hover:underline">
                    connect it in Integrations
                  </Link>
                  . The summary is always in Create → Make too.
                </>
              )}
            </span>
            {s.gmail.lastError ? <span className="block text-footnote text-warning">{s.gmail.lastError}</span> : null}
          </span>
        </span>
        <Switch
          id={emailId}
          label="Email me the weekly summary"
          checked={s.settings.emailSummary}
          disabled={!canChange || busy !== null || (!s.gmail.connected && !s.settings.emailSummary)}
          onCheckedChange={(v) => void save("email", { emailSummary: v }, () => (v ? ["Weekly email on", `From and to ${s.gmail.address ?? "your Gmail"}.`] : ["Weekly email off"]))}
        />
      </label>
      {workspace && !(workspace.settings.autopilot?.enabled ?? true) ? (
        <p className="px-5 py-4 text-footnote text-ink-3 sm:px-6">New apps don’t start Autopilot on their own in this workspace, but Always on works for this app once it’s on.</p>
      ) : null}
    </div>
  );
}

function PostRow({ line, tz, past }: { line: AlwaysOnPostLine; tz?: string; past?: boolean }) {
  const basis = past ? null : basisLabel(line.timeBasis);
  const d = line.at ? new Date(line.at) : null;
  const opts = { timeZone: tz || "UTC" };
  return (
    <li className="flex items-start gap-3 py-2.5">
      <span className="flex w-[72px] shrink-0 flex-col tabular">
        <span className="text-footnote font-medium text-ink">{d ? d.toLocaleDateString("en-US", { ...opts, weekday: "short", month: "short", day: "numeric" }).replace(",", "") : "No time"}</span>
        <span className="text-caption text-ink-3">{d ? d.toLocaleTimeString("en-US", { ...opts, hour: "numeric", minute: "2-digit" }).replace(":00", "") : ""}</span>
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-body-sm text-ink">{line.title || "Untitled post"}</span>
        <span className="block text-caption text-ink-3">
          {CHANNEL_LABEL[line.channel as Channel] ?? line.channel}
          {past ? (line.url ? " · posted" : " · marked as posted") : line.status === "awaiting_approval" ? " · waiting for your approval" : " · approved"}
          {basis ? <span title={line.timeReason}> · {basis}</span> : null}
        </span>
      </span>
    </li>
  );
}

/**
 * Creator's "This week" for an always-on app: what was posted, what's ready, what research found,
 * what needs you. `show`: render only while Always on is on (the summary, near the top) or only while
 * it's off (the "Keep it going" settings card, below the run).
 */
export function AlwaysOnWeek({ appId, show, className }: { appId: string; show: "on" | "off"; className?: string }) {
  const { workspaceId, workspace } = useWorkspace();
  const q = useAlwaysOn(workspaceId, appId);
  const s = q.data;
  if (q.isLoading) return show === "on" ? null : <Skeleton className="h-40 w-full" rounded="xl" />;
  if (!s || s.settings.enabled !== (show === "on")) return null;
  if (!s.settings.enabled) {
    return (
      <section className={cn("space-y-3", className)} aria-labelledby="always-on-off">
        <div className="space-y-0.5">
          <h2 id="always-on-off" className="flex items-center gap-2 text-headline font-semibold">
            <Repeat className="size-4 text-accent" aria-hidden />
            Keep it going
          </h2>
          <p className="text-footnote text-ink-2">Turn on Always on and Autopilot keeps researching and keeps a week of posts ready for you to approve.</p>
        </div>
        <AlwaysOnSettings appId={appId} />
      </section>
    );
  }
  const tz = workspace?.settings.defaultTimezone;
  const w = s.summary;
  const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: tz || "UTC" });
  const stats = [
    { label: "Posted", value: w.posted.length, hint: "last 7 days" },
    { label: "Ready", value: s.queue.upcoming, hint: `of ${s.queue.target} for the week` },
    { label: "Research", value: w.research.findings, hint: "sourced findings" },
    { label: "Waiting on you", value: w.needsYou, hint: w.needsYou ? "decisions" : "all clear", warn: w.needsYou > 0 },
  ];
  return (
    <section className={cn("space-y-4", className)} aria-labelledby="always-on-week">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="space-y-1">
          <h2 id="always-on-week" className="text-headline font-semibold">
            This week
          </h2>
          <AlwaysOnStatusLine status={s} />
        </div>
        <Link href={`${routes.settings.workspace(workspaceId)}#always-on`} className="text-footnote font-medium text-accent hover:underline">
          Change pace
        </Link>
      </div>
      <Card padding="none" className="overflow-hidden">
        <dl className="grid grid-cols-2 gap-px border-b border-line bg-line sm:grid-cols-4">
          {stats.map((x) => (
            <div key={x.label} className="space-y-0.5 bg-surface px-4 py-3.5 sm:px-5">
              <dt className="text-caption text-ink-3">{x.label}</dt>
              <dd className={cn("text-title-3 font-semibold tabular", x.warn ? "text-warning" : "text-ink")}>{x.value}</dd>
              <dd className="text-caption text-ink-3">{x.hint}</dd>
            </div>
          ))}
        </dl>
        <div className="grid grid-cols-1 gap-0 md:grid-cols-2 md:divide-x md:divide-line">
          <div className="space-y-1 px-4 py-4 sm:px-5">
            <h3 className="flex items-center gap-1.5 text-footnote font-semibold text-ink">
              <CalendarClock className="size-3.5 text-ink-3" aria-hidden />
              Ready for the coming week
            </h3>
            {w.queued.length ? (
              <ul className="divide-y divide-line">
                {w.queued.slice(0, 5).map((x) => (
                  <PostRow key={x.postId} line={x} tz={tz} />
                ))}
              </ul>
            ) : (
              <p className="py-2 text-footnote text-ink-2">Autopilot is making the next posts.</p>
            )}
            {w.posted.length ? (
              <>
                <h3 className="pt-3 text-footnote font-semibold text-ink">Posted</h3>
                <ul className="divide-y divide-line">
                  {w.posted.slice(-3).map((x) => (
                    <PostRow key={x.postId} line={x} tz={tz} past />
                  ))}
                </ul>
              </>
            ) : null}
          </div>
          <div className="space-y-2 border-t border-line px-4 py-4 sm:px-5 md:border-t-0">
            <h3 className="flex items-center gap-1.5 text-footnote font-semibold text-ink">
              <Sparkles className="size-3.5 text-ink-3" aria-hidden />
              What research found{w.research.at ? <span className="font-normal text-ink-3"> · {day(w.research.at)}</span> : null}
            </h3>
            {w.research.top.length ? (
              <ul className="space-y-3">
                {w.research.top.map((f) => (
                  <li key={f.id} className="space-y-1.5">
                    <p className="text-body-sm text-ink text-pretty">{f.statement}</p>
                    <div className="flex flex-wrap gap-1.5">
                      {f.sources.map((src, i) => (
                        <SourceChip key={`${f.id}-${i}`} source={src} compact />
                      ))}
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-footnote text-ink-2">{s.sweep.status === "running" ? "Muse Wonder is researching this week’s news now." : (s.sweep.note ?? "This week’s research runs soon.")}</p>
            )}
            {w.suggestions.filter((x) => x.status === "pending").length ? (
              <p className="pt-1 text-footnote text-ink-2">
                {w.suggestions.filter((x) => x.status === "pending").length} video idea{w.suggestions.filter((x) => x.status === "pending").length === 1 ? "" : "s"} from it wait{w.suggestions.filter((x) => x.status === "pending").length === 1 ? "s" : ""} in{" "}
                <Link href={routes.needsYou(workspaceId, appId)} className="font-medium text-accent hover:underline">
                  Needs you
                </Link>
                .
              </p>
            ) : null}
          </div>
        </div>
        <p className="border-t border-line bg-mist/50 px-4 py-2.5 text-caption text-ink-3 sm:px-5">
          Credits this week: {nf.format(w.credits.used)} of up to {nf.format(w.credits.allowance)}. Times marked “suggested” are common starting points, not your data.
        </p>
      </Card>
      {s.notes.length ? (
        <ul className="space-y-1">
          {s.notes.slice(0, 3).map((n) => (
            <li key={n} className="text-footnote text-ink-2">
              {n}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
