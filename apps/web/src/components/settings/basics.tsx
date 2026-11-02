"use client";
/**
 * Settings, short: "The basics" for the current app (one row, one control each) and "More settings"
 * (every other setting, unchanged, in sections that open on tap).
 *
 *  - Posting pace: Always on (PUT /apps/:appId/always-on): Off, or a pace the plan allows.
 *  - Where you post: "Where do you post?" + connected accounts, honest availability (a sheet).
 *  - AI voice: off, or the built-in voice it speaks with (PATCH /sound/settings; billing.manage).
 *  - Plan & credits: the plan and credits left, Upgrade on the billing page.
 */
import type { AlwaysOnPace, App } from "@muselaunch/contracts";
import { DEFAULT_SOUND_SETTINGS } from "@muselaunch/contracts";
import { Button, Select, Sheet, Skeleton, cn, useToast } from "@muselaunch/ui";
import { ChevronDown, ChevronRight } from "lucide-react";
import Link from "next/link";
import { useEffect, useId, useState, type ReactNode } from "react";
import { AppIcon } from "@/components/app-icon";
import { readLastApp } from "@/components/shell/app-shell";
import { useAlwaysOn } from "@/features/autopilot/always-on";
import { ConnectedPostingAccounts, platformStates, useConnectionReturn, useConnections, WherePostPicker, wherePostSummary } from "@/features/publishing/where-you-post";
import { api, errorMessage, wsPath } from "@/lib/api";
import type { CreditsResponse } from "@/lib/api-types";
import { useApiQuery, useInvalidate } from "@/lib/query";
import { routes } from "@/lib/routes";
import { useWorkspace } from "@/lib/workspace";

const nf = new Intl.NumberFormat("en-US");
export const TTS_VOICES = ["alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse", "marin", "cedar"];
const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);

/** One basic setting: what it is and its state on the left, its one control on the right (below on phones). */
function Row({ title, detail, control, labelFor }: { title: string; detail: ReactNode; control: ReactNode; labelFor?: string }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-3 p-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-6 sm:px-5 sm:py-4">
      <div className="min-w-0 space-y-0.5">
        {labelFor ? (
          <label htmlFor={labelFor} className="block text-body font-medium text-ink">
            {title}
          </label>
        ) : (
          <p className="text-body font-medium text-ink">{title}</p>
        )}
        <div className="text-footnote text-ink-2 text-pretty">{detail}</div>
      </div>
      <div className="flex min-w-0 flex-col sm:flex-row sm:justify-end">{control}</div>
    </div>
  );
}

