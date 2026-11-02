"use client";
/**
 * Asking for real footage of the app, where Autopilot needs it. Videos only show the real app, and an
 * app added from its website has no screenshots, so:
 *  - <RecordingFirst/>: on the run's progress screen as soon as that's known (`progress.media.ask` =
 *    "early"), before the run reaches the videos: one screen recording, any device;
 *  - <MediaDecisionFootage/>: inside the Needs-you card while the run is stopped at that decision
 *    ("waiting", the `produce:media` checkpoint), with Continue as the next step once a recording is in.
 * Uploading never continues the run by itself: Continue is the existing approval route.
 */
import type { AutopilotProgress } from "@muselaunch/contracts";
import { Spinner, cn } from "@muselaunch/ui";
import { AlertTriangle, CheckCircle2, MonitorSmartphone } from "lucide-react";
import Link from "next/link";
import { RecordingTips, WalkthroughExplainer, WalkthroughUpload, useWalkthroughs } from "@/features/media/walkthrough";
import { routes } from "@/lib/routes";
import { useWorkspace } from "@/lib/workspace";

export type RecordingState = { state: "none" | "processing" | "ready" | "failed"; clips: number; loading: boolean };

/** The app's newest screen recording, in plain states (no appId = not asked; nothing is fetched). */
export function useRecordingState(workspaceId: string, appId?: string | null): RecordingState {
  const { recordings, segments, loading } = useWalkthroughs(workspaceId, appId ?? "");
  const latest = recordings[0];
  if (!appId || !latest) return { state: "none", clips: 0, loading: Boolean(appId) && loading };
  const clips = segments.filter((s) => s.assetId === latest.id).length;
  if (latest.status === "failed") return { state: "failed", clips, loading: false };
  return { state: clips || latest.status === "ready" ? "ready" : "processing", clips, loading: false };
}

/** One line once a recording is in: what happens to it next. */
function AddedLine({ rec, next }: { rec: RecordingState; next: string }) {
  if (rec.state === "failed") {
    return (
      <p className="flex items-start gap-2 text-footnote text-warning text-pretty">
        <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
        Your recording couldn’t be processed. Try another file.
      </p>
    );
  }
  return (
    <p className="flex items-start gap-2 text-footnote text-ink-2 text-pretty" role="status">
      {rec.state === "processing" ? <Spinner className="mt-0.5 size-3.5 shrink-0" /> : <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />}
      <span>
        <span className="font-medium text-ink">{rec.state === "ready" && rec.clips ? `Recording ready: ${rec.clips} clip${rec.clips === 1 ? "" : "s"}.` : "Recording added."}</span> {next}
      </span>
    </p>
  );
}

/**
 * The progress screen, before the videos: the app has no screenshots or recordings (e.g. added from
 * its website). Prominent, but the run keeps working on research and ideas meanwhile.
 */
export function RecordingFirst({ appId, source, className }: { appId: string; source: AutopilotProgress["source"]; className?: string }) {
  const { workspaceId, can } = useWorkspace();
  const rec = useRecordingState(workspaceId, appId);
  if (rec.loading) return null;
  const has = rec.state === "processing" || rec.state === "ready";
  return (
    <section aria-labelledby={`recording-first-${appId}`} className={cn("space-y-4 rounded-2xl bg-surface p-5 shadow-raised ring-1 ring-accent/25 sm:p-6", className)}>
      <div className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent-ink">
          <MonitorSmartphone className="size-5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1 space-y-1">
          <h3 id={`recording-first-${appId}`} className="text-headline font-semibold text-ink text-balance">
            {has ? "Your videos will show the real app" : "Add a screen recording so your videos show the real app"}
          </h3>
          <p className="text-body-sm text-ink-2 text-pretty">
            {has
              ? "Autopilot uses your recording when it makes the videos."
              : `${source === "website" ? "Your app was added from its website, so MuseLaunch has no screenshots or recordings of it yet." : "MuseLaunch has no screenshots or recordings of your app yet."} One recording is enough for every video. Autopilot keeps working on the rest meanwhile.`}
          </p>
        </div>
      </div>
      {rec.state !== "none" ? <AddedLine rec={rec} next={rec.state === "processing" ? "It’s being cut into clips for your videos." : "Your videos will use it."} /> : null}
      {has ? null : can("content.write") ? (
        <>
          <WalkthroughExplainer />
          <WalkthroughUpload workspaceId={workspaceId} appId={appId} primary />
        </>
      ) : (
        <p className="text-footnote text-ink-2">Ask an editor, admin or owner to add a screen recording.</p>
      )}
    </section>
  );
}

/**
 * Inside the "Add a screen recording or screenshots of your app" decision card: the upload right
 * there, then a plain line saying Continue makes the videos with it.
 */
export function MediaDecisionFootage({ appId, rec, compact }: { appId: string; rec: RecordingState; compact?: boolean }) {
  const { workspaceId, can } = useWorkspace();
  const has = rec.state === "processing" || rec.state === "ready";
  return (
    <div className="space-y-3">
      {rec.state !== "none" ? <AddedLine rec={rec} next={rec.state === "processing" ? "Press Continue: Autopilot waits for its clips, then makes your videos with them." : rec.state === "ready" ? "Press Continue to make your videos with it." : ""} /> : null}
      {has ? null : can("content.write") ? (
        <>
          <p className="text-footnote text-pretty">
            <span className="font-medium text-ink">One screen recording of your app, 1–5 minutes,</span> <span className="text-ink-2">from a phone, tablet, computer or TV. Go through the main features at a calm pace.</span>
          </p>
          {compact ? null : <RecordingTips />}
          <WalkthroughUpload workspaceId={workspaceId} appId={appId} primary />
        </>
      ) : (
        <p className="text-footnote text-ink-2">Ask an editor, admin or owner to add a screen recording.</p>
      )}
      {has ? null : (
        <p className="text-caption text-ink-3">
          Or add screenshots on the{" "}
          <Link href={routes.app(workspaceId, appId).videos} className="font-medium text-accent hover:underline">
            Videos page
          </Link>
          , then press Continue.
        </p>
      )}
    </div>
  );
}
