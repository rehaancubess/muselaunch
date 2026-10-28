"use client";
import { Button, Card, ChoiceChips, Field, Input, Notice, Skeleton, Textarea, cn, useToast } from "@muselaunch/ui";
import { ChevronDown, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, errorMessage, wsPath } from "@/lib/api";
import { useApiQuery, useInvalidate, useMutation } from "@/lib/query";
import { useWorkspace } from "@/lib/workspace";
import type { Autopilot, AutopilotAutoPlan } from "@muselaunch/contracts";
import type { AutopilotEstimate } from "./types";

const GOAL_IDEAS = ["More App Store installs from students before exams", "More trial starts from freelancers in the US", "Grow awareness for our new focus mode"];

/**
 * Start a Growth Autopilot: a goal and Start, pre-filled with MuseLaunch's defaults (the one-tap plan:
 * goal from App DNA, a budget for one full iteration, renders pre-approved within it). Budget,
 * variants, iterations and the auto-approve threshold sit under "Advanced". Starting is content work
 * (content.write); letting renders run without asking (auto-approve > 0) needs billing.manage,
 * enforced by the API too.
 */
export function StartCard({ appId, initialGoal, onStarted }: { appId: string; initialGoal?: string; onStarted: (id: string) => void }) {
  const { workspaceId, can } = useWorkspace();
  const toast = useToast();
  const invalidate = useInvalidate();
  const canSpend = can("billing.manage");
  const [goal, setGoal] = useState(initialGoal?.slice(0, 1000) ?? "");
  const [variants, setVariants] = useState<"1" | "2" | "3">("2");
  const [iterations, setIterations] = useState<"1" | "2" | "3">("1");
  const [budget, setBudget] = useState("200");
  const [autoApprove, setAutoApprove] = useState(canSpend ? "60" : "0");
  const [advanced, setAdvanced] = useState(false);
  const estimate = useApiQuery<AutopilotEstimate>(wsPath(workspaceId, `/apps/${appId}/autopilot/estimate`), { query: { variants, maxIterations: iterations } });
  // Defaults come from the one-tap plan (same numbers the automatic start uses), until you edit them.
  const auto = useApiQuery<{ plan: AutopilotAutoPlan }>(wsPath(workspaceId, `/apps/${appId}/autopilot/auto`), { retry: false });
  const seeded = useRef(false);
  useEffect(() => {
    const p = auto.data?.plan;
    if (!p || seeded.current) return;
    seeded.current = true;
    if (!initialGoal) setGoal((g) => g || p.goal);
    setVariants(String(p.variants) as "1" | "2" | "3");
    setBudget(String(Math.max(1, p.maxCredits)));
    setAutoApprove(String(p.autoApproveCredits));
  }, [auto.data, initialGoal]);
  const budgetN = Number.parseInt(budget, 10);
  const autoN = Number.parseInt(autoApprove || "0", 10);
  const budgetValid = Number.isFinite(budgetN) && budgetN > 0 && budgetN <= 2000;
  const autoValid = Number.isFinite(autoN) && autoN >= 0 && autoN <= 200 && (canSpend || autoN === 0);

  const start = useMutation({
    mutationFn: () =>
      api.post<{ autopilot: Autopilot }>(wsPath(workspaceId, `/apps/${appId}/autopilot`), {
        goal: goal.trim(),
        maxCredits: budgetN,
        maxIterations: Number(iterations),
        variants: Number(variants),
        autoApproveCredits: autoN,
      }),
    onSuccess: async ({ autopilot }) => {
      toast.success("Growth Autopilot started", "Muse Wonder is researching first. You’ll be asked before anything costly or public happens.");
      await invalidate(wsPath(workspaceId, `/apps/${appId}/autopilots`));
      onStarted(autopilot.id);
    },
    onError: (err) => toast.error("Couldn’t start the loop", errorMessage(err)),
  });

  const est = estimate.data;
  const short = est && budgetValid && budgetN < est.perIteration;
  const canStart = can("content.write") && goal.trim().length > 3 && budgetValid && autoValid && !start.isPending;

  return (
    <Card padding="lg" className="space-y-6">
      <div className="space-y-1">
        <h2 className="text-headline font-semibold">Start a growth loop</h2>
        <p className="text-body-sm text-ink-2 text-pretty">Describe the outcome you want. Muse Wonder plans and runs one bounded experiment at a time, inside the budget you set.</p>
      </div>

      <Field label="Goal" hint="An outcome, not a task. Who, what, and by when if it matters.">
        {(ids) => <Textarea id={ids.id} aria-describedby={ids.describedBy} rows={2} maxLength={1000} value={goal} onChange={(e) => setGoal(e.target.value)} placeholder={GOAL_IDEAS[0]} />}
      </Field>
      {!goal ? (
        <div className="-mt-3 flex flex-wrap gap-2">
          {GOAL_IDEAS.map((g) => (
            <button key={g} type="button" onClick={() => setGoal(g)} className="rounded-full bg-mist px-3 py-1 text-footnote text-ink-2 transition-colors hover:bg-mist-2 hover:text-ink">
              {g}
            </button>
          ))}
        </div>
      ) : null}

      <button type="button" aria-expanded={advanced} onClick={() => setAdvanced((v) => !v)} className="inline-flex items-center gap-1 text-footnote font-medium text-ink-2 hover:text-ink">
        Advanced: budget {budgetValid ? `${budgetN} credits` : ""}, {variants} video{variants === "1" ? "" : "s"}, {iterations} iteration{iterations === "1" ? "" : "s"}, renders {autoN ? `run up to ${autoN} credits` : "ask first"}
        <ChevronDown className={cn("size-3.5 transition-transform", advanced && "rotate-180")} aria-hidden />
      </button>
      {advanced ? (
        <>
          <div className="grid gap-5 sm:grid-cols-2">
            <div className="space-y-1.5">
              <p className="text-footnote font-medium text-ink">Variants to test</p>
              <ChoiceChips
                label="Variants to test"
                options={[
                  { value: "1", label: "1" },
                  { value: "2", label: "2 (A/B)" },
                  { value: "3", label: "3" },
                ]}
                value={[variants]}
                onChange={(v) => v[0] && setVariants(v[0])}
              />
            </div>
            <div className="space-y-1.5">
              <p className="text-footnote font-medium text-ink">Iterations</p>
              <ChoiceChips
                label="Iterations"
                options={[
                  { value: "1", label: "1" },
                  { value: "2", label: "2" },
                  { value: "3", label: "3" },
                ]}
                value={[iterations]}
                onChange={(v) => v[0] && setIterations(v[0])}
              />
            </div>
            <Field label="Budget (credits)" hint="A hard ceiling. The loop pauses and asks before going over." error={budget && !budgetValid ? "Between 1 and 2,000 credits" : undefined}>
              {(ids) => <Input id={ids.id} aria-describedby={ids.describedBy} inputMode="numeric" value={budget} onChange={(e) => setBudget(e.target.value.replace(/\D/g, ""))} />}
            </Field>
            <Field
              label="Auto-approve renders up to"
              hint={canSpend ? "Final renders under this many credits run without asking. 0 = always ask." : "Only members who manage billing can let renders run without asking."}
              error={!autoValid && canSpend ? "Between 0 and 200 credits" : undefined}
            >
              {(ids) => (
                <Input
                  id={ids.id}
                  aria-describedby={ids.describedBy}
                  inputMode="numeric"
                  disabled={!canSpend}
                  value={autoApprove}
                  onChange={(e) => setAutoApprove(e.target.value.replace(/\D/g, ""))}
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
                <div className="flex items-baseline justify-between gap-3">
                  <p className="text-body-sm font-medium text-ink">Typical cost</p>
                  <p className="tabular text-body-sm text-ink">
                    ≈{est.perIteration} credits per iteration{Number(iterations) > 1 ? <span className="text-ink-2"> · up to ≈{est.total} in total</span> : null}
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
                <p className="text-footnote text-ink-3">Each step reserves its own credits; actual spend is tracked live against your budget. Model calls are metered.</p>
              </div>
            ) : (
              <p className="text-footnote text-ink-2">Cost estimate unavailable right now. Each step still shows its cost before it runs.</p>
            )}
          </div>
        </>
      ) : null}

      {short ? (
        <Notice tone="warning" title="This budget covers part of one iteration">
          The loop will pause at a checkpoint when it runs out, and ask before spending more.
        </Notice>
      ) : null}

      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-footnote text-ink-3 text-pretty">Nothing is published or sent by the loop. Every post waits for your approval.</p>
        <Button icon={<Sparkles aria-hidden />} loading={start.isPending} disabled={!canStart} onClick={() => start.mutate()}>
          Start Autopilot
        </Button>
      </div>
      {!can("content.write") ? <p className="text-footnote text-ink-2">Viewers can follow loops but not start them.</p> : null}
    </Card>
  );
}
