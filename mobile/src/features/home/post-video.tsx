/**
 * A post's video: the poster frame as a calm thumbnail (play button, length), and the video itself
 * full screen when tapped (expo-video, native controls).
 */
import { useVideoPlayer, VideoView } from "expo-video";
import { Play, X } from "lucide-react-native";
import { useState } from "react";
import { ActivityIndicator, Image, Modal, Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAssetUrl } from "../../api/hooks";
import type { TodayPost } from "../../api/types";
import { clock, postTitle } from "../../lib/home-lines";
import { T } from "../../ui/components";
import { color } from "../../ui/theme";

export function PostThumb({ post, style }: { post: Pick<TodayPost, "video" | "title" | "compositionTitle" | "caption">; style?: StyleProp<ViewStyle> }) {
  const v = post.video;
  const poster = useAssetUrl(v?.posterAssetId ?? (v?.kind === "image" ? v.assetId : null));
  const [open, setOpen] = useState(false);
  const label = `${post.compositionTitle ?? postTitle(post)}${v?.durationSec ? `, ${Math.round(v.durationSec)} seconds` : ""}`;
  return (
    <>
      <Pressable
        disabled={v?.kind !== "video"}
        onPress={() => setOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={v?.kind === "video" ? `Play ${label}` : label}
        style={({ pressed }) => [styles.thumb, pressed && { opacity: 0.85 }, style]}
      >
        {poster.data?.url ? <Image source={{ uri: poster.data.url }} style={StyleSheet.absoluteFill} resizeMode="cover" accessibilityIgnoresInvertColors /> : null}
        {!v ? (
          <View style={styles.center}>
            <T v="caption" style={{ color: "rgba(255,255,255,0.7)", textAlign: "center", paddingHorizontal: 8 }}>
              No video on this post
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
      </Pressable>
      {v?.kind === "video" ? <VideoModal assetId={v.assetId} open={open} onClose={() => setOpen(false)} title={label} /> : null}
    </>
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
  close: { width: 44, height: 44, borderRadius: 22, backgroundColor: "rgba(0,0,0,0.5)", alignItems: "center", justifyContent: "center", margin: 8 },
});
