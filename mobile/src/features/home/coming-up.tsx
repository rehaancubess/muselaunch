/**
 * Home's "Coming up": the other posts on Home (waiting for your OK, ready for you to post, being
 * changed) and what's already scheduled to go out through a connected account (GET /calendar).
 * A Home post opens as the big card above; a scheduled one opens its share sheet (it still goes out
 * by itself; sharing it somewhere else is up to the person).
 */
import { CalendarDays, ChevronRight, ImageIcon } from "lucide-react-native";
import { useState } from "react";
import { Image, Pressable, StyleSheet, View } from "react-native";
import { useAssetUrl, useCalendar } from "../../api/hooks";
import type { CalendarItem, Channel, TodayPost } from "../../api/types";
import { channelLabel, postTitle, rowState, shortWhen } from "../../lib/home-lines";
import { useTimezone } from "../../session";
import { ChannelMark } from "../../ui/channel";
import { Card, Divider, SectionTitle, T } from "../../ui/components";
import { color } from "../../ui/theme";
import { ShareSheet, type ShareTarget } from "./share-sheet";
import { useAccent } from "../../ui/accent";

const MAX_ROWS = 6;

type Row = { id: string; title: string; channel: Channel; at?: string; state: string; scheduled: boolean; imageId?: string; videoId?: string };

function Thumb({ imageId, videoId }: { imageId?: string; videoId?: string }) {
  const ac = useAccent();
  const url = useAssetUrl(imageId ?? null);
  return (
    <View style={[styles.thumb, { backgroundColor: ac.accentSoft }]}>
      {url.data?.url ? <Image source={{ uri: url.data.url }} style={StyleSheet.absoluteFill} resizeMode="cover" /> : <ImageIcon size={16} color={videoId ? ac.accent : color.ink3} />}
    </View>
  );
}

export function ComingUp({ posts, onOpen, hasNext, onCreate }: { posts: TodayPost[]; onOpen: (postId: string) => void; hasNext: boolean; onCreate?: () => void }) {
  const ac = useAccent();
  const tz = useTimezone();
  const cal = useCalendar(tz);
  const [sharing, setSharing] = useState<ShareTarget | null>(null);
  const onHome = new Set(posts.map((p) => p.id));
  const scheduled: CalendarItem[] = Object.values(cal.data?.days ?? {})
    .flat()
    .filter((i) => (i.status === "scheduled" || i.status === "publishing") && !onHome.has(i.id) && (!i.scheduledAt || Date.parse(i.scheduledAt) >= Date.now() - 3_600_000));
  const rows: Row[] = [
    ...posts.map((p) => ({ id: p.id, title: postTitle(p), channel: p.channel, at: p.scheduledAt, state: rowState(p), scheduled: false, imageId: p.video?.posterAssetId ?? (p.video?.kind === "image" ? p.video.assetId : undefined), videoId: p.video?.assetId })),
    ...scheduled.map((i) => ({ id: i.id, title: i.title?.trim() || `${channelLabel(i.channel)} post`, channel: i.channel, at: i.scheduledAt ?? i.at, state: i.status === "publishing" ? "Posting now" : "Scheduled", scheduled: true, imageId: i.thumbnailAssetId })),
  ].sort((a, b) => (a.at ?? "~").localeCompare(b.at ?? "~"));
  const shown = rows.slice(0, MAX_ROWS);

  return (
    <View style={{ gap: 12 }}>
      <SectionTitle
        title="Coming up"
        action={
          onCreate ? (
            <Pressable onPress={onCreate} accessibilityRole="link" hitSlop={8}>
              <T v="bodySm" style={{ color: ac.accent, fontWeight: "600" }}>
                Create something new
              </T>
            </Pressable>
          ) : undefined
        }
      />
      {shown.length ? (
        <Card padded={false} style={{ overflow: "hidden" }}>
          {shown.map((row, i) => (
            <View key={row.id}>
              {i ? <Divider style={{ marginLeft: 100 }} /> : null}
              <Pressable
                onPress={() => (row.scheduled ? setSharing({ id: row.id, channel: row.channel, title: row.title, mode: "scheduled" }) : onOpen(row.id))}
                accessibilityRole="button"
                accessibilityLabel={`${row.title}, ${channelLabel(row.channel)}, ${row.state}${row.at ? `, ${shortWhen(row.at, tz)}` : ""}`}
                style={({ pressed }) => [styles.row, pressed && { backgroundColor: color.mist }]}
              >
                <Thumb imageId={row.imageId} videoId={row.videoId} />
                <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                  <T v="bodySm" style={{ fontWeight: "600" }} numberOfLines={1}>
                    {row.title}
                  </T>
                  <View style={styles.meta}>
                    <ChannelMark channel={row.channel} size={13} />
                    <T v="caption" style={{ color: color.ink2 }} numberOfLines={1}>
                      {`${channelLabel(row.channel)} · `}
                      <T v="caption" style={{ color: row.scheduled ? color.success : color.ink2, fontWeight: row.scheduled ? "600" : "400" }}>
                        {row.state}
                      </T>
                    </T>
                  </View>
                  <View style={styles.meta}>
                    <CalendarDays size={13} color={color.ink3} />
                    <T v="caption" style={{ color: color.ink2 }}>
                      {row.at ? shortWhen(row.at, tz) : "No time set"}
                    </T>
                  </View>
                </View>
                <ChevronRight size={18} color={color.ink3} />
              </Pressable>
            </View>
          ))}
        </Card>
      ) : (
        <View style={styles.empty}>
          <T v="bodySm" style={{ color: color.ink2 }}>{`${hasNext ? "Nothing else is lined up yet." : "Nothing is lined up yet."} Scheduled posts show up here.`}</T>
        </View>
      )}
      {rows.length > MAX_ROWS ? <T v="footnote">{`${rows.length - MAX_ROWS} more in Scheduled on the web.`}</T> : null}
      {sharing ? <ShareSheet target={sharing} open onClose={() => setSharing(null)} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 14, paddingHorizontal: 14, paddingVertical: 12, minHeight: 76 },
  thumb: { width: 72, height: 52, borderRadius: 10, overflow: "hidden", alignItems: "center", justifyContent: "center" },
  meta: { flexDirection: "row", alignItems: "center", gap: 6 },
  empty: { borderRadius: 20, backgroundColor: color.mist, padding: 16 },
});