function PaceRow({ app }: { app: App }) {
  const { workspaceId, can } = useWorkspace();
  const toast = useToast();
  const invalidate = useInvalidate();
  const q = useAlwaysOn(workspaceId, app.id);
  const [busy, setBusy] = useState(false);
  const id = useId();
  const s = q.data;
  if (q.isLoading) return <Row title="Posting pace" detail="Checking…" control={<Skeleton className="h-11 w-full sm:w-52" rounded="lg" />} />;
  if (!s) return <Row title="Posting pace" detail={q.error ? errorMessage(q.error) : "Not available right now."} control={null} />;
  const on = s.settings.enabled;
  const value = on ? String(s.settings.postsPerWeek) : "off";
  const change = async (v: string) => {
    setBusy(true);
    try {
      const patch = v === "off" ? { enabled: false } : { enabled: true, postsPerWeek: Number(v) as AlwaysOnPace };
      const r = await api.put<{ start: { started: boolean; reason?: string } | null }>(wsPath(workspaceId, `/apps/${app.id}/always-on`), patch);
      toast.success(v === "off" ? "Always on is off" : `Always on: ${s.options.find((o) => String(o.postsPerWeek) === v)?.label.toLowerCase()}`, v === "off" ? "The current run finishes; nothing new starts on its own." : (r.start?.reason ?? "You approve every post in Needs you."));
      await invalidate(wsPath(workspaceId, `/apps/${app.id}/always-on`), wsPath(workspaceId, `/apps/${app.id}/autopilots`), wsPath(workspaceId, "/needs-you"));
    } catch (e) {
      toast.error("Couldn’t change the pace", errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const est = on ? s.estimate.weeklyCredits : null;
  return (
    <Row
      title="Posting pace"
      labelFor={id}
      detail={on ? `Always on keeps a week of posts ready, up to about ${nf.format(est ?? 0)} credits a week. You approve each post.` : "Off. Turn it on and Muse keeps a week of posts ready for your OK."}
      control={
        <Select
          id={id}
          selectSize="lg"
          className="w-full sm:w-56"
          value={value}
          disabled={!can("content.write") || busy}
          onChange={(e) => void change(e.target.value)}
          options={[{ value: "off", label: "Off" }, ...s.options.map((o) => ({ value: String(o.postsPerWeek), label: o.allowed ? o.label : `${o.label} (${o.minPlan?.name ?? "bigger"} plan)`, disabled: !o.allowed }))]}
        />
      }
    />
  );
}

function WhereRow({ app }: { app: App }) {
  const { workspaceId } = useWorkspace();
  const q = useConnections(workspaceId);
  const [open, setOpen] = useState(false);
  const states = platformStates(q.data, app.id);
  return (
    <>
      <Row
        title="Where you post"
        detail={q.isLoading ? "Checking…" : wherePostSummary(app, states)}
        control={
          <Button size="lg" variant="secondary" className="w-full sm:w-auto" onClick={() => setOpen(true)}>
            Change
          </Button>
        }
      />
      <Sheet open={open} onOpenChange={setOpen} title="Where you post" description={`For ${app.name}. Nothing is posted without your OK.`} width="max-w-lg">
        <div className="space-y-6 p-5">
          <WherePostPicker app={app} back="settings" narrow />
          <ConnectedPostingAccounts appId={app.id} />
          <p className="text-footnote text-ink-3">
            Every service, with what it can and can’t do here:{" "}
            <Link href={routes.settings.integrations(workspaceId)} className="font-medium text-accent hover:underline">
              Integrations
            </Link>
            .
          </p>
        </div>
      </Sheet>
    </>
  );
}

function VoiceRow() {
  const { workspace, workspaceId, can, refetch } = useWorkspace();
  const toast = useToast();
  const invalidate = useInvalidate();
  const [busy, setBusy] = useState(false);
  const id = useId();
  const raw = (workspace?.settings as { sound?: { aiVoiceover?: boolean; voice?: string } } | undefined)?.sound;
  const on = raw?.aiVoiceover ?? DEFAULT_SOUND_SETTINGS.aiVoiceover;
  const voice = raw?.voice ?? "marin";
  // Turning it on spends credits on every narrated video: billing.manage (the API checks it too).
  const allowed = can("workspace.manage") && can("billing.manage");
  const change = async (v: string) => {
    setBusy(true);
    try {
      await api.patch(wsPath(workspaceId, "/sound/settings"), v === "off" ? { aiVoiceover: false } : { aiVoiceover: true, voice: v });
      refetch();
      await invalidate("/v1/me", wsPath(workspaceId));
      toast.success(v === "off" ? "AI voice off" : `AI voice on: ${cap(v)}`, v === "off" ? "New videos use captions and music only." : "For new videos with narration.");
    } catch (e) {
      toast.error("Couldn’t save", errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Row
      title="AI voice"
      labelFor={id}
      detail={`${on ? `Narrates new videos in the ${cap(voice)} voice, labelled as AI.` : "Off. Videos use captions and music."} Uses credits per narrated video.${allowed ? "" : " Only owners and admins can change this."}`}
      control={<Select id={id} selectSize="lg" className="w-full sm:w-56" value={on ? voice : "off"} disabled={!allowed || busy} onChange={(e) => void change(e.target.value)} options={[{ value: "off", label: "Off" }, ...TTS_VOICES.map((v) => ({ value: v, label: `On: ${cap(v)}` }))]} />}
    />
  );
}

function PlanRow() {
  const { workspaceId } = useWorkspace();
  const q = useApiQuery<CreditsResponse>(wsPath(workspaceId, "/billing/credits"), { staleTime: 30_000 });
  const d = q.data;
  return (
    <Row
      title="Plan & credits"
      detail={d ? `${d.plan.name} plan · ${nf.format(d.balance.available)} credits left${d.balance.reserved ? ` (${nf.format(d.balance.reserved)} held for running work)` : ""}` : q.error ? errorMessage(q.error) : "Checking…"}
      control={
        <Button size="lg" variant="secondary" className="w-full sm:w-auto" asChild>
          <Link href={routes.settings.credits(workspaceId)}>Upgrade or top up</Link>
        </Button>
      }
    />
  );
}

/** The current app: the one last opened in this browser, else the first. */
function useBasicsApp(): [App | undefined, (id: string) => void, App[]] {
  const { workspaceId, apps } = useWorkspace();
  const live = apps.filter((a) => a.status !== "archived");
  const [picked, setPicked] = useState<string | null>(null);
  useEffect(() => setPicked((p) => p ?? readLastApp(workspaceId)), [workspaceId]);
  return [live.find((a) => a.id === picked) ?? live[0], setPicked, live];
}

export function TheBasics() {
  const { workspaceId } = useWorkspace();
  // A connect flow started from "Where you post" comes back to this page: finish it here.
  useConnectionReturn();
  const [app, pick, live] = useBasicsApp();
  const appSelect = useId();
  return (
    <section aria-labelledby="the-basics" className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 space-y-0.5">
          <h2 id="the-basics" className="text-headline font-semibold">
            The basics
          </h2>
          <p className="text-body-sm text-ink-2 text-pretty">{app ? `For ${app.name}. Nothing is posted without your OK.` : "Nothing is posted without your OK."}</p>
        </div>
        {live.length > 1 && app ? (
          <div className="flex items-center gap-2">
            <AppIcon app={app} workspaceId={workspaceId} size={28} />
            <label htmlFor={appSelect} className="sr-only">
              App
            </label>
            <Select id={appSelect} selectSize="lg" className="w-48" value={app.id} onChange={(e) => pick(e.target.value)} options={live.map((a) => ({ value: a.id, label: a.name }))} />
          </div>
        ) : null}
      </div>
      <div className="divide-y divide-line rounded-xl bg-surface shadow-raised">
        {app ? <PaceRow key={`pace-${app.id}`} app={app} /> : null}
        {app ? <WhereRow key={`where-${app.id}`} app={app} /> : null}
        <VoiceRow />
        <PlanRow />
      </div>
    </section>
  );
}

/** One "More settings" section: a header row that opens it (also opened by its #id in the URL). */
export function MoreSection({ id, title, summary, children }: { id: string; title: string; summary: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const panel = useId();
  useEffect(() => {
    const check = () => {
      if (window.location.hash === `#${id}`) {
        setOpen(true);
        requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ block: "start" }));
      }
    };
    check();
    window.addEventListener("hashchange", check);
    return () => window.removeEventListener("hashchange", check);
  }, [id]);
  return (
    <div id={id} className="scroll-mt-24">
      <button type="button" aria-expanded={open} aria-controls={panel} onClick={() => setOpen((o) => !o)} className="flex min-h-16 w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-mist/50 focus-visible:outline-none focus-visible:shadow-focus sm:px-5">
        <span className="min-w-0 flex-1">
          <span className="block text-body font-medium text-ink">{title}</span>
          <span className="block text-footnote text-ink-2 text-pretty">{summary}</span>
        </span>
        <ChevronDown className={cn("size-4 shrink-0 text-ink-3 transition-transform duration-200", open && "rotate-180")} aria-hidden />
      </button>
      {open ? (
        <div id={panel} className="border-t border-line bg-mist/50 p-3 sm:p-5">
          {children}
        </div>
      ) : null}
    </div>
  );
}

/** A "More settings" row that opens its own page (Connected accounts, Team, Credits & billing). */
export function MoreLink({ href, title, summary }: { href: string; title: string; summary: string }) {
  return (
    <Link href={href} className="flex min-h-16 w-full items-center gap-3 px-4 py-3 transition-colors hover:bg-mist/50 focus-visible:outline-none focus-visible:shadow-focus sm:px-5">
      <span className="min-w-0 flex-1">
        <span className="block text-body font-medium text-ink">{title}</span>
        <span className="block text-footnote text-ink-2 text-pretty">{summary}</span>
      </span>
      <ChevronRight className="size-4 shrink-0 text-ink-3" aria-hidden />
    </Link>
  );
}
