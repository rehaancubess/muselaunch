"use client";
import { Button, Divider, ErrorState, Field, Input, Notice, Spinner } from "@muselaunch/ui";
import { Mail } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { LogoMark } from "@/components/logo";
import { api, errorMessage } from "@/lib/api";
import type { MeResponse } from "@/lib/api-types";
import { useAuth } from "@/lib/auth/auth-provider";
import { routes } from "@/lib/routes";

function GoogleGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="size-4" aria-hidden>
      <path fill="#4285F4" d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.4h6.5a5.6 5.6 0 0 1-2.4 3.6v3h3.9c2.2-2.1 3.5-5.1 3.5-8.7Z" />
      <path fill="#34A853" d="M12 24c3.2 0 6-1.1 7.9-2.9l-3.9-3c-1 .7-2.4 1.2-4 1.2-3.1 0-5.7-2.1-6.6-4.9H1.4v3.1A12 12 0 0 0 12 24Z" />
      <path fill="#FBBC05" d="M5.4 14.4a7.2 7.2 0 0 1 0-4.6V6.7h-4a12 12 0 0 0 0 10.7l4-3Z" />
      <path fill="#EA4335" d="M12 4.8c1.7 0 3.3.6 4.6 1.8l3.4-3.4A12 12 0 0 0 1.4 6.7l4 3.1C6.3 6.9 8.9 4.8 12 4.8Z" />
    </svg>
  );
}

/** After sign-in: honour ?next=, else onboarding (no workspace yet) or the default workspace. */
async function destinationAfterSignIn(next: string | null): Promise<string> {
  if (next && next.startsWith("/") && !next.startsWith("//")) return next;
  const me = await api.get<MeResponse>("/v1/me");
  if (!me.workspaces.length) return routes.onboarding();
  const wid = me.user.defaultWorkspaceId && me.workspaces.some((w) => w.workspace.id === me.user.defaultWorkspaceId) ? me.user.defaultWorkspaceId : me.workspaces[0]!.workspace.id;
  return routes.workspace(wid);
}

