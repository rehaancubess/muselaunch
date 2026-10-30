"use client";
import { ErrorState, Select, Spinner } from "@muselaunch/ui";
import { ChevronDown } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import { LogoMark } from "@/components/logo";
import { AddAppForm, ImportProgress, type AutopilotChoice, type CreatedApp } from "@/components/onboarding/add-app";
import { RequireAuth } from "@/components/require-auth";
import { WalkthroughExplainer, WalkthroughPrompt } from "@/features/media/walkthrough";
import { api, errorMessage, wsPath } from "@/lib/api";
import type { CreateWorkspaceResponse } from "@/lib/api-types";
import { useAuth } from "@/lib/auth/auth-provider";
import { countryOptions, guessCountry } from "@/lib/countries";
import { useInvalidate } from "@/lib/query";
import { routes } from "@/lib/routes";
import { useMe } from "@/lib/workspace";

/** "Maya’s studio" from the signed-in name (or email), like the old workspace step suggested. */
function studioName(raw: string): string {
  const first = raw.split(/[\s@._-]/)[0] ?? "";
  return first ? `${first.charAt(0).toUpperCase()}${first.slice(1)}’s studio` : "My studio";
}

/** The country line: small, editable in place (it decides which AI providers are eligible). */
function CountryLine({ country, onChange, workspaceName }: { country: string; onChange: (c: string) => void; workspaceName: string | null }) {
  const [editing, setEditing] = useState(false);
  const options = useMemo(() => countryOptions(), []);
  const label = options.find((o) => o.value === country)?.label;
  return (
    <div className="space-y-1 border-t border-line pt-4 text-footnote text-ink-3">
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-2">
        <span>Country:</span>
        {editing ? (
          <Select
            aria-label="Country"
            selectSize="sm"
            value={country}
            onChange={(e) => {
              onChange(e.target.value);
              setEditing(false);
            }}
            options={options}
            placeholder="Choose a country"
            className="w-56"
          />
        ) : (
          <button type="button" className="font-medium text-ink-2 underline decoration-line-strong underline-offset-2 hover:text-ink" onClick={() => setEditing(true)} aria-label={`Country: ${label ?? "not set"}. Change`}>
            {label ?? "Choose"}
          </button>
        )}
        <span>· picks AI providers available there.</span>
      </div>
      {workspaceName ? <p>Your workspace will be “{workspaceName}”. Rename it any time in Settings.</p> : null}
    </div>
  );
}

function OnboardingInner() {
  const me = useMe();
  const { user } = useAuth();
  const router = useRouter();
  const params = useSearchParams();
  const invalidate = useInvalidate();
  const [country, setCountry] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedApp | null>(null);

  const forceNew = params.get("new") === "1";
  const existing = me.data && me.data.workspaces.length && !forceNew ? (me.data.workspaces.find((w) => w.workspace.id === me.data.user.defaultWorkspaceId) ?? me.data.workspaces[0]!) : null;
  const name = studioName(user?.name ?? me.data?.user.displayName ?? user?.email ?? "");

  useEffect(() => {
    if (me.data && country === null) setCountry(me.data.user.country ?? guessCountry());
  }, [me.data, country]);

  if (me.isLoading || !me.data || country === null) {
    if (me.error) return <ErrorState message={errorMessage(me.error)} onRetry={() => me.refetch()} retrying={me.isFetching} />;
    return (
      <div className="flex justify-center py-24" role="status" aria-label="Loading">
        <Spinner size={20} />
      </div>
    );
  }

  const finish = async (to: string) => {
    try {
      await api.patch("/v1/me", { onboardingCompleted: true });
      await invalidate("/v1/me");
    } catch {
      /* non-blocking */
    }
    router.push(to);
  };

  /** On Go: the workspace (named from you, with your country) is created now, not as a form step. */
  const ensureWorkspace = async (choice: AutopilotChoice): Promise<string> => {
    if (existing) {
      if (country && country !== me.data.user.country) await api.patch("/v1/me", { country });
      return existing.workspace.id;
    }
    const { workspace } = await api.post<CreateWorkspaceResponse>("/v1/workspaces", { name });
    await api.patch("/v1/me", { country: country || undefined, defaultWorkspaceId: workspace.id });
    // "I'll do it myself" is the workspace's preference too (Settings → Growth Autopilot turns it back on).
    if (choice === "manual") await api.patch(wsPath(workspace.id), { settings: { autopilot: { enabled: false } } }).catch(() => undefined);
    await invalidate("/v1/me");
    return workspace.id;
  };

  if (created) {
    return (
      <div className="space-y-8">
        <div className="space-y-2">
          <h1 className="text-title-1 font-semibold text-balance">{created.app.name && created.app.name !== "New app" ? `Importing ${created.app.name}` : "Importing your app"}</h1>
          <p className="text-body text-ink-2 text-pretty">This usually takes under a minute. Then review your App DNA and plan your first campaign.</p>
        </div>
        <ImportProgress
          workspaceId={created.workspaceId}
          app={created.app}
          job={created.job}
          onContinue={() => void finish(routes.app(created.workspaceId, created.app.id).creator)}
          onReview={() => void finish(routes.app(created.workspaceId, created.app.id).brand)}
        />
        <WalkthroughPrompt workspaceId={created.workspaceId} appId={created.app.id} variant="inline" />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <h1 className="text-title-1 font-semibold text-balance">Let’s grow your app</h1>
        <p className="text-body text-ink-2 text-pretty">Paste your App Store or Google Play link. MuseLaunch learns your app and gets to work.</p>
      </div>
      <AddAppForm
        workspaceId={existing?.workspace.id}
        ensureWorkspace={ensureWorkspace}
        initialUrl={params.get("app") ?? undefined}
        autopilotDefault={existing ? (existing.workspace.settings.autopilot?.enabled ?? true) : true}
        onCreated={(c) => {
          if (c.choice === "auto") void finish(routes.app(c.workspaceId, c.app.id).creator);
          else setCreated(c);
        }}
        footer={<CountryLine country={country} onChange={setCountry} workspaceName={existing ? null : name} />}
      />
      <details className="group rounded-2xl bg-mist/60 px-4 py-3 [&_summary::-webkit-details-marker]:hidden">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-body-sm font-medium text-ink">
          <span>
            Optional next: record one walkthrough of your app
            <span className="block text-footnote font-normal text-ink-2">Makes every video show your real app moving. You can add it after Go, on your app’s Home.</span>
          </span>
          <ChevronDown className="size-4 shrink-0 text-ink-3 transition-transform group-open:rotate-180" aria-hidden />
        </summary>
        <WalkthroughExplainer className="pt-4" />
      </details>
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
        <main className="flex flex-1 justify-center px-4 pb-20 pt-[6vh] sm:px-5 sm:pt-[8vh]">
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
