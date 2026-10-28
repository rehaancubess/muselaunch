"use client";
import type { App, AutopilotAutoStart, Job } from "@muselaunch/contracts";
import { Button, Field, Input, JobProgress, Notice, Textarea, cn, useToast } from "@muselaunch/ui";
import { ArrowRight, CheckCircle2, ChevronDown, Hand, Sparkles } from "lucide-react";
import { useMemo, useRef, useState, type ReactNode } from "react";
import { api, errorMessage, newIdempotencyKey, wsPath } from "@/lib/api";
import { useJob } from "@/lib/jobs";
import { useInvalidate } from "@/lib/query";

type Mode = "link" | "describe";
export type AutopilotChoice = "auto" | "manual";

function normaliseUrl(raw: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  const withScheme = /^https?:\/\//i.test(t) ? t : `https://${t}`;
  try {
    const u = new URL(withScheme);
    if (!u.hostname.includes(".")) return null;
    return u.toString();
  } catch {
    return null;
  }
}

function storeKind(url: string): "ios" | "android" | null {
  const h = new URL(url).hostname;
  if (h === "apps.apple.com" || h === "itunes.apple.com") return "ios";
  if (h === "play.google.com") return "android";
  return null;
}

/** What a pasted link is: an App Store / Google Play listing, or the app's website. */
function classify(raw: string): { url: string; kind: "ios" | "android" | "website" } | null {
  const u = normaliseUrl(raw);
  if (!u) return null;
  return { url: u, kind: storeKind(u) ?? "website" };
}

export interface CreatedApp {
  app: App;
  job: Job | null;
  /** Outcome of the automatic Growth Autopilot start (null when "I'll do it myself"). */
  autopilot: AutopilotAutoStart | null;
  choice: AutopilotChoice;
  workspaceId: string;
}

export interface AddAppFormProps {
  /** The workspace to add to; omit when it's created on submit (`ensureWorkspace`). */
  workspaceId?: string;
  /** Onboarding: create the workspace (and save the country) when the person presses Go. */
  ensureWorkspace?: (choice: AutopilotChoice) => Promise<string>;
  initialUrl?: string;
  onCreated: (created: CreatedApp) => void;
  submitLabel?: string;
  /** Default of the "Let MuseLaunch run it / I'll do it myself" choice (the workspace setting). */
  autopilotDefault?: boolean;
  /** Small print under the form (e.g. the country line). */
  footer?: ReactNode;
}

