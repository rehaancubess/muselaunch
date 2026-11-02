/**
 * Plain words for the run's progress screen that depend only on data (no React), so they can be
 * unit-tested: what the current step is doing, and when to ask for a screen recording.
 */
import type { Autopilot, AutopilotProgress, AutopilotProgressStepKey } from "@muselaunch/contracts";

type Source = AutopilotProgress["source"];
/** Absent on an older API response. */
type Media = AutopilotProgress["media"] | undefined;

/** What the videos are built from: only the footage that really exists ("from your recording"). */
export function makeLine(media: Media): string {
  const plan = "Writing a plan for each video";
  if (!media) return `${plan} and building it`;
  const rec = media.recordings > 1 ? "your recordings" : "your recording";
  if (media.recordings && media.screenshots) return `${plan} and building it from ${rec} and screenshots`;
  if (media.recordings) return `${plan} and building it from ${rec}`;
  if (media.screenshots) return `${plan} and building it from your screenshots`;
  return plan;
}

/** What the current step is doing, in plain words (the jobs' own wording stays in Show details). */
export function doingLine(key: AutopilotProgressStepKey, source: Source, media: Media): string {
  const from = source === "website" ? "your website" : source === "description" ? "your description" : "the listing";
  switch (key) {
    case "read":
      return source === "website" ? "Reading the page" : source === "description" ? "Saving your description" : "Saving the listing and its screenshots";
    case "learn":
      return `Working out features, audiences and facts from ${from}`;
    case "research":
      return "Searching the web; every finding keeps its source";
    case "ideas":
      return "Writing different ideas, then picking the ones to compare";
    case "make":
      return makeLine(media);
    case "check":
      return "Checking every fact and the brand, fixing what it can";
    case "finish":
      return "Rendering the final videos and watching each one";
    case "ready":
      return "Writing the post captions";
  }
}

const ACTIVE: readonly Autopilot["status"][] = ["running", "waiting_on_jobs", "awaiting_user", "sleeping", "paused"];

/**
 * Whether the progress screen shows "Add a screen recording so your videos show the real app": the
 * server says there's no footage yet ("early"), or it said so earlier on this screen (so the card
 * doesn't vanish right after an upload). Not while the run waits on the decision (the Needs-you
 * card has the upload then), once videos exist, or after the run ended.
 */
export function showRecordingFirst(input: { ask: NonNullable<Media>["ask"] | undefined; shownBefore: boolean; status: Autopilot["status"]; videosBuilt: number }): boolean {
  if (input.ask === "waiting" || input.videosBuilt > 0 || !ACTIVE.includes(input.status)) return false;
  return input.ask === "early" || input.shownBefore;
}
