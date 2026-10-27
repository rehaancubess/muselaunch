"use client";
import { Spinner } from "@muselaunch/ui";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { useAuth } from "@/lib/auth/auth-provider";
import { routes } from "@/lib/routes";
import { LogoMark } from "./logo";

export function FullPageLoader({ label = "Loading" }: { label?: string }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-5" role="status" aria-label={label}>
      <LogoMark size={36} />
      <Spinner size={18} />
    </div>
  );
}

/** Redirects signed-out visitors to /login?next=<current path>. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  useEffect(() => {
    if (status === "signed_out") router.replace(routes.login(pathname ?? undefined));
  }, [status, router, pathname]);
  if (status !== "signed_in") return <FullPageLoader />;
  return <>{children}</>;
}
