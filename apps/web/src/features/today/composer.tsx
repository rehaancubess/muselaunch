"use client";
/**
 * "What should we make?": the hands-on way to start a campaign (Creator → Make, and Today when
 * Autopilot's automatic start is off). Opens the new-campaign page with the request filled in, where
 * goals, channels and the credit cost are shown before anything runs.
 */
import { Button } from "@muselaunch/ui";
import { ArrowUp } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

function suggestions(appName: string) {
  return [
    { label: "Launch Reels", text: `Create five vertical Reels introducing ${appName}, with a premium, minimal Apple-style look.` },
    { label: "Feature demo", text: `Make a 20-second demo of ${appName}'s most useful feature, using real screen recordings on an animated iPhone.` },
    { label: "Founder story", text: `Plan a founder-story video for ${appName}: why I built it and who it's for.` },
    { label: "Store screenshots", text: `Design a set of App Store screenshot graphics for ${appName} that highlight confirmed features.` },
  ];
}

export function Composer({ appName, href }: { appName: string; href: (text: string) => string }) {
  const router = useRouter();
  const [text, setText] = useState("");
  const submit = () => router.push(href(text.trim()));
  return (
    <div className="space-y-4">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="group relative rounded-2xl bg-surface shadow-[0_1px_2px_rgb(16_24_40/0.04),0_0_0_1px_rgb(16_24_40/0.08),0_12px_32px_-16px_rgb(16_24_40/0.16)] transition-shadow focus-within:shadow-[0_0_0_1px_var(--ml-accent),0_0_0_4px_color-mix(in_srgb,var(--ml-accent)_14%,transparent),0_12px_32px_-16px_rgb(16_24_40/0.16)]"
      >
        <label htmlFor="creator-request" className="sr-only">
          Describe the campaign you want
        </label>
        <textarea
          id="creator-request"
          rows={3}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
          }}
          placeholder={`Describe what you want to make for ${appName}…`}
          className="block w-full resize-none rounded-2xl bg-transparent px-5 pb-16 pt-4 text-body text-ink outline-none placeholder:text-ink-3"
        />
        <div className="absolute inset-x-3 bottom-3 flex items-center justify-between gap-3">
          <p className="hidden pl-2 text-caption text-ink-3 sm:block">You’ll pick goals, channels and see the credit cost before anything runs.</p>
          <Button type="submit" size="lg" className="ml-auto" trailing={<ArrowUp className="size-4" aria-hidden />}>
            Plan campaign
          </Button>
        </div>
      </form>
      <div className="flex flex-wrap gap-2">
        {suggestions(appName).map((s) => (
          <button
            key={s.label}
            type="button"
            onClick={() => setText(s.text)}
            className="min-h-11 rounded-full border border-line bg-surface px-3.5 text-footnote text-ink-2 transition-colors hover:border-line-strong hover:text-ink focus-visible:outline-none focus-visible:shadow-focus sm:min-h-9"
          >
            {s.label}
          </button>
        ))}
      </div>
    </div>
  );
}
