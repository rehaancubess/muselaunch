/**
 * Post it yourself, from the phone: the video is saved to the app's cache, the caption (with its
 * tracked link) goes on the clipboard, and the system share sheet opens so the person picks
 * Instagram, TikTok… Then "Did you post it?": the post's link marks it as posted (the same
 * POST /posts/:id/mark-posted as the web), so Results can count what it brings in.
 *
 * Only approved posts get here. A post that goes out through a connected account can be shared too
 * (somewhere else), but MuseLaunch still posts it itself at its time, so it isn't marked here.
 */
import { useQuery } from "@tanstack/react-query";
import * as Clipboard from "expo-clipboard";
import { File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { Check, CircleCheck, Copy, Download, Share as ShareIcon } from "lucide-react-native";
import { useEffect, useState } from "react";
import { Linking, Platform, StyleSheet, View } from "react-native";
import { errorMessage } from "../../api/client";
import { useRefresh } from "../../api/hooks";
import type { Channel } from "../../api/types";
import { channelLabel } from "../../lib/home-lines";
import { copiedLine, postLinkProblem, shareLabel, videoFileName, type ShareMode } from "../../lib/share";
import { useSession } from "../../session";
import { Button, Field, LinkText, Notice, ProgressBar, Sheet, T } from "../../ui/components";
import { color } from "../../ui/theme";
import { useToast } from "../../ui/toast";
import { useAccent } from "../../ui/accent";

type ManualPackage = {
  copy: { title?: string; caption: string; tags: string[]; trackingUrl?: string };
  downloads: { assetId: string; kind: string; mimeType: string; filename: string; url: string }[];
};

type Step = "idle" | "downloading" | "copied" | "shared" | "error";

export interface ShareTarget {
  id: string;
  channel: Channel;
  title: string;
  mode: Exclude<ShareMode, null>;
}

export function shareText(copy: ManualPackage["copy"]): string {
  const caption = copy.caption?.trim() ?? "";
  const link = copy.trackingUrl && !caption.includes(copy.trackingUrl) ? copy.trackingUrl : undefined;
  return [copy.title?.trim(), caption, link].filter(Boolean).join("\n\n");
}

export function ShareSheet({ target, open, onClose, askFirst }: { target: ShareTarget; open: boolean; onClose: () => void; askFirst?: boolean }) {
  const { api, workspaceId } = useSession();
  const toast = useToast();
  const refresh = useRefresh();
  const [step, setStep] = useState<Step>("idle");
  const [pct, setPct] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState(Boolean(askFirst));
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const channel = channelLabel(target.channel);
  const pkg = useQuery({ queryKey: ["manual", workspaceId, target.id], queryFn: () => api.get<ManualPackage>(api.ws(`/posts/${target.id}/manual`)), enabled: open, staleTime: 30 * 60_000 });

  useEffect(() => {
    if (open) {
      setStep("idle");
      setAsking(Boolean(askFirst));
      setError(null);
      setPct(null);
    }
  }, [open, askFirst]);

  const video = pkg.data?.downloads.find((d) => d.kind === "video") ?? pkg.data?.downloads[0];
  const absolute = (u: string) => (u.startsWith("http") ? u : `${api.base}${u}`);

  const share = async () => {
    if (!pkg.data || !video) return;
    setError(null);
    try {
      // 1. The video, into this app's cache (the share sheet needs a file).
      setStep("downloading");
      setPct(0);
      let fileUri: string | null = null;
      if (Platform.OS !== "web") {
        const ext = video.mimeType.includes("quicktime") ? "mov" : video.mimeType.split("/")[1] ?? "mp4";
        const dest = new File(Paths.cache, videoFileName(target.title, target.id, ext));
        const file = await File.downloadFileAsync(absolute(video.url), dest, {
          idempotent: true,
          onProgress: ({ bytesWritten, totalBytes }) => setPct(totalBytes > 0 ? Math.round((bytesWritten / totalBytes) * 100) : null),
        });
        fileUri = file.uri;
      }
      setPct(100);
      // 2. The caption (with its tracked link) on the clipboard.
      await Clipboard.setStringAsync(shareText(pkg.data.copy));
      setStep("copied");
      // 3. The system share sheet: Instagram, TikTok, Save video…
      if (fileUri && (await Sharing.isAvailableAsync())) {
        await Sharing.shareAsync(fileUri, { mimeType: video.mimeType, UTI: video.mimeType.includes("quicktime") ? "com.apple.quicktime-movie" : "public.mpeg-4", dialogTitle: `Share to ${channel}` });
      } else {
        // A browser preview has no share sheet: open the video to save it.
        await Linking.openURL(absolute(video.url));
      }
      setStep("shared");
      if (target.mode === "manual") setAsking(true);
    } catch (e) {
      setStep("error");
      setError(errorMessage(e));
    }
  };

  const markPosted = async () => {
    const problem = postLinkProblem(target.channel, url);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.post(api.ws(`/posts/${target.id}/mark-posted`), { url: url.trim() });
      toast({ title: "Marked as posted", body: "Results will count what it brings in." });
      onClose();
      await refresh("today", "calendar", "results", "overview");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const copied = step === "copied" || step === "shared";
  const downloaded = copied || (step === "downloading" && pct === 100);
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={asking ? "Did you post it?" : shareLabel(target.channel).replace("…", "")}
      footer={
        asking ? (
          <View style={{ gap: 8 }}>
            <Button title="Mark as posted" onPress={() => void markPosted()} loading={busy} disabled={!url.trim()} />
            <Button title="Not yet" variant="ghost" onPress={onClose} />
          </View>
        ) : (
          <View style={{ gap: 8 }}>
            <Button title={step === "shared" ? "Share again" : shareLabel(target.channel)} icon={ShareIcon} onPress={() => void share()} loading={step === "downloading" || pkg.isLoading} disabled={!video} />
            {target.mode === "manual" ? <Button title="I already posted it" variant="ghost" onPress={() => setAsking(true)} /> : null}
          </View>
        )
      }
    >
      {asking ? (
        <View style={{ gap: 12 }}>
          <T v="body" style={{ color: color.ink2 }}>
            Paste the link of your {channel} post. MuseLaunch counts its views and clicks in Results. Nothing is posted from here.
          </T>
          <Field
            value={url}
            onChangeText={(t) => {
              setUrl(t);
              if (error) setError(null);
            }}
            placeholder={target.channel === "instagram" ? "https://www.instagram.com/reel/…" : target.channel === "tiktok" ? "https://www.tiktok.com/@you/video/…" : "https://"}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            invalid={Boolean(error)}
            accessibilityLabel={`Link to the ${channel} post`}
          />
          <LinkText
            title="Paste from clipboard"
            onPress={() =>
              void Clipboard.getStringAsync().then((t) => {
                if (t) setUrl(t.trim());
              })
            }
          />
          {error ? <T v="footnote" style={{ color: color.danger }}>{error}</T> : null}
        </View>
      ) : (
        <View style={{ gap: 14 }}>
          <T v="body" style={{ color: color.ink2 }}>
            {target.mode === "manual" ? `${channel} isn’t connected, so you post this one yourself. Three steps, one tap:` : `This post goes out on ${channel} through your connected account at its time. You can still share the video somewhere else:`}
          </T>
          <StepRow n={1} icon={Download} done={downloaded} title="Save the video to your phone" detail={step === "downloading" ? <ProgressBar value={pct} style={{ marginTop: 6 }} /> : null} />
          <StepRow n={2} icon={Copy} done={copied} title={copied ? copiedLine(target.channel) : "Copy the caption, with its tracked link"} />
          <StepRow n={3} icon={ShareIcon} done={step === "shared"} title={`Pick ${channel} in the share sheet and paste the caption`} />
          {pkg.error ? <Notice tone="warning">{`Couldn’t get the video: ${errorMessage(pkg.error)}`}</Notice> : null}
          {pkg.data && !video ? <Notice tone="warning">This post has no video to share.</Notice> : null}
          {error ? <Notice tone="warning">{error}</Notice> : null}
          {pkg.data?.copy.caption ? (
            <View style={styles.caption}>
              <T v="caption" style={{ fontWeight: "600", color: color.ink2 }}>
                Caption
              </T>
              <T v="footnote" numberOfLines={4} style={{ color: color.ink }}>
                {shareText(pkg.data.copy)}
              </T>
            </View>
          ) : null}
        </View>
      )}
    </Sheet>
  );
}

function StepRow({ n, title, done, icon: Icon, detail }: { n: number; title: string; done: boolean; icon: typeof Check; detail?: React.ReactNode }) {
  const ac = useAccent();
  return (
    <View style={styles.step}>
      <View style={[styles.badge, { backgroundColor: ac.accentSoft }, done && { backgroundColor: color.successSoft }]}>
        {done ? <CircleCheck size={18} color={color.success} /> : <Icon size={16} color={ac.accent} />}
      </View>
      <View style={{ flex: 1, paddingTop: 5 }}>
        <T v="bodySm" style={{ fontWeight: done ? "600" : "400" }}>
          {`${n}. ${title}`}
        </T>
        {detail}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  step: { flexDirection: "row", gap: 12, alignItems: "flex-start" },
  badge: { width: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center" },
  caption: { gap: 4, borderRadius: 14, backgroundColor: color.mist, padding: 12 },
});