function LoginInner() {
  const auth = useAuth();
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState<null | "google" | "email" | "dev">(null);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [routing, setRouting] = useState<"idle" | "routing" | "failed">("idle");
  const [needsEmailForLink, setNeedsEmailForLink] = useState(false);
  const handledLink = useRef(false);

  // Complete an email sign-in link (Firebase).
  useEffect(() => {
    if (auth.mode !== "firebase" || !auth.configured || handledLink.current) return;
    handledLink.current = true;
    auth
      .completeEmailLink(window.location.href)
      .then((r) => {
        if (r === "needs_email") setNeedsEmailForLink(true);
      })
      .catch((e) => setError(errorMessage(e)));
  }, [auth]);

  useEffect(() => {
    if (auth.status !== "signed_in" || routing !== "idle") return;
    setRouting("routing");
    destinationAfterSignIn(next)
      .then((to) => router.replace(to))
      .catch((e) => {
        setRouting("failed");
        setError(errorMessage(e));
      });
  }, [auth.status, next, router, routing]);

  if (auth.status === "loading" || routing === "routing") {
    return (
      <div className="flex min-h-[50vh] items-center justify-center" role="status" aria-label="Signing in">
        <Spinner size={20} />
      </div>
    );
  }

  if (routing === "failed") {
    return (
      <ErrorState
        title="Signed in, but MuseLaunch didn’t respond"
        message={error ?? undefined}
        onRetry={() => {
          setError(null);
          setRouting("idle");
        }}
      />
    );
  }

  return (
    <div className="space-y-6">
      {auth.mode === "dev" ? (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!/^\S+@\S+\.\S+$/.test(email)) return setError("Enter a valid email address.");
            setError(null);
            auth.signInDev(email, name);
          }}
        >
          <Notice tone="warning">Local development sign-in. The API must run with dev tokens enabled; this never works in production.</Notice>
          <Field label="Email" error={error}>
            {(f) => <Input id={f.id} aria-describedby={f.describedBy} invalid={f.invalid} type="email" autoComplete="email" inputSize="lg" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@studio.dev" required />}
          </Field>
          <Field label="Name" optional>
            {(f) => <Input id={f.id} inputSize="lg" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" />}
          </Field>
          <Button type="submit" size="lg" className="w-full">
            Continue
          </Button>
        </form>
      ) : !auth.configured ? (
        <Notice tone="warning" title="Sign-in isn’t configured on this deployment">
          Set the NEXT_PUBLIC_FIREBASE_* variables to enable Google and email sign-in.
        </Notice>
      ) : sent ? (
        <div className="space-y-3 text-center">
          <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-accent-soft text-accent">
            <Mail className="size-5" aria-hidden />
          </div>
          <p className="text-headline font-semibold">Check your inbox</p>
          <p className="text-body-sm text-ink-2">
            We sent a sign-in link to <span className="font-medium text-ink">{email}</span>. Open it on this device to continue.
          </p>
          <Button variant="ghost" size="sm" onClick={() => setSent(false)}>
            Use a different email
          </Button>
        </div>
      ) : (
        <>
          <Button
            variant="outline"
            size="lg"
            className="w-full"
            loading={busy === "google"}
            icon={<GoogleGlyph />}
            onClick={async () => {
              setBusy("google");
              setError(null);
              try {
                await auth.signInWithGoogle();
              } catch (e) {
                setError(errorMessage(e));
              } finally {
                setBusy(null);
              }
            }}
          >
            Continue with Google
          </Button>
          <div className="flex items-center gap-3 text-footnote text-ink-3">
            <Divider className="flex-1" />
            or
            <Divider className="flex-1" />
          </div>
          <form
            className="space-y-3"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy("email");
              setError(null);
              try {
                if (needsEmailForLink) {
                  await auth.completeEmailLink(window.location.href, email);
                } else {
                  await auth.sendEmailLink(email, `/login${next ? `?next=${encodeURIComponent(next)}` : ""}`);
                  setSent(true);
                }
              } catch (err) {
                setError(errorMessage(err));
              } finally {
                setBusy(null);
              }
            }}
          >
            <Field label={needsEmailForLink ? "Confirm your email to finish signing in" : "Email"} error={error}>
              {(f) => <Input id={f.id} aria-describedby={f.describedBy} invalid={f.invalid} type="email" autoComplete="email" inputSize="lg" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@studio.dev" required />}
            </Field>
            <Button type="submit" size="lg" className="w-full" loading={busy === "email"}>
              {needsEmailForLink ? "Finish signing in" : "Email me a sign-in link"}
            </Button>
          </form>
        </>
      )}
    </div>
  );
}

export default function LoginPage() {
  return (
    <div className="flex min-h-dvh flex-col bg-canvas">
      <header className="flex h-14 items-center px-5">
        <Link href="/" className="inline-flex items-center gap-2 rounded-md text-[17px] font-semibold tracking-[-0.02em]">
          <LogoMark size={24} /> MuseLaunch
        </Link>
      </header>
      <main className="flex flex-1 items-start justify-center px-5 pb-20 pt-[12vh]">
        <div className="w-full max-w-sm">
          <h1 className="mb-2 text-title-1 font-semibold">Sign in</h1>
          <p className="mb-8 text-body text-ink-2">New here? Signing in creates your account. Next you’ll add your app.</p>
          <Suspense fallback={<Spinner />}>
            <LoginInner />
          </Suspense>
          <p className="mt-10 text-footnote text-ink-3">
            By continuing you agree to the{" "}
            <Link href="/terms" className="underline underline-offset-2 hover:text-ink">
              Terms
            </Link>{" "}
            and that MuseLaunch processes your app’s public listing and the files you upload to create marketing material for you, as the{" "}
            <Link href="/privacy" className="underline underline-offset-2 hover:text-ink">
              Privacy Policy
            </Link>{" "}
            describes.
          </p>
        </div>
      </main>
    </div>
  );
}
