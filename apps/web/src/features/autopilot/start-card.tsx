"use client";
import type { Autopilot, AutopilotAutoPlan } from "@muselaunch/contracts";
import { Button, Card, ChoiceChips, Field, Input, Notice, Skeleton, Textarea, cn, useToast } from "@muselaunch/ui";
import { ChevronDown, Rocket, Sparkles } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { api, ApiError, errorMessage, wsPath } from "@/lib/api";
import { useApiQuery, useInvalidate, useMutation } from "@/lib/query";
import { routes } from "@/lib/routes";
import { useCurrentApp, useWorkspace } from "@/lib/workspace";
import type { AutopilotEstimate } from "./types";

const GOAL_IDEAS = ["More App Store installs from students before exams", "More trial starts from freelancers in the US", "Grow awareness for our new focus mode"];

/** "about N videos": the workspace's credits over what one video of the default run is budgeted at. */
function videosLeft(p: AutopilotAutoPlan): number | null {
  if (!p.variants || p.maxCredits <= 0) return null;
  return Math.max(0, Math.floor(p.available / (p.maxCredits / p.variants)));
}

/**
 * Start an Autopilot run in one tap with MuseLaunch's defaults (the plan from GET /autopilot/auto:
 * goal from "About your app", 2 videos to compare, a budget for one full run, final renders
 * pre-approved inside it). When credits are short it says so and offers a smaller run. Everything
 * else (goal, number of videos, rounds, budget, renders without asking) sits under "More options";
 * changing any of it starts a custom run (POST /autopilot). Starting is content work
 * (content.write); letting renders run without asking needs billing.manage (enforced by the API).
 */
