"use client";
/**
 * Create → Use a suggested idea: the best ideas Muse found for this app (Discover's picks, each with
 * its real source), "Look again", "See everything" and the accounts you follow, reused from Discover.
 * Using an idea fills the prompt and links the idea to the video.
 */
import { Button, Skeleton } from "@muselaunch/ui";
import { ArrowRight, Compass } from "lucide-react";
import Link from "next/link";
import { FollowedAccounts, IdeaCard, LookAgainBar, useLookAgain } from "@/features/discover/simple";
import { topPicks, type FeedItem } from "@/features/discover/picks";
import { errorMessage } from "@/lib/api";
import { routes } from "@/lib/routes";
import { useWorkspace } from "@/lib/workspace";

/** Ideas shown here (See everything has the rest). */
const SHOWN = 3;

export function IdeaPicker({ appId, items, loading, error, selectedId, onPick }: { appId: string; items: FeedItem[]; loading: boolean; error: unknown; selectedId: string | null; onPick: (item: FeedItem) => void }) {
  const { workspaceId } = useWorkspace();
  const research = useLookAgain(appId);
  const picks = topPicks(items, SHOWN);
  // A linked idea that isn't among the top ones (opened from elsewhere) still shows, first.
  const linked = selectedId && !picks.some((p) => p.refId === selectedId) ? items.find((i) => i.type === "opportunity" && i.refId === selectedId) : undefined;
  const shown = linked ? [linked, ...picks.slice(0, SHOWN - 1)] : picks;

  return (
    <section aria-labelledby="create-ideas" className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-1">
        <div className="space-y-0.5">
          <h2 id="create-ideas" className="text-headline font-semibold text-ink">
            Ideas Muse found for your app
          </h2>
          <p className="text-footnote text-ink-2">Each one shows where Muse found it. Pick one and it fills in your video above.</p>
        </div>
        <Link href={routes.app(workspaceId, appId).discoverAll} className="inline-flex min-h-11 items-center gap-1 text-footnote font-medium text-accent hover:underline">
          See everything
          <ArrowRight className="size-3.5" aria-hidden />
        </Link>
      </div>

      {loading ? (
        <div className="grid gap-3 md:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-56 w-full" rounded="xl" />
          ))}
        </div>
      ) : error ? (
        <p className="rounded-xl bg-mist/70 px-4 py-3 text-body-sm text-ink-2">Couldn’t load the ideas: {errorMessage(error)}</p>
      ) : shown.length ? (
        <div className="grid grid-cols-[minmax(0,1fr)] gap-3 md:grid-cols-3 md:gap-4">
          {shown.map((item) => (
            <IdeaCard key={item.id} item={item} appId={appId} compact onUse={onPick} selected={item.refId === selectedId} />
          ))}
        </div>
      ) : (
        <div className="flex items-start gap-3 rounded-2xl bg-mist/70 px-4 py-4">
          <Compass className="mt-0.5 size-5 shrink-0 text-ink-3" aria-hidden />
          <p className="text-body-sm text-ink-2 text-pretty">{research.running ? "Muse is looking. Ideas show up here as soon as they’re found, each with the page it came from." : "No ideas yet. Tap Look again and Muse checks what’s working for apps like yours, with a source for every idea."}</p>
        </div>
      )}

      <LookAgainBar research={research} variant="outline" />

      <div className="border-t border-line pt-6">
        <FollowedAccounts appId={appId} />
      </div>
      {!loading && items.length > shown.length ? (
        <Button asChild variant="outline" size="lg">
          <Link href={routes.app(workspaceId, appId).discoverAll}>
            See everything Muse found
            <ArrowRight className="size-4" aria-hidden />
          </Link>
        </Button>
      ) : null}
    </section>
  );
}
