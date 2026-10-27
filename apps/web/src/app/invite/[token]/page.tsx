"use client";
import { Button, ErrorState } from "@muselaunch/ui";
import { Users } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { LogoMark } from "@/components/logo";
import { RequireAuth } from "@/components/require-auth";
import { api, errorMessage } from "@/lib/api";
import type { AcceptInviteResponse } from "@/lib/api-types";
import { useAuth } from "@/lib/auth/auth-provider";
import { useInvalidate } from "@/lib/query";
import { routes } from "@/lib/routes";

function AcceptInvite() {
  const { token } = useParams<{ token: string }>();
  const { user, signOut } = useAuth();
  const router = useRouter();
  const invalidate = useInvalidate();
  const [state, setState] = useState<"idle" | "busy" | "error">("idle");
  const [err, setErr] = useState<string | null>(null);

  const accept = async () => {
    setState("busy");
    try {
      const r = await api.post<AcceptInviteResponse>(`/v1/invites/${encodeURIComponent(String(token))}/accept`);
      await invalidate("/v1/me");
      router.replace(routes.workspace(r.workspaceId));
    } catch (e) {
      setErr(errorMessage(e));
      setState("error");
    }
  };

  if (state === "error") {
    return (
      <div className="space-y-4">
        <ErrorState title="Couldn’t accept the invite" message={err ?? undefined} onRetry={accept} />
        <div className="flex justify-center gap-2">
          <Button variant="secondary" onClick={() => void signOut()}>
            Sign in with another account
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 text-center">
      <div className="mx-auto flex size-14 items-center justify-center rounded-full bg-accent-soft text-accent">
        <Users className="size-6" aria-hidden />
      </div>
      <div className="space-y-2">
        <h1 className="text-title-2 font-semibold">Join a workspace</h1>
        <p className="text-body text-ink-2">
          You’ve been invited to collaborate on MuseLaunch. You’re signed in as <span className="font-medium text-ink">{user?.email}</span>; the invite must be for this address.
        </p>
      </div>
      <Button size="lg" className="w-full" onClick={accept} loading={state === "busy"}>
        Accept invite
      </Button>
    </div>
  );
}

export default function InvitePage() {
  return (
    <RequireAuth>
      <div className="flex min-h-dvh flex-col">
        <header className="flex h-14 items-center px-5">
          <Link href="/" className="inline-flex items-center gap-2 text-[17px] font-semibold tracking-[-0.02em]">
            <LogoMark size={24} /> MuseLaunch
          </Link>
        </header>
        <main className="flex flex-1 items-start justify-center px-5 pt-[14vh]">
          <div className="w-full max-w-sm">
            <AcceptInvite />
          </div>
        </main>
      </div>
    </RequireAuth>
  );
}