/** The two ways to work, shown under the primary button. Autopilot is the default. */
function ChoiceCards({ value, onChange }: { value: AutopilotChoice; onChange: (v: AutopilotChoice) => void }) {
  const opts: { value: AutopilotChoice; title: string; badge?: string; body: string; icon: ReactNode }[] = [
    {
      value: "auto",
      title: "Let MuseLaunch run it",
      badge: "Recommended",
      body: "It learns your app, researches your market, makes 2 videos and drafts posts. Nothing is posted and no extra credits are spent without your OK.",
      icon: <Sparkles aria-hidden />,
    },
    { value: "manual", title: "I’ll do it myself", body: "Review your App DNA, then plan campaigns and edit videos step by step.", icon: <Hand aria-hidden /> },
  ];
  return (
    <div role="radiogroup" aria-label="How should MuseLaunch work?" className="grid gap-2">
      {opts.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(o.value)}
            className={cn(
              "flex items-start gap-3 rounded-xl px-4 py-3 text-left transition-[background-color,box-shadow] focus-visible:outline-none focus-visible:shadow-focus",
              on ? "bg-accent-soft/60 shadow-[0_0_0_1.5px_var(--ml-accent)]" : "bg-surface shadow-[0_0_0_1px_rgb(16_24_40/0.1)] hover:shadow-[0_0_0_1px_rgb(16_24_40/0.2)]",
            )}
          >
            <span className={cn("mt-0.5 flex size-[18px] shrink-0 items-center justify-center rounded-full border", on ? "border-accent bg-accent" : "border-line-strong bg-surface")} aria-hidden>
              {on ? <span className="size-1.5 rounded-full bg-white" /> : null}
            </span>
            <span className="min-w-0 space-y-0.5">
              <span className="flex flex-wrap items-center gap-2 text-body-sm font-semibold text-ink">
                {o.title}
                {o.badge ? <span className="rounded-full bg-accent px-1.5 py-px text-[11px] font-semibold text-white">{o.badge}</span> : null}
              </span>
              <span className="block text-footnote text-ink-2 text-pretty">{o.body}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * Add an app in one step: paste a store link (or website), or describe it → Go. `POST /apps` imports
 * the listing; with "Let MuseLaunch run it" (the default) it also starts Growth Autopilot.
 */
export function AddAppForm({ workspaceId, ensureWorkspace, initialUrl, onCreated, submitLabel = "Go", autopilotDefault, footer }: AddAppFormProps) {
  const toast = useToast();
  const invalidate = useInvalidate();
  const [mode, setMode] = useState<Mode>("link");
  const [link, setLink] = useState(initialUrl ?? "");
  const [more, setMore] = useState(false);
  const [otherStoreUrl, setOtherStoreUrl] = useState("");
  const [website, setWebsite] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [choice, setChoice] = useState<AutopilotChoice>(autopilotDefault === false ? "manual" : "auto");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const idem = useRef(newIdempotencyKey("app"));
  const showChoice = autopilotDefault !== undefined;

  const detected = useMemo(() => classify(link), [link]);
  const linkHint = !link.trim()
    ? "We read the public listing: name, description, screenshots and category."
    : detected?.kind === "ios"
      ? "App Store listing detected."
      : detected?.kind === "android"
        ? "Google Play listing detected."
        : detected
          ? "Website detected: we’ll read the page. Add a store link for screenshots."
          : "Paste an App Store, Google Play or website link.";

  const submit = async () => {
    const e: Record<string, string> = {};
    const body: Record<string, unknown> = {};
    if (mode === "link") {
      const c = classify(link);
      if (!c) e.link = "Paste an App Store (apps.apple.com), Google Play (play.google.com) or website link.";
      else body[c.kind === "ios" ? "appStoreUrl" : c.kind === "android" ? "playStoreUrl" : "websiteUrl"] = c.url;
      if (more && otherStoreUrl.trim()) {
        const o = classify(otherStoreUrl);
        if (!o || o.kind === "website" || o.kind === c?.kind) e.otherStoreUrl = c?.kind === "android" ? "Paste the App Store link." : "Paste the Google Play link.";
        else body[o.kind === "ios" ? "appStoreUrl" : "playStoreUrl"] = o.url;
      }
      if (more && website.trim() && c?.kind !== "website") {
        const w = classify(website);
        if (w) body.websiteUrl = w.url;
      }
    } else {
      if (!name.trim()) e.name = "Give your app a name.";
      if (description.trim().length < 20) e.description = "Describe what it does and who it’s for in a sentence or two.";
      body.name = name.trim();
      body.description = description.trim();
    }
    setErrors(e);
    if (Object.keys(e).length) return;
    if (showChoice) body.autopilot = choice === "auto";
    setSubmitting(true);
    try {
      const wid = workspaceId ?? (await ensureWorkspace!(choice));
      const res = await api.post<{ app: App; job: Job | null; autopilot?: AutopilotAutoStart | null }>(wsPath(wid, "/apps"), body, { idempotencyKey: idem.current });
      await invalidate(wsPath(wid, "/apps"));
      onCreated({ app: res.app, job: res.job, autopilot: res.autopilot ?? null, choice, workspaceId: wid });
    } catch (err) {
      toast.error("Couldn’t add the app", errorMessage(err));
      idem.current = newIdempotencyKey("app");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form
      className="space-y-5"
      onSubmit={(ev) => {
        ev.preventDefault();
        void submit();
      }}
      noValidate
    >
      {mode === "link" ? (
        <div className="space-y-3">
          <Field label="Your app’s link" error={errors.link} hint={linkHint}>
            {(f) => (
              <Input
                id={f.id}
                aria-describedby={f.describedBy}
                invalid={f.invalid}
                inputSize="lg"
                inputMode="url"
                autoComplete="url"
                placeholder="https://apps.apple.com/app/…"
                value={link}
                onChange={(ev) => setLink(ev.target.value)}
                autoFocus
              />
            )}
          </Field>
          {more ? (
            <div className="space-y-3 rounded-xl bg-mist/60 p-3">
              <Field label={detected?.kind === "android" ? "App Store link" : "Google Play link"} optional error={errors.otherStoreUrl}>
                {(f) => (
                  <Input
                    id={f.id}
                    aria-describedby={f.describedBy}
                    invalid={f.invalid}
                    inputMode="url"
                    placeholder={detected?.kind === "android" ? "https://apps.apple.com/app/…" : "https://play.google.com/store/apps/details?id=…"}
                    value={otherStoreUrl}
                    onChange={(ev) => setOtherStoreUrl(ev.target.value)}
                  />
                )}
              </Field>
              {detected?.kind !== "website" ? (
                <Field label="Website" optional>
                  {(f) => <Input id={f.id} inputMode="url" placeholder="myapp.com" value={website} onChange={(ev) => setWebsite(ev.target.value)} />}
                </Field>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : (
        <div className="space-y-4">
          <Field label="App name" error={errors.name}>
            {(f) => <Input id={f.id} aria-describedby={f.describedBy} invalid={f.invalid} inputSize="lg" value={name} onChange={(ev) => setName(ev.target.value)} placeholder="e.g. Tidy" autoFocus />}
          </Field>
          <Field label="What does it do, and who is it for?" error={errors.description} hint="Pre-launch is fine. You can add screenshots and recordings in the Library later.">
            {(f) => (
              <Textarea
                id={f.id}
                aria-describedby={f.describedBy}
                invalid={f.invalid}
                rows={4}
                value={description}
                onChange={(ev) => setDescription(ev.target.value)}
                placeholder="A calm to-do app for freelancers that turns emails into tasks…"
              />
            )}
          </Field>
        </div>
      )}

      <Button type="submit" size="lg" className="w-full" loading={submitting} trailing={<ArrowRight className="size-4" aria-hidden />}>
        {submitLabel}
      </Button>

      {showChoice ? <ChoiceCards value={choice} onChange={setChoice} /> : null}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-footnote">
        <button
          type="button"
          className="font-medium text-accent hover:underline"
          onClick={() => {
            setMode(mode === "link" ? "describe" : "link");
            setErrors({});
          }}
        >
          {mode === "link" ? "No link yet? Describe your app" : "Use a link instead"}
        </button>
        {mode === "link" && !more ? (
          <button type="button" className="inline-flex items-center gap-1 font-medium text-ink-2 hover:text-ink" onClick={() => setMore(true)}>
            More links
            <ChevronDown className="size-3.5" aria-hidden />
          </button>
        ) : null}
      </div>
      {footer}
    </form>
  );
}

/** Live import progress for a newly added app. */
export function ImportProgress({ workspaceId, app, job, onContinue, onReview }: { workspaceId: string; app: App; job: Job | null; onContinue: () => void; onReview: () => void }) {
  const toast = useToast();
  const live = useJob(workspaceId, job?.id, { initial: job });
  const j = live.job;
  const done = j?.status === "succeeded";
  const failed = j?.status === "failed" || j?.status === "cancelled";

  if (!job) {
    return (
      <div className="space-y-6">
        <Notice tone="success" icon={<CheckCircle2 aria-hidden />} title={`${app.name} is ready`}>
          There’s no public listing to import, so add screenshots or a screen recording in the Library and review your App DNA.
        </Notice>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button size="lg" className="flex-1" onClick={onReview}>
            Set up App DNA
          </Button>
          <Button size="lg" variant="secondary" className="flex-1" onClick={onContinue}>
            Go to Creator
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="rounded-2xl bg-mist/70 p-5">
        <JobProgress
          job={j}
          title={done ? "Listing imported" : failed ? "Import didn’t finish" : "Importing your app"}
          onCancel={() => live.cancel().catch((e) => toast.error("Couldn’t cancel", errorMessage(e)))}
          onRetry={() => live.retry().catch((e) => toast.error("Couldn’t retry", errorMessage(e)))}
          cancelling={live.cancelling}
          retrying={live.retrying}
        />
        {live.connection === "polling" ? <p className="mt-3 text-caption text-ink-3">Live updates are reconnecting; checking every few seconds.</p> : null}
      </div>
      {done ? (
        <p className="text-body-sm text-ink-2">Next, Muse Spark analyses the listing into your App DNA: features with screenshot evidence, audiences and claims for you to verify. That runs in the background.</p>
      ) : failed ? (
        <p className="text-body-sm text-ink-2">You can retry, or continue and add details manually. Nothing was made up in the meantime.</p>
      ) : (
        <p className="text-body-sm text-ink-2">Reading the public listing and saving screenshots to your Library. You can leave this page; progress continues in the Activity tray.</p>
      )}
      <div className="flex flex-col gap-2 sm:flex-row">
        <Button size="lg" className="flex-1" onClick={onReview} disabled={!done && !failed}>
          Review App DNA
        </Button>
        <Button size="lg" variant="secondary" className="flex-1" onClick={onContinue}>
          {done || failed ? "Go to Creator" : "Continue in background"}
        </Button>
      </div>
    </div>
  );
}