export function StartCard({ appId, initialGoal, onStarted, again }: { appId: string; initialGoal?: string; onStarted?: (id: string) => void; again?: boolean }) {
  const { workspaceId, can } = useWorkspace();
  const { app } = useCurrentApp();
  const toast = useToast();
  const invalidate = useInvalidate();
  const canSpend = can("billing.manage");
  const canStart = can("content.write");
  const auto = useApiQuery<{ plan: AutopilotAutoPlan }>(wsPath(workspaceId, `/apps/${appId}/autopilot/auto`), { retry: false });
  const p = auto.data?.plan;
  const [more, setMore] = useState(Boolean(initialGoal));
  const [goal, setGoal] = useState(initialGoal?.slice(0, 1000) ?? "");
  const [variants, setVariants] = useState<"1" | "2" | "3">("2");
  const [iterations, setIterations] = useState<"1" | "2" | "3">("1");
  const [budget, setBudget] = useState("200");
  const [autoApprove, setAutoApprove] = useState(canSpend ? "60" : "0");
  const [touched, setTouched] = useState(Boolean(initialGoal));
  const estimate = useApiQuery<AutopilotEstimate>(more ? wsPath(workspaceId, `/apps/${appId}/autopilot/estimate`) : null, { query: { variants, maxIterations: iterations } });
  // Options start from the one-tap plan (the same numbers the automatic start uses).
  const seeded = useRef(false);
  useEffect(() => {
    if (!p || seeded.current) return;
    seeded.current = true;
    if (!initialGoal) setGoal((g) => g || p.goal);
    setVariants(String(p.variants) as "1" | "2" | "3");
    setBudget(String(Math.max(1, p.maxCredits)));
    setAutoApprove(String(p.autoApproveCredits));
  }, [p, initialGoal]);
  const edit = <T,>(set: (v: T) => void) => (v: T) => {
    setTouched(true);
    set(v);
  };
  const budgetN = Number.parseInt(budget, 10);
  const autoN = Number.parseInt(autoApprove || "0", 10);
  const budgetValid = Number.isFinite(budgetN) && budgetN > 0 && budgetN <= 2000;
  const autoValid = Number.isFinite(autoN) && autoN >= 0 && autoN <= 200 && (canSpend || autoN === 0);

  const done = async (id: string) => {
    toast.success("Autopilot started", "It learns your app and researches first. You’ll be asked before anything is posted or extra credits are spent.");
    await invalidate(wsPath(workspaceId, `/apps/${appId}/autopilots`), wsPath(workspaceId, `/apps/${appId}/autopilot`), wsPath(workspaceId, "/needs-you"), wsPath(workspaceId));
    onStarted?.(id);
  };
  const startAuto = useMutation({
    mutationFn: (smaller?: number) => api.post<{ autopilot: Autopilot }>(wsPath(workspaceId, `/apps/${appId}/autopilot/auto`), smaller ? { variants: smaller } : {}),
    onSuccess: ({ autopilot }) => done(autopilot.id),
    onError: (e) => toast.error("Couldn’t start", e instanceof ApiError ? e.userMessage : errorMessage(e)),
  });
  const startCustom = useMutation({
    mutationFn: () => api.post<{ autopilot: Autopilot }>(wsPath(workspaceId, `/apps/${appId}/autopilot`), { goal: goal.trim(), maxCredits: budgetN, maxIterations: Number(iterations), variants: Number(variants), autoApproveCredits: autoN }),
    onSuccess: ({ autopilot }) => done(autopilot.id),
    onError: (e) => toast.error("Couldn’t start", errorMessage(e)),
  });
  const busy = startAuto.isPending || startCustom.isPending;
  const custom = touched && more;
  const customOk = goal.trim().length > 3 && budgetValid && autoValid;
  const est = estimate.data;
  const left = p ? videosLeft(p) : null;
  const n = p?.variants ?? 2;

  return (
    <Card padding="lg" className="space-y-5">
      <div className="flex items-start gap-4">
        <span className="hidden size-11 shrink-0 items-center justify-center rounded-full bg-accent text-white sm:flex">
          <Rocket className="size-5" aria-hidden />
        </span>
        <div className="min-w-0 space-y-1">
          <h2 className="text-title-3 font-semibold text-balance">{again ? "Start another run" : `Let Autopilot grow ${app?.name && app.name !== "New app" ? app.name : "your app"}`}</h2>
          <p className="text-body-sm text-ink-2 text-pretty">
            It researches your market, makes {n} short video{n > 1 ? "s" : ""} to compare, checks them and drafts posts. Nothing is posted and no extra credits are spent without your OK.
          </p>
        </div>
      </div>

      {auto.isLoading ? (
        <Skeleton className="h-16 w-full" />
      ) : p ? (
        <div className="space-y-4 sm:pl-15">
          {!custom ? (
            <dl className="grid gap-x-6 gap-y-1.5 text-body-sm sm:grid-cols-[auto_1fr]">
              <dt className="text-ink-3">Goal</dt>
              <dd className="text-ink text-pretty">{p.goal}</dd>
              <dt className="text-ink-3">Uses</dt>
              <dd className="text-ink">
                About {p.needed} credits{left !== null ? <span className="text-ink-3"> · you have enough for about {left} video{left === 1 ? "" : "s"}</span> : null}
              </dd>
            </dl>
          ) : null}
          {p.shortfall && !custom ? (
            <Notice tone="warning" title={p.shortfall.kind === "credits" ? "Not enough credits for a full run" : "Above your per-run limit"}>
              {p.shortfall.message}
              {p.smaller ? ` A smaller run with ${p.smaller.variants} video uses about ${p.smaller.needed} credits.` : ""}
            </Notice>
          ) : null}
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            {custom ? (
              <Button size="lg" icon={<Sparkles className="size-4" aria-hidden />} disabled={!canStart || !customOk || busy} loading={startCustom.isPending} onClick={() => startCustom.mutate()}>
                Start Autopilot
              </Button>
            ) : p.fits ? (
              <Button size="lg" icon={<Sparkles className="size-4" aria-hidden />} disabled={!canStart || busy} loading={startAuto.isPending} onClick={() => startAuto.mutate(undefined)}>
                Start Autopilot
              </Button>
            ) : p.smaller ? (
              <Button size="lg" icon={<Sparkles className="size-4" aria-hidden />} disabled={!canStart || busy} loading={startAuto.isPending} onClick={() => startAuto.mutate(p.smaller!.variants)}>
                Start a smaller run
              </Button>
            ) : (
              <Button size="lg" variant="secondary" asChild>
                <Link href={routes.settings.credits(workspaceId)}>Get credits</Link>
              </Button>
            )}
            <button type="button" aria-expanded={more} onClick={() => setMore((v) => !v)} className="inline-flex items-center gap-1 self-start text-footnote font-medium text-ink-2 hover:text-ink sm:self-center">
              More options
              <ChevronDown className={cn("size-3.5 transition-transform", more && "rotate-180")} aria-hidden />
            </button>
          </div>
          {!canStart ? <p className="text-footnote text-ink-2">Viewers can follow runs but not start them.</p> : null}
          {p.notes.length && !custom ? <p className="text-footnote text-ink-3 text-pretty">{p.notes.join(" ")}</p> : null}
        </div>
      ) : auto.error ? (
        <Notice tone="danger">{errorMessage(auto.error)}</Notice>
      ) : null}

      {more ? (
        <div className="space-y-5 border-t border-line pt-5 sm:ml-15">
          <Field label="Goal" hint="An outcome, not a task. Who, what, and by when if it matters.">
            {(ids) => <Textarea id={ids.id} aria-describedby={ids.describedBy} rows={2} maxLength={1000} value={goal} onChange={(e) => edit(setGoal)(e.target.value)} placeholder={GOAL_IDEAS[0]} />}
          </Field>
          {!goal ? (
            <div className="-mt-3 flex flex-wrap gap-2">
              {GOAL_IDEAS.map((g) => (
                <button key={g} type="button" onClick={() => edit(setGoal)(g)} className="rounded-full bg-mist px-3 py-1 text-footnote text-ink-2 transition-colors hover:bg-mist-2 hover:text-ink">
                  {g}
                </button>
              ))}
            </div>
          ) : null}
          <div className="grid gap-5 sm:grid-cols-2">
            <div className="space-y-1.5">
              <p className="text-footnote font-medium text-ink">Videos to compare</p>
              <ChoiceChips
                label="Videos to compare"
                options={[
                  { value: "1", label: "1" },
                  { value: "2", label: "2 (A/B test)" },
                  { value: "3", label: "3" },
                ]}
                value={[variants]}
                onChange={(v) => v[0] && edit(setVariants)(v[0])}
              />
            </div>
            <div className="space-y-1.5">
              <p className="text-footnote font-medium text-ink">Rounds</p>
              <ChoiceChips
                label="Rounds"
                options={[
                  { value: "1", label: "1" },
                  { value: "2", label: "2" },
                  { value: "3", label: "3" },
                ]}
                value={[iterations]}
                onChange={(v) => v[0] && edit(setIterations)(v[0])}
              />
            </div>
            <Field label="Budget (credits)" hint="A hard ceiling. Autopilot pauses and asks before going over." error={budget && !budgetValid ? "Between 1 and 2,000 credits" : undefined}>
              {(ids) => <Input id={ids.id} aria-describedby={ids.describedBy} inputMode="numeric" value={budget} onChange={(e) => edit(setBudget)(e.target.value.replace(/\D/g, ""))} />}
            </Field>
            <Field
              label="Final renders without asking, up to"
              hint={canSpend ? "Renders under this many credits go ahead on their own. 0 = always ask." : "Only members who manage billing can let renders run without asking."}
              error={!autoValid && canSpend ? "Between 0 and 200 credits" : undefined}
            >
              {(ids) => (
                <Input
                  id={ids.id}
                  aria-describedby={ids.describedBy}
                  inputMode="numeric"
                  disabled={!canSpend}
                  value={autoApprove}
                  onChange={(e) => edit(setAutoApprove)(e.target.value.replace(/\D/g, ""))}
                  trailing={<span className="text-footnote text-ink-3">credits</span>}
                />
              )}
            </Field>
          </div>
          <div className="rounded-lg bg-mist/70 p-4">
            {estimate.isLoading ? (
              <Skeleton className="h-16 w-full" />
            ) : est ? (
              <div className="space-y-3">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <p className="text-body-sm font-medium text-ink">Typical cost</p>
                  <p className="tabular text-body-sm text-ink">
                    About {est.perIteration} credits a round{Number(iterations) > 1 ? <span className="text-ink-2"> · up to about {est.total} in total</span> : null}
                  </p>
                </div>
                <ul className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
                  {est.breakdown.map((b) => (
                    <li key={b.label} className="flex justify-between gap-3 text-footnote text-ink-2">
                      <span className="truncate">{b.label}</span>
                      <span className="tabular text-ink-3">{b.credits}</span>
                    </li>
                  ))}
                </ul>
                <p className="text-footnote text-ink-3">Each step reserves its own credits; what’s really spent is tracked live against the budget. Model calls are metered.</p>
              </div>
            ) : (
              <p className="text-footnote text-ink-2">Cost estimate unavailable right now. Each step still shows its cost before it runs.</p>
            )}
          </div>
          {est && budgetValid && budgetN < est.perIteration ? (
            <Notice tone="warning" title="This budget covers part of one round">
              Autopilot pauses when it runs out and asks before spending more.
            </Notice>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}
