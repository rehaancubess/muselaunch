/**
 * Home's next post: the video, its title, where it goes, the caption and when, with Schedule post /
 * Edit / Skip (the same publish decision as the web: same route, permission and snapshot check).
 * A post the person posts themselves gets "Share to Instagram…" once it's scheduled.
 */
import { CalendarDays, Info, Share as ShareIcon } from "lucide-react-native";
import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { errorMessage } from "../../api/client";
import { useRefresh } from "../../api/hooks";
import { isPostChangeRunning, type TodayPost } from "../../api/types";
import { canSchedule, channelLabel, postBody, postState, postTimeLine, postTitle, whenInSentence, whoCanDecide } from "../../lib/home-lines";
import { shareLabel, shareMode } from "../../lib/share";
import { useSession, useTimezone } from "../../session";
import { ChannelName } from "../../ui/channel";
import { Button, Card, Notice, T } from "../../ui/components";
import { color } from "../../ui/theme";
import { useToast } from "../../ui/toast";
import { ChangeProgress, ChangeResult } from "./change-progress";
import { EditSheet } from "./edit-sheet";
import { PostThumb } from "./post-video";
import { ShareSheet } from "./share-sheet";
import { useAccent } from "../../ui/accent";

const recent = (iso?: string) => Boolean(iso && Date.now() - Date.parse(iso) < 86_400_000);

