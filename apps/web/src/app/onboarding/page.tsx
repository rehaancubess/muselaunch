"use client";
import type { App, Job } from "@muselaunch/contracts";
import { Button, ErrorState, Field, Input, Select, Spinner, cn, useToast } from "@muselaunch/ui";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import { LogoMark } from "@/components/logo";
import { AddAppForm, ImportProgress } from "@/components/onboarding/add-app";
import { RequireAuth } from "@/components/require-auth";
import { api, errorMessage } from "@/lib/api";
import type { CreateWorkspaceResponse, MeResponse } from "@/lib/api-types";
import { useAuth } from "@/lib/auth/auth-provider";
import { countryOptions, guessCountry } from "@/lib/countries";
import { useInvalidate } from "@/lib/query";
import { routes } from "@/lib/routes";
import { useMe } from "@/lib/workspace";

type Step = "workspace" | "app" | "import";
const STEPS: { id: Step; label: string }[] = [
  { id: "workspace", label: "Workspace" },
  { id: "app", label: "Your app" },
  { id: "import", label: "Import" },
];

function Steps({ current }: { current: Step }) {
  const idx = STEPS.findIndex((s) => s.id === current);
  return (
    <ol className="flex items-center gap-2 text-footnote" aria-label="Setup progress">
      {STEPS.map((s, i) => (
        <li key={s.id} className="flex items-center gap-2" aria-current={i === idx ? "step" : undefined}>
          <span className={cn("flex size-5 items-center justify-center rounded-full text-[11px] font-semibold tabular", i < idx ? "bg-ink text-white" : i === idx ? "bg-accent text-white" : "bg-mist text-ink-3")}>{i + 1}</span>
          <span className={cn("hidden sm:inline", i === idx ? "font-medium text-ink" : "text-ink-3")}>{s.label}</span>
          {i < STEPS.length - 1 ? <span aria-hidden className="mx-1 h-px w-6 bg-line-strong" /> : null}
        </li>
      ))}
    </ol>
  );
}

function WorkspaceStep({ me, onDone }: { me: MeResponse; onDone: (wid: string) => void }) {
  const { user } = useAuth();
  const toast = useToast();
  const invalidate = useInvalidate();
  const first = (user?.name ?? me.user.displayName ?? user?.email ?? "").split(/[\s@]/)[0];
  const [name, setName] = useState(first ? `${first.charAt(0).toUpperCase()}${first.slice(1)}’s studio` : "My studio");
  const [country, setCountry] = useState(me.user.country ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const options = useMemo(() => countryOptions(), []);
  useEffect(() => {
    if (!country) setCountry(guessCountry());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <form
      className="space-y-6"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!name.trim()) return setErr("Name your workspace.");
        if (!country) return setErr("Choose your country.");
        setErr(null);
        setBusy(true);
        try {
          const { workspace } = await api.post<CreateWorkspaceResponse>("/v1/workspaces", { name: name.trim() });
          await api.patch("/v1/me", { country, defaultWorkspaceId: workspace.id });
          await invalidate("/v1/me");
          onDone(workspace.id);
        } catch (ex) {
          toast.error("Couldn’t create the workspace", errorMessage(ex));
        } finally {
          setBusy(false);
        }
      }}
    >
      <Field label="Workspace name" hint="Usually your studio or company. You can invite teammates later.">
        {(f) => <Input id={f.id} aria-describedby={f.describedBy} inputSize="lg" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} autoFocus />}
      </Field>
      <Field label="Country" error={err} hint="Some AI providers are only offered in certain countries. We use this to pick an eligible one and label it, for example image generation where Muse Image isn’t available.">
        {(f) => <Select id={f.id} aria-describedby={f.describedBy} invalid={f.invalid} selectSize="lg" value={country} onChange={(e) => setCountry(e.target.value)} options={options} placeholder="Choose a country" />}
      </Field>
      <Button type="submit" size="lg" className="w-full" loading={busy}>
        Continue
      </Button>
    </form>
  );
}

function OnboardingInner() {
  const me = useMe();
  const router = useRouter();
  const params = useSearchParams();
  const invalidate = useInvalidate();
  const [step, setStep] = useState<Step | null>(null);
  const [wid, setWid] = useState<string | null>(null);
  const [created, setCreated] = useState<{ app: App; job: Job | null } | null>(null);

  useEffect(() => {
    if (!me.data || step) return;
    const forceNew = params.get("new") === "1";
    if (me.data.workspaces.length && !forceNew) {
      const def = me.data.workspaces.find((w) => w.workspace.id === me.data.user.defaultWorkspaceId) ?? me.data.workspaces[0]!;
      setWid(def.workspace.id);
      setStep("app");
    } else setStep("workspace");
  }, [me.data, params, step]);

  if (me.isLoading || !step) {
    return (
      <div className="flex justify-center py-24" role="status" aria-label="Loading">
        <Spinner size={20} />
      </div>
    );
  }
  if (me.error) return <ErrorState message={errorMessage(me.error)} onRetry={() => me.refetch()} retrying={me.isFetching} />;

  const finish = async (to: string) => {
    try {
      await api.patch("/v1/me", { onboardingCompleted: true });
      await invalidate("/v1/me");
    } catch {
      /* non-blocking */
    }
    router.push(to);
  };

  const titles: Record<Step, { title: string; sub: string }> = {
    workspace: { title: "Set up your studio", sub: "A workspace holds your apps, brand kits, campaigns and team." },
    app: { title: "Add your app", sub: "Paste a store link and Muse reads your public listing to learn the product. Nothing is posted anywhere." },
    import: { title: created?.app.name && created.app.name !== "New app" ? `Importing ${created.app.name}` : "Importing your app", sub: "This usually takes under a minute." },
  };

  return (
    <div className="space-y-8">
      <Steps current={step} />
      <div className="space-y-2">
        <h1 className="text-title-1 font-semibold text-balance">{titles[step].title}</h1>
        <p className="text-body text-ink-2 text-pretty">{titles[step].sub}</p>
      </div>
      {step === "workspace" && me.data ? (
        <WorkspaceStep
          me={me.data}
          onDone={(id) => {
            setWid(id);
            setStep("app");
          }}
        />
      ) : null}
      {step === "app" && wid ? (
        <AddAppForm
          workspaceId={wid}
          initialUrl={params.get("app") ?? undefined}
          submitLabel="Import app"
          onCreated={(app, job) => {
            setCreated({ app, job });
            setStep("import");
          }}
        />
      ) : null}
      {step === "import" && wid && created ? (
        <ImportProgress
          workspaceId={wid}
          app={created.app}
          job={created.job}
          onContinue={() => void finish(routes.app(wid, created.app.id).creator)}
          onReview={() => void finish(routes.app(wid, created.app.id).brand)}
        />
      ) : null}
    </div>
  );
}

export default function OnboardingPage() {
  return (
    <RequireAuth>
      <div className="flex min-h-dvh flex-col">
        <header className="flex h-14 items-center justify-between px-5">
          <Link href="/" className="inline-flex items-center gap-2 text-[17px] font-semibold tracking-[-0.02em]">
            <LogoMark size={24} /> MuseLaunch
          </Link>
        </header>
        <main className="flex flex-1 justify-center px-5 pb-20 pt-[8vh]">
          <div className="w-full max-w-md">
            <Suspense>
              <OnboardingInner />
            </Suspense>
          </div>
        </main>
      </div>
    </RequireAuth>
  );
}
