"use client";
import type { App, Job } from "@muselaunch/contracts";
import { Button, Field, Input, JobProgress, Notice, SegmentedControl, Textarea, useToast } from "@muselaunch/ui";
import { CheckCircle2, Globe, PenLine, ShoppingBag } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { api, errorMessage, newIdempotencyKey, wsPath } from "@/lib/api";
import type { CreateAppResponse } from "@/lib/api-types";
import { useJob } from "@/lib/jobs";
import { useInvalidate } from "@/lib/query";

type Mode = "store" | "website" | "manual";

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

export interface AddAppFormProps {
  workspaceId: string;
  initialUrl?: string;
  onCreated: (app: App, job: Job | null) => void;
  submitLabel?: string;
}

/** Add an app by store link, website, or a manual description → `POST /apps` (+ import job). */
export function AddAppForm({ workspaceId, initialUrl, onCreated, submitLabel = "Add app" }: AddAppFormProps) {
  const toast = useToast();
  const invalidate = useInvalidate();
  const initialMode: Mode = initialUrl ? (/apple\.com|play\.google\.com/.test(initialUrl) ? "store" : "website") : "store";
  const [mode, setMode] = useState<Mode>(initialMode);
  const [storeUrl, setStoreUrl] = useState(initialMode === "store" ? (initialUrl ?? "") : "");
  const [otherStoreUrl, setOtherStoreUrl] = useState("");
  const [showOther, setShowOther] = useState(false);
  const [website, setWebsite] = useState(initialMode === "website" ? (initialUrl ?? "") : "");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const idem = useRef(newIdempotencyKey("app"));

  const detected = useMemo(() => {
    const u = normaliseUrl(storeUrl);
    return u ? storeKind(u) : null;
  }, [storeUrl]);

  const submit = async () => {
    const e: Record<string, string> = {};
    const body: Record<string, unknown> = {};
    if (mode === "store") {
      const u = normaliseUrl(storeUrl);
      const kind = u ? storeKind(u) : null;
      if (!u || !kind) e.storeUrl = "Paste an App Store (apps.apple.com) or Google Play (play.google.com) link.";
      else body[kind === "ios" ? "appStoreUrl" : "playStoreUrl"] = u;
      if (showOther && otherStoreUrl.trim()) {
        const o = normaliseUrl(otherStoreUrl);
        const ok = o ? storeKind(o) : null;
        if (!o || !ok || ok === kind) e.otherStoreUrl = kind === "ios" ? "Paste the Google Play link." : "Paste the App Store link.";
        else body[ok === "ios" ? "appStoreUrl" : "playStoreUrl"] = o;
      }
      if (website.trim()) {
        const w = normaliseUrl(website);
        if (w) body.websiteUrl = w;
      }
    } else if (mode === "website") {
      const w = normaliseUrl(website);
      if (!w) e.website = "Enter your app’s website, e.g. myapp.com";
      else body.websiteUrl = w;
      if (name.trim()) body.name = name.trim();
    } else {
      if (!name.trim()) e.name = "Give your app a name.";
      if (description.trim().length < 20) e.description = "Describe what it does and who it’s for in a sentence or two.";
      body.name = name.trim();
      body.description = description.trim();
    }
    setErrors(e);
    if (Object.keys(e).length) return;
    setSubmitting(true);
    try {
      const res = await api.post<CreateAppResponse>(wsPath(workspaceId, "/apps"), body, { idempotencyKey: idem.current });
      await invalidate(wsPath(workspaceId, "/apps"));
      onCreated(res.app, res.job);
    } catch (err) {
      toast.error("Couldn’t add the app", errorMessage(err));
      idem.current = newIdempotencyKey("app");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form
      className="space-y-6"
      onSubmit={(ev) => {
        ev.preventDefault();
        void submit();
      }}
      noValidate
    >
      <SegmentedControl<Mode>
        label="How should we find your app?"
        value={mode}
        onChange={(m) => {
          setMode(m);
          setErrors({});
        }}
        fullWidth
        items={[
          { value: "store", label: "Store link", icon: <ShoppingBag aria-hidden /> },
          { value: "website", label: "Website", icon: <Globe aria-hidden /> },
          { value: "manual", label: "Describe it", icon: <PenLine aria-hidden /> },
        ]}
      />

      {mode === "store" ? (
        <div className="space-y-4">
          <Field
            label="App Store or Google Play link"
            error={errors.storeUrl}
            hint={detected ? (detected === "ios" ? "App Store listing detected." : "Google Play listing detected.") : "We read the public listing: name, description, screenshots and category."}
          >
            {(f) => (
              <Input
                id={f.id}
                aria-describedby={f.describedBy}
                invalid={f.invalid}
                inputSize="lg"
                inputMode="url"
                autoComplete="url"
                placeholder="https://apps.apple.com/app/…"
                value={storeUrl}
                onChange={(ev) => setStoreUrl(ev.target.value)}
                autoFocus
              />
            )}
          </Field>
          {showOther ? (
            <Field label={detected === "android" ? "App Store link" : "Google Play link"} optional error={errors.otherStoreUrl}>
              {(f) => <Input id={f.id} aria-describedby={f.describedBy} invalid={f.invalid} inputMode="url" placeholder={detected === "android" ? "https://apps.apple.com/app/…" : "https://play.google.com/store/apps/details?id=…"} value={otherStoreUrl} onChange={(ev) => setOtherStoreUrl(ev.target.value)} />}
            </Field>
          ) : (
            <button type="button" className="text-footnote font-medium text-accent hover:underline" onClick={() => setShowOther(true)}>
              Add the other store’s link
            </button>
          )}
          <Field label="Website" optional>
            {(f) => <Input id={f.id} inputMode="url" placeholder="myapp.com" value={website} onChange={(ev) => setWebsite(ev.target.value)} />}
          </Field>
        </div>
      ) : mode === "website" ? (
        <div className="space-y-4">
          <Field label="Website" error={errors.website} hint="We read the public page to understand your product. Add a store link later for screenshots.">
            {(f) => <Input id={f.id} aria-describedby={f.describedBy} invalid={f.invalid} inputSize="lg" inputMode="url" placeholder="myapp.com" value={website} onChange={(ev) => setWebsite(ev.target.value)} autoFocus />}
          </Field>
          <Field label="App name" optional>
            {(f) => <Input id={f.id} value={name} onChange={(ev) => setName(ev.target.value)} placeholder="Shown until we import it" />}
          </Field>
        </div>
      ) : (
        <div className="space-y-4">
          <Field label="App name" error={errors.name}>
            {(f) => <Input id={f.id} aria-describedby={f.describedBy} invalid={f.invalid} inputSize="lg" value={name} onChange={(ev) => setName(ev.target.value)} placeholder="e.g. Tidy" autoFocus />}
          </Field>
          <Field label="What does it do, and who is it for?" error={errors.description} hint="Pre-launch? That’s fine. You can upload screenshots and recordings in the Library afterwards.">
            {(f) => <Textarea id={f.id} aria-describedby={f.describedBy} invalid={f.invalid} rows={5} value={description} onChange={(ev) => setDescription(ev.target.value)} placeholder="A calm to-do app for freelancers that turns emails into tasks…" />}
          </Field>
        </div>
      )}

      <Button type="submit" size="lg" className="w-full" loading={submitting}>
        {submitLabel}
      </Button>
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
