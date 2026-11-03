import { CircleCheck, TriangleAlert } from "lucide-react-native";
import { View } from "react-native";
import { useJob } from "../../api/hooks";
import type { PostChange } from "../../api/types";
import { ProgressBar, Spinner, T } from "../../ui/components";
import { color } from "../../ui/theme";

const DOING: Record<PostChange["status"], string> = {
  editing: "Muse Spark is changing the video",
  rendering: "Making the new video",
  rewriting: "Muse Spark is rewriting the caption",
  done: "Done",
  failed: "Didn’t work",
};

/** What Muse is doing to the post right now, from its real job. */
export function ChangeProgress({ change }: { change: PostChange }) {
  const job = useJob(change.jobId).data;
  const raw = job?.status === "running" ? Math.round(job.progress?.pct ?? 0) : null;
  const pct = raw !== null && raw > 0 && raw < 100 ? raw : null;
  const steps = change.part === "video" ? (change.status === "editing" ? "Step 1 of 2 · " : "Step 2 of 2 · ") : "";
  return (
    <View style={{ gap: 8, borderRadius: 16, backgroundColor: color.mist, padding: 14 }} accessibilityLiveRegion="polite">
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Spinner />
        <T v="bodySm" style={{ fontWeight: "600", flex: 1 }}>
          {DOING[change.status]}
          {pct !== null ? <T v="bodySm" style={{ color: color.ink2 }}>{` · ${pct}%`}</T> : null}
        </T>
      </View>
      <ProgressBar value={pct} />
      <T v="footnote">{`${steps}“${change.instruction}”. You can close the app: when it’s ready, the post waits for your OK again.`}</T>
    </View>
  );
}

/** One line on the last change: what changed, or why it didn't. */
export function ChangeResult({ change, waiting }: { change: PostChange; waiting: boolean }) {
  if (change.status === "failed")
    return (
      <View style={{ flexDirection: "row", gap: 8 }}>
        <TriangleAlert size={16} color={color.warning} style={{ marginTop: 2 }} />
        <T v="footnote" style={{ flex: 1 }}>
          <T v="footnote" style={{ fontWeight: "600", color: color.ink }}>
            Not changed:{" "}
          </T>
          {change.note ?? "That didn’t work. Try saying it another way."}
        </T>
      </View>
    );
  if (change.status !== "done") return null;
  return (
    <View style={{ flexDirection: "row", gap: 8 }}>
      <CircleCheck size={16} color={color.success} style={{ marginTop: 2 }} />
      <T v="footnote" style={{ flex: 1 }}>
        <T v="footnote" style={{ fontWeight: "600", color: color.ink }}>
          {change.part === "video" ? "Muse changed the video" : "Muse changed the caption"}
          {change.summary ? ": " : "."}
        </T>
        {change.summary ? `${change.summary.replace(/[.\s]+$/, "")}.` : ""}
        {change.note ? ` ${change.note}` : waiting ? " It’s waiting for your OK again." : ""}
      </T>
    </View>
  );
}
