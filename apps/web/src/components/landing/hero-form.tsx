"use client";
import { ArrowRight, Link2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useAuth } from "@/lib/auth/auth-provider";
import { routes } from "@/lib/routes";

/** Paste a store link → sign in → onboarding with the link prefilled. */
export function HeroLinkForm({ id = "hero-link" }: { id?: string }) {
  const router = useRouter();
  const { status } = useAuth();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  const go = () => {
    const t = value.trim();
    let dest = routes.onboarding();
    if (t) {
      const withScheme = /^https?:\/\//i.test(t) ? t : `https://${t}`;
      try {
        const u = new URL(withScheme);
        if (!u.hostname.includes(".")) throw new Error("bad");
        dest = `${routes.onboarding()}?app=${encodeURIComponent(u.toString())}`;
      } catch {
        setError("That doesn’t look like a link. Try your App Store, Google Play or website URL.");
        return;
      }
    }
    router.push(status === "signed_in" ? dest : routes.login(dest));
  };

  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        go();
      }}
      className="w-full"
      noValidate
    >
      <label htmlFor={id} className="sr-only">
        Your App Store, Google Play or website link
      </label>
      <div className="flex w-full items-center gap-2 rounded-full bg-surface p-1.5 pl-5 shadow-[0_0_0_1px_rgb(0_0_0/0.1),0_1px_2px_rgb(0_0_0/0.05),0_12px_32px_-12px_rgb(0_0_0/0.16)] transition-shadow focus-within:shadow-[0_0_0_1.5px_var(--ml-accent),0_0_0_5px_rgb(51_85_255/0.14),0_12px_32px_-12px_rgb(0_0_0/0.16)]">
        <Link2 className="hidden size-[18px] shrink-0 text-ink-3 sm:block" aria-hidden />
        <input
          id={id}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
          }}
          inputMode="url"
          autoComplete="url"
          placeholder="apps.apple.com/app/your-app"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : hintId}
          className="h-11 min-w-0 flex-1 bg-transparent text-body text-ink outline-none placeholder:text-ink-3 focus-visible:outline-none sm:h-12 sm:text-headline"
        />
        <button
          type="submit"
          className="inline-flex h-11 shrink-0 items-center gap-2 rounded-full bg-accent px-4 text-body-sm font-medium text-white transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:shadow-focus sm:h-12 sm:px-6 sm:text-body"
        >
          <span className="hidden sm:inline">Start with my app</span>
          <span className="sm:hidden">Start</span>
          <ArrowRight className="size-4" aria-hidden />
        </button>
      </div>
      {error ? (
        <p id={errorId} role="alert" className="mt-3 text-center text-footnote text-danger text-balance">
          {error}
        </p>
      ) : (
        <p id={hintId} className="mt-3 text-center text-footnote text-ink-2 text-balance">
          No listing yet? Leave it empty and describe your app instead.
        </p>
      )}
    </form>
  );
}

export function NavAuthButtons() {
  const { status } = useAuth();
  if (status === "signed_in") {
    return (
      <a href={routes.login()} className="inline-flex h-8 items-center rounded-full bg-ink px-3.5 text-footnote font-medium text-white transition-colors hover:bg-ink/85">
        Open MuseLaunch
      </a>
    );
  }
  return (
    <div className="flex items-center gap-1">
      <a href={routes.login()} className="inline-flex h-8 items-center rounded-full px-3 text-footnote font-medium text-ink-2 transition-colors hover:text-ink">
        Sign in
      </a>
      <a href={routes.login(routes.onboarding())} className="inline-flex h-8 items-center rounded-full bg-ink px-3.5 text-footnote font-medium text-white transition-colors hover:bg-ink/85">
        Get started
      </a>
    </div>
  );
}
