/**
 * Edit: "Tell Muse what to change", typed or said (hold to talk). The words go to the same route as
 * the web (POST /posts/:id/change): a video change runs Muse Spark's scene-scoped edit on the
 * editable video and a new final render; a caption change rewrites the copy and checks it against
 * the app's facts again. The real cost is shown first (GET /posts/:id/change/estimate); the new
 * version waits for the person's OK before it can post.
 */
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { View } from "react-native";
import { errorMessage, type Api } from "../../api/client";
import { useRefresh } from "../../api/hooks";
import type { EstimateResponse, PostChangePart, TodayPost } from "../../api/types";
import { fullNumber } from "../../lib/results-lines";
import { useSession } from "../../session";
import { Button, Chip, Field, Notice, Sheet, T } from "../../ui/components";
import { color } from "../../ui/theme";
import { useToast } from "../../ui/toast";
import { HoldToTalk } from "../voice/hold-to-talk";

const CHIPS: Record<PostChangePart, { label: string; text: string }[]> = {
  video: [
    { label: "Shorter", text: "Make it shorter" },
    { label: "Different start", text: "Try a different start that hooks people faster" },
    { label: "More energetic", text: "Make it more energetic" },
  ],
  caption: [
    { label: "Shorter", text: "Make the caption shorter" },
    { label: "Friendlier", text: "Make the caption friendlier" },
    { label: "Start with a question", text: "Start the caption with a question" },
  ],
};

export function useChangeEstimate(api: Api, postId: string, part: PostChangePart, enabled: boolean) {
  return useQuery({
    queryKey: ["change-estimate", api.ws(), postId, part],
    queryFn: () => api.get<EstimateResponse>(api.ws(`/posts/${postId}/change/estimate`), { part }),
    enabled,
    staleTime: 60_000,
    retry: false,
  });
}

export function costLine(est: EstimateResponse | undefined): { text: string | null; short: boolean } {
  if (!est) return { text: null, short: false };
  const short = est.credits > est.available;
  return { text: short ? `Needs about ${fullNumber(est.credits)} credits; ${fullNumber(Math.max(0, est.available))} left` : `Uses about ${fullNumber(est.credits)} credits`, short };
}

export function EditSheet({ post, open, onClose }: { post: TodayPost; open: boolean; onClose: () => void }) {
  const { api } = useSession();
  const toast = useToast();
  const refresh = useRefresh();
  const hasVideo = Boolean(post.compositionId);
  const [part, setPart] = useState<PostChangePart>(hasVideo ? "video" : "caption");
  const [text, setText] = useState("");
  const [spoken, setSpoken] = useState(false);
  const [busy, setBusy] = useState(false);
  const [voiceBusy, setVoiceBusy] = useState(false);
  useEffect(() => {
    if (!open) {
      setText("");
      setSpoken(false);
    }
  }, [open]);
  const est = useChangeEstimate(api, post.id, part, open && post.canChange);
  const cost = costLine(est.data);
  const ready = text.trim().length >= 3 && !cost.short && !voiceBusy;

  const submit = async () => {
    setBusy(true);
    try {
      await api.post(api.ws(`/posts/${post.id}/change`), { part, instruction: text.trim(), spoken });
      toast({ title: "Muse is on it", body: part === "video" ? "Only the scenes it needs to touch change. The new version waits for your OK." : "The new caption is checked against your facts, then waits for your OK." });
      onClose();
      await refresh("today", "job");
    } catch (e) {
      toast({ title: "Muse couldn’t start that change", body: errorMessage(e), tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Tell Muse what to change"
      footer={
        <View style={{ gap: 8 }}>
          <Button title="Make this change" onPress={() => void submit()} loading={busy} disabled={!ready} />
          <T v="caption" style={{ textAlign: "center" }}>
            {[cost.text ?? (est.isLoading ? "Checking the cost…" : null), part === "video" ? "only the scenes it needs change" : "checked against your facts", "you OK it before it posts"].filter(Boolean).join(" · ")}
          </T>
        </View>
      }
    >
      {hasVideo ? (
        <View style={{ flexDirection: "row", gap: 8 }}>
          <Chip label="Video" selected={part === "video"} onPress={() => setPart("video")} />
          <Chip label="Caption" selected={part === "caption"} onPress={() => setPart("caption")} />
        </View>
      ) : null}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {CHIPS[part].map((c) => (
          <Chip
            key={c.label}
            label={c.label}
            selected={text === c.text}
            onPress={() => {
              setText(c.text);
              setSpoken(false);
            }}
          />
        ))}
      </View>
      <Field
        value={text}
        onChangeText={(t) => {
          setText(t);
          setSpoken(false);
        }}
        placeholder={part === "video" ? "e.g. Make the opening shorter" : "e.g. Make it friendlier and shorter"}
        multiline
        maxLength={2000}
        accessibilityLabel="What to change"
        editable={!voiceBusy}
      />
      {spoken ? (
        <T v="caption" style={{ marginTop: -8 }}>
          From what you said. Check it, then tap the button.
        </T>
      ) : null}
      <HoldToTalk
        onBusyChange={setVoiceBusy}
        onText={(t) => {
          setText(t);
          setSpoken(true);
        }}
      />
      {cost.short ? <Notice tone="warning">There aren’t enough credits for this change. Add credits on the web, or change the caption instead.</Notice> : null}
      {!post.canChange ? <Notice>This post can’t change any more (it’s out, or you have view access).</Notice> : null}
      <T v="footnote" style={{ color: color.ink3 }}>
        Want to edit scene by scene? Open the post in MuseLaunch on the web.
      </T>
    </Sheet>
  );
}
