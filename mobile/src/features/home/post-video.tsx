/**
 * A post's video: the poster frame as a calm thumbnail (play button, length), and the video itself
 * full screen when tapped (expo-video, native controls).
 */
import { useVideoPlayer, VideoView } from "expo-video";
import { GalleryHorizontal, Play, X } from "lucide-react-native";
import { useState } from "react";
import { ActivityIndicator, Image, Modal, Pressable, ScrollView, StyleSheet, useWindowDimensions, View, type StyleProp, type ViewStyle } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAssetUrl } from "../../api/hooks";
import type { TodayPost } from "../../api/types";
import { clock, postTitle } from "../../lib/home-lines";
import { T } from "../../ui/components";
import { color } from "../../ui/theme";

export function PostThumb({ post, style }: { post: Pick<TodayPost, "video" | "title" | "compositionTitle" | "caption" | "images">; style?: StyleProp<ViewStyle> }) {
  const v = post.video;
  const slides = post.images && post.images.length > 1 ? post.images.map((i) => i.assetId) : null;
  const poster = useAssetUrl(v?.posterAssetId ?? (v?.kind === "image" ? v.assetId : null));
  const [open, setOpen] = useState(false);
  const label = `${post.compositionTitle ?? postTitle(post)}${v?.durationSec ? `, ${Math.round(v.durationSec)} seconds` : ""}${slides ? `, ${slides.length} slides` : ""}`;
  return (
    <>
      <Pressable
        disabled={v?.kind !== "video" && !slides}
        onPress={() => setOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={v?.kind === "video" ? `Play ${label}` : slides ? `See the slides of ${label}` : label}
        style={({ pressed }) => [styles.thumb, !v && styles.textThumb, pressed && { opacity: 0.85 }, style]}
      >
        {poster.data?.url ? <Image source={{ uri: poster.data.url }} style={StyleSheet.absoluteFill} resizeMode="cover" accessibilityIgnoresInvertColors /> : null}
        {!v ? (
          // A text-only post: the post is its words.
          <View style={styles.textCard}>
            <T v="caption" style={{ color: color.ink3, fontWeight: "700", letterSpacing: 0.3 }}>
              TEXT POST
            </T>
            <T v="bodySm" numberOfLines={8} style={{ color: color.ink }}>
              {post.caption}
            </T>
          </View>
        ) : !poster.data?.url && v.kind === "image" ? (
          <View style={styles.center}>
            <ActivityIndicator color="rgba(255,255,255,0.7)" />
          </View>
        ) : null}
        {v?.kind === "video" ? (
          <>
            <View style={styles.play}>
              <Play size={16} color={color.white} fill={color.white} style={{ marginLeft: 2 }} />
            </View>
            {v.durationSec ? (
              <View style={styles.time}>
                <T v="caption" style={{ color: color.white, fontWeight: "600" }}>
                  {clock(v.durationSec)}
                </T>
              </View>
            ) : null}
          </>
        ) : null}
        {slides ? (
          <View style={styles.time}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
              <GalleryHorizontal size={12} color={color.white} />
              <T v="caption" style={{ color: color.white, fontWeight: "600" }}>
                {`1/${slides.length}`}
              </T>
            </View>
          </View>
        ) : null}
      </Pressable>
      {v?.kind === "video" ? <VideoModal assetId={v.assetId} open={open} onClose={() => setOpen(false)} title={label} /> : null}
      {slides ? <SlidesModal assetIds={slides} open={open} onClose={() => setOpen(false)} title={label} /> : null}
    </>
  );
}

/** A carousel's slides (or a store screenshot set), full screen, one per page, swiped in order. */
export function SlidesModal({ assetIds, open, onClose, title }: { assetIds: string[]; open: boolean; onClose: () => void; title: string }) {
  const { width } = useWindowDimensions();
  const [at, setAt] = useState(0);
  return (
    <Modal visible={open} animationType="fade" onRequestClose={onClose} presentationStyle="fullScreen">
      <View style={{ flex: 1, backgroundColor: color.black }}>
        <ScrollView horizontal pagingEnabled showsHorizontalScrollIndicator={false} onMomentumScrollEnd={(e) => setAt(Math.round(e.nativeEvent.contentOffset.x / Math.max(1, width)))} accessibilityLabel={title}>
          {assetIds.map((id, i) => (
            <Slide key={id} assetId={id} width={width} label={`Slide ${i + 1} of ${assetIds.length}`} load={open && Math.abs(i - at) <= 1} />
          ))}
        </ScrollView>
        <SafeAreaView style={styles.counterWrap} pointerEvents="none">
          <View style={styles.counter}>
            <T v="caption" style={{ color: color.white, fontWeight: "600" }}>{`${at + 1} / ${assetIds.length}`}</T>
          </View>
        </SafeAreaView>
        <SafeAreaView style={styles.closeWrap} pointerEvents="box-none">
          <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close the slides" style={styles.close}>
            <X size={22} color={color.white} />
          </Pressable>
        </SafeAreaView>
      </View>
    </Modal>
  );
}

function Slide({ assetId, width, label, load }: { assetId: string; width: number; label: string; load: boolean }) {
  const src = useAssetUrl(load ? assetId : null);
  return (
    <View style={{ width, flex: 1, justifyContent: "center" }}>
      {src.data?.url ? <Image source={{ uri: src.data.url }} style={{ width, height: "100%" }} resizeMode="contain" accessibilityLabel={label} /> : <ActivityIndicator color={color.white} />}
    </View>
  );
}

export function VideoModal({ assetId, open, onClose, title }: { assetId: string; open: boolean; onClose: () => void; title: string }) {
  const src = useAssetUrl(open ? assetId : null);
  return (
    <Modal visible={open} animationType="fade" onRequestClose={onClose} presentationStyle="fullScreen">
      <View style={{ flex: 1, backgroundColor: color.black }}>
        {open && src.data?.url ? <Player url={src.data.url} title={title} /> : <ActivityIndicator style={{ flex: 1 }} color={color.white} />}
        <SafeAreaView style={styles.closeWrap} pointerEvents="box-none">
          <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close the video" style={styles.close}>
            <X size={22} color={color.white} />
          </Pressable>
        </SafeAreaView>
      </View>
    </Modal>
  );
}

function Player({ url, title }: { url: string; title: string }) {
  const player = useVideoPlayer(url, (p) => {
    p.loop = false;
    p.play();
  });
  return <VideoView player={player} style={{ flex: 1 }} contentFit="contain" nativeControls accessibilityLabel={title} />;
}

const styles = StyleSheet.create({
  thumb: { aspectRatio: 4 / 5, borderRadius: 18, overflow: "hidden", backgroundColor: "#16131f" },
  center: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, alignItems: "center", justifyContent: "center" },
  play: { position: "absolute", left: 10, bottom: 10, width: 36, height: 36, borderRadius: 18, backgroundColor: "rgba(0,0,0,0.45)", borderWidth: 1, borderColor: "rgba(255,255,255,0.3)", alignItems: "center", justifyContent: "center" },
  time: { position: "absolute", right: 10, bottom: 14, borderRadius: 999, backgroundColor: "rgba(0,0,0,0.55)", paddingHorizontal: 7, paddingVertical: 1 },
  closeWrap: { position: "absolute", top: 0, right: 0, padding: 12 },
  counterWrap: { position: "absolute", top: 0, left: 0, padding: 12 },
  counter: { margin: 8, borderRadius: 999, backgroundColor: "rgba(0,0,0,0.55)", paddingHorizontal: 10, paddingVertical: 4 },
  textThumb: { backgroundColor: color.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: color.line },
  textCard: { flex: 1, padding: 14, gap: 8 },
  close: { width: 44, height: 44, borderRadius: 22, backgroundColor: "rgba(0,0,0,0.5)", alignItems: "center", justifyContent: "center", margin: 8 },
});