export function NextPostCard({ post }: { post: TodayPost }) {
  const ac = useAccent();
  const { api } = useSession();
  const tz = useTimezone();
  const toast = useToast();
  const refresh = useRefresh();
  const [editing, setEditing] = useState(false);
  const [share, setShare] = useState<null | "share" | "ask">(null);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const channel = channelLabel(post.channel);
  const manual = post.mode === "manual";
  const running = isPostChangeRunning(post.change);
  const state = postState(post);
  const title = postTitle(post);
  const caption = postBody(post);
  const when = post.scheduledAt ? whenInSentence(post.scheduledAt, tz) : null;
  const mode = shareMode(post);

  const decide = async (which: "approve" | "reject") => {
    const route = which === "approve" ? post.decision?.approve : post.decision?.reject;
    if (!route) return;
    setBusy(which);
    try {
      await api.post(api.ws(route.path), route.body ?? {});
      if (which === "approve")
        toast({
          title: "Post scheduled",
          body: manual ? `It’s ready for you to post on ${channel}${when ? ` ${when}` : ""}: tap ${shareLabel(post.channel)}` : `It goes out on ${channel}${when ? ` ${when}` : ""}, through your connected account.`,
        });
      else toast({ title: "Skipped", body: "Nothing was posted." });
      await refresh("today", "calendar");
    } catch (e) {
      toast({ title: "Couldn’t record that", body: errorMessage(e), tone: "error" });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card style={{ gap: 16 }}>
      <View style={styles.top}>
        <PostThumb post={post} style={{ width: 124 }} />
        <View style={{ flex: 1, gap: 6, minWidth: 0 }}>
          {state ? (
            <View style={styles.state}>
              <View style={[styles.dot, { backgroundColor: state.tone === "warning" ? color.warning : state.tone === "accent" ? ac.accent : color.ink3 }]} />
              <T v="footnote" style={{ fontWeight: "600", color: state.tone === "warning" ? color.warning : state.tone === "accent" ? ac.accent : color.ink2 }}>
                {state.text}
              </T>
            </View>
          ) : null}
          <T v="headline" accessibilityRole="header" numberOfLines={3}>
            {title}
          </T>
          <ChannelName channel={post.channel} />
          <View style={styles.when}>
            <CalendarDays size={15} color={color.ink3} style={{ marginTop: 2 }} />
            <T v="footnote" style={{ flex: 1 }} accessibilityHint={post.timeReason ? `Why this time: ${post.timeReason}` : undefined}>
              {postTimeLine(post, tz)}
            </T>
          </View>
        </View>
      </View>

      {caption ? (
        <Pressable onPress={() => setMore((m) => !m)} accessibilityRole="button" accessibilityLabel={more ? "Show less of the caption" : "Show the whole caption"}>
          <T v="bodySm" style={{ color: color.ink2 }} numberOfLines={more ? undefined : 2}>
            {more ? caption : caption.replace(/\s+/g, " ")}
          </T>
          {caption.length > 90 || caption.includes("\n") ? (
            <T v="footnote" style={{ color: ac.accent, fontWeight: "600", marginTop: 2 }}>
              {more ? "less" : "more"}
            </T>
          ) : null}
        </Pressable>
      ) : null}

      {running && post.change ? <ChangeProgress change={post.change} /> : post.change && recent(post.change.finishedAt) ? <ChangeResult change={post.change} waiting={Boolean(post.decision)} /> : null}

      {running ? null : post.decision ? (
        canSchedule(post) ? (
          <View style={{ gap: 10 }}>
            <Button title="Schedule post" onPress={() => void decide("approve")} loading={busy === "approve"} disabled={Boolean(busy)} />
            <View style={{ flexDirection: "row", gap: 10 }}>
              {post.canChange ? <Button title="Edit" variant="outline" onPress={() => setEditing(true)} style={{ flex: 1 }} disabled={Boolean(busy)} /> : null}
              {post.decision.reject ? <Button title="Skip" variant="ghost" onPress={() => void decide("reject")} loading={busy === "reject"} disabled={Boolean(busy)} style={{ flex: 1 }} /> : null}
            </View>
          </View>
        ) : (
          <View style={{ gap: 10 }}>
            <T v="footnote">{post.decision.stale ? "This post changed after it was sent for approval. Open it on the web to see the latest version." : `Waiting for ${whoCanDecide(post.decision.requiredCap)} to schedule it.`}</T>
            {post.canChange ? <Button title="Edit" variant="outline" onPress={() => setEditing(true)} /> : null}
          </View>
        )
      ) : post.status === "manual_post_needed" && mode ? (
        <View style={{ gap: 10 }}>
          <T v="footnote">{`Scheduled. Post it on ${channel} yourself${when ? ` ${when}` : ""}, then tell MuseLaunch the link so Results can count what it brings in.`}</T>
          <Button title={shareLabel(post.channel)} icon={ShareIcon} onPress={() => setShare("share")} />
          <View style={{ flexDirection: "row", gap: 10 }}>
            <Button title="I posted it" variant="outline" onPress={() => setShare("ask")} style={{ flex: 1 }} />
            {post.canChange ? <Button title="Edit" variant="ghost" onPress={() => setEditing(true)} style={{ flex: 1 }} /> : null}
          </View>
        </View>
      ) : (
        <T v="footnote">{post.blocked ?? "This post isn’t ready to schedule yet. Open it in MuseLaunch on the web."}</T>
      )}

      {manual && post.status !== "manual_post_needed" && !running ? (
        <Notice icon={Info}>
          <T v="footnote">
            <T v="footnote" style={{ fontWeight: "600", color: color.ink }}>{`${channel} isn’t connected, so you post this one yourself. `}</T>
            {`After you schedule it, ${shareLabel(post.channel).replace("…", "")} saves the video, copies the caption and opens the share sheet.`}
          </T>
        </Notice>
      ) : null}

      <EditSheet post={post} open={editing} onClose={() => setEditing(false)} />
      {mode ? <ShareSheet target={{ id: post.id, channel: post.channel, title, mode }} open={share !== null} askFirst={share === "ask"} onClose={() => setShare(null)} /> : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  top: { flexDirection: "row", gap: 14, alignItems: "flex-start" },
  state: { flexDirection: "row", alignItems: "center", gap: 6 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  when: { flexDirection: "row", gap: 6, alignItems: "flex-start", marginTop: 2 },
});
