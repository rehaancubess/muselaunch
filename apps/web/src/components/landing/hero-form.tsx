"use client";
import { ArrowRight, Link2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useAuth } from "@/lib/auth/auth-provider";
import { routes } from "@/lib/routes";

/** Hero: paste a store link → sign in → onboarding with the link prefilled. */
export function HeroLinkForm() {
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

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        go();
      }}
      className="w-full"
      noValidate
    >
      <label htmlFor="hero-link" className="sr-only">
        Your App Store, Google Play or website link
      </label>
      <div className="flex w-full items-center gap-2 rounded-full bg-surface p-1.5 pl-5 shadow-[0_1px_2px_rgb(16_24_40/0.05),0_0_0_1px_rgb(16_24_40/0.1),0_18px_40px_-20px_rgb(51_85_255/0.35)] transition-shadow focus-within:shadow-[0_0_0_1px_var(--ml-accent),0_0_0_5px_rgb(51_85_255/0.14),0_18px_40px_-20px_rgb(51_85_255/0.4)]">
        <Link2 className="size-[18px] shrink-0 text-ink-3" aria-hidden />
        <input
          id="hero-link"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
          }}
          inputMode="url"
          autoComplete="url"
          placeholder="apps.apple.com/app/your-app"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "hero-link-error" : "hero-link-hint"}
          className="h-11 min-w-0 flex-1 bg-transparent text-body text-ink outline-none placeholder:text-ink-3 sm:text-headline"
        />
        <button
          type="submit"
          className="inline-flex h-11 shrink-0 items-center gap-2 rounded-full bg-accent px-4 text-body-sm font-medium text-white transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:shadow-focus sm:px-5 sm:text-body"
        >
          <span className="hidden sm:inline">Start with my app</span>
          <span className="sm:hidden">Start</span>
          <ArrowRight className="size-4" aria-hidden />
        </button>
      </div>
      {error ? (
        <p id="hero-link-error" role="alert" className="mt-3 text-center text-footnote text-danger">
          {error}
        </p>
      ) : (
        <p id="hero-link-hint" className="mt-3 text-center text-footnote text-ink-2">
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
      <a href={routes.login()} className="inline-flex h-8 items-center rounded-full bg-ink px-3.5 text-footnote font-medium text-white hover:bg-ink/85">
        Open MuseLaunch
      </a>
    );
  }
  return (
    <div className="flex items-center gap-1">
      <a href={routes.login()} className="inline-flex h-8 items-center rounded-full px-3 text-footnote font-medium text-ink-2 hover:bg-mist hover:text-ink">
        Sign in
      </a>
      <a href={routes.login(routes.onboarding())} className="inline-flex h-8 items-center rounded-full bg-ink px-3.5 text-footnote font-medium text-white hover:bg-ink/85">
        Get started
      </a>
    </div>
  );
}
