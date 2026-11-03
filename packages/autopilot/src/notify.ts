/**
 * Notifications sent by the server as an Autopilot run moves (phones and browsers, platform/push.ts),
 * so they arrive with every MuseLaunch tab closed:
 *  - the app's first run moved past its ideas into making the videos: "Muse has finished studying …";
 *  - a run stopped for a decision (awaiting_user): "Muse needs you for a moment", once per decision.
 * "Your first videos are ready" goes out where the first run drafts its posts (stages.ts schedule).
 * Never throws into the step that caused it.
 */
import type { Autopilot, Capability } from "@muselaunch/contracts";
import { APPROVER_CAP } from "@muselaunch/growth";
import { notifyFirstRunStudied, notifyRunNeedsYou, type Platform } from "@muselaunch/platform";
import { reasonText, STAGE_ORDER } from "./state";

const MAKING = STAGE_ORDER.indexOf("produce");
const LOOKBACK = 20;

/**
 * The app's first Autopilot run, first round (Home shows it as "Getting to know <app>"): no run of
 * this app started before it.
 */
export async function isFirstRun(p: Platform, ap: Pick<Autopilot, "id" | "workspaceId" | "appId" | "iteration">): Promise<boolean> {
  if (ap.iteration !== 1) return false;
  const page = await p.db.ws(ap.workspaceId).collection("autopilots").list({ where: [["appId", "==", ap.appId]], orderBy: { field: "createdAt", dir: "desc" }, limit: LOOKBACK });
  const i = page.items.findIndex((a) => a.id === ap.id);
  // It's the oldest run here, and the page reaches back far enough to know there's none before it.
  return i >= 0 && i === page.items.length - 1 && page.items.length < LOOKBACK;
}

/** "Add a screen recording…" → "add a screen recording…" (it follows "<App>: "). */
const sentence = (s: string) => (/^[A-Z][a-z]/.test(s) ? `${s[0]!.toLowerCase()}${s.slice(1)}` : s);

/** After a step was saved: tell people about the moments it crossed (before → after). */
export async function notifyAfterStep(p: Platform, before: Autopilot, after: Autopilot): Promise<void> {
  try {
    const run = { id: after.id, appId: after.appId, startedBy: after.createdBy };
    const was = STAGE_ORDER.indexOf(before.stage);
    const now = STAGE_ORDER.indexOf(after.stage);
    if (was < MAKING && now >= MAKING && after.iteration === before.iteration && after.status !== "failed" && after.status !== "cancelled" && (await isFirstRun(p, after))) {
      await notifyFirstRunStudied(p, after.workspaceId, run);
    }
    const approvalId = after.status === "awaiting_user" ? after.waitingOn.approvalId : undefined;
    if (approvalId && !(before.status === "awaiting_user" && before.waitingOn.approvalId === approvalId)) {
      const approval = await p.db.ws(after.workspaceId).collection("approvals").get(approvalId);
      // Who can answer it: the checkpoint routes need content.approve plus the action's approver capability.
      const caps: Capability[] = ["content.approve", ...(approval ? [APPROVER_CAP[approval.action]] : [])];
      const what = reasonText(after.waitingOn.reason);
      await notifyRunNeedsYou(p, after.workspaceId, { ...run, kind: "autopilot" }, { key: approvalId, what: what ? sentence(what) : undefined, caps });
    }
  } catch (err) {
    p.log.warn({ err: { message: (err as Error).message }, autopilotId: after.id }, "Autopilot notification skipped");
  }
}
