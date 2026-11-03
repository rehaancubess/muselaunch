"use client";
/**
 * A text post as it will read where it goes: the app's icon and name as the author, the post text,
 * and under it how long it is against the channel's limit (X 280, Threads 500, LinkedIn 3000…) and
 * whether the fact check passed. Copy puts the exact text on the clipboard. Nothing is posted here.
 */
import type { Channel } from "@muselaunch/contracts";
import { cn } from "@muselaunch/ui";
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import { AppIcon } from "@/components/app-icon";
import { ChannelMark } from "@/components/channel-mark";
import { CHANNEL_LABEL } from "@/lib/labels";
import { useWorkspace } from "@/lib/workspace";
import { textCount } from "@/features/create/plan";

/** What each channel calls the author line under the name. */
const HANDLE_HINT: Partial<Record<Channel, string>> = { x: "Post on X", threads: "Thread", linkedin: "Post", reddit: "Text post", facebook: "Post" };

export function TextPostCard({ text, channel, ok, className, clamp }: { text: string; channel: Channel; ok?: boolean | null; className?: string; clamp?: boolean }) {
  const { app, workspaceId } = useWorkspace();
  const count = textCount(text, channel);
  const name = app?.name?.split(/\s*:\s+|\s+[-–—|]\s+/)[0] || "Your app";
  const pct = count.limit ? Math.min(1, count.used / count.limit) : 0;
  return (
    <figure className={cn("min-w-0 rounded-2xl bg-surface p-4 shadow-raised sm:p-5", className)}>
      <figcaption className="flex items-center gap-2.5">
        <AppIcon app={app} workspaceId={workspaceId} size={36} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-body-sm font-semibold text-ink">{name}</p>
          <p className="truncate text-caption text-ink-3">{HANDLE_HINT[channel] ?? "Post"}</p>
        </div>
        <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-mist px-2 py-1 text-caption font-medium text-ink-2">
          <ChannelMark channel={channel} size={14} />
          {CHANNEL_LABEL[channel] ?? channel}
        </span>
      </figcaption>
      <blockquote className={cn("mt-3 whitespace-pre-line break-words text-body text-ink", clamp && "line-clamp-6")}>{text}</blockquote>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-line pt-3">
        {ok === undefined || ok === null ? (
          <span />
        ) : ok ? (
          <span className="inline-flex items-center gap-1.5 text-footnote font-medium text-success">
            <CheckCircle2 className="size-4" aria-hidden />
            Facts checked
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 text-footnote font-medium text-warning">
            <AlertTriangle className="size-4" aria-hidden />
            Needs a look
          </span>
        )}
        {count.limit ? (
          <span className={cn("inline-flex items-center gap-2 text-footnote tabular", count.over ? "font-medium text-danger" : "text-ink-2")}>
            <span className="relative h-1.5 w-16 overflow-hidden rounded-full bg-mist-2" aria-hidden>
              <span className={cn("absolute inset-y-0 left-0 rounded-full", count.over ? "bg-danger" : pct > 0.9 ? "bg-warning" : "bg-ink-3")} style={{ width: `${Math.max(4, pct * 100)}%` }} />
            </span>
            <span>
              {count.used.toLocaleString()} / {count.limit.toLocaleString()}
              <span className="sr-only"> characters{count.over ? ", over the limit" : ""}</span>
            </span>
          </span>
        ) : (
          <span className="text-footnote tabular text-ink-2">{count.used.toLocaleString()} characters</span>
        )}
      </div>
    </figure>
  );
}
