/**
 * Hold to talk: press and hold the mic, say what you want, let go. The clip goes to Muse Voice
 * Transcribe (lib/voice.ts) and the words land in the box; nothing else happens until the person
 * taps the button next to the box (which shows the real cost first).
 */
import { AudioModule, RecordingPresets, setAudioModeAsync, useAudioRecorder, useAudioRecorderState } from "expo-audio";
import * as Haptics from "expo-haptics";
import { Mic } from "lucide-react-native";
import { useEffect, useRef, useState } from "react";
import { Platform, Pressable, StyleSheet, View } from "react-native";
import { errorMessage } from "../../api/client";
import { clock } from "../../lib/home-lines";
import { transcribeRecording, type VoiceStage } from "../../lib/voice";
import { useSession } from "../../session";
import { Spinner, T } from "../../ui/components";
import { color } from "../../ui/theme";
import { useAccent } from "../../ui/accent";

const MAX_MS = 60_000;
const MIN_MS = 600;

type State = { phase: "idle" } | { phase: "recording" } | { phase: "listening"; stage: VoiceStage } | { phase: "error"; message: string };

export function HoldToTalk({ onText, disabled, onBusyChange }: { onText: (text: string) => void; disabled?: boolean; onBusyChange?: (busy: boolean) => void }) {
  const ac = useAccent();
  const { api, appId } = useSession();
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const rs = useAudioRecorderState(recorder, 200);
  const [state, setState] = useState<State>({ phase: "idle" });
  const holding = useRef(false);
  const started = useRef(false);

  useEffect(() => onBusyChange?.(state.phase === "recording" || state.phase === "listening"), [state.phase, onBusyChange]);

  const finish = async () => {
    if (!started.current) return;
    started.current = false;
    const ms = rs.durationMillis;
    try {
      await recorder.stop();
    } catch {
      // already stopped
    }
    void setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(() => {});
    const uri = recorder.uri;
    if (!uri || ms < MIN_MS) {
      setState({ phase: "error", message: "Hold the mic while you speak, then let go." });
      return;
    }
    setState({ phase: "listening", stage: "uploading" });
    try {
      const text = await transcribeRecording(api, uri, { appId, onStage: (stage) => setState({ phase: "listening", stage }) });
      onText(text);
      setState({ phase: "idle" });
    } catch (e) {
      setState({ phase: "error", message: errorMessage(e) });
    }
  };

  // A minute is plenty for an instruction: stop there.
  useEffect(() => {
    if (state.phase === "recording" && rs.durationMillis >= MAX_MS) void finish();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reacts to the recorder's clock only
  }, [rs.durationMillis, state.phase]);

  const start = async () => {
    holding.current = true;
    try {
      const perm = await AudioModule.getRecordingPermissionsAsync();
      if (!perm.granted) {
        const asked = await AudioModule.requestRecordingPermissionsAsync();
        holding.current = false;
        setState(asked.granted ? { phase: "error", message: "Microphone on. Now hold the mic and speak." } : { phase: "error", message: "MuseLaunch needs the microphone for this. Turn it on in your phone’s settings, or type instead." });
        return;
      }
      await setAudioModeAsync({ playsInSilentMode: true, allowsRecording: true });
      await recorder.prepareToRecordAsync();
      if (!holding.current) return; // let go before it was ready
      recorder.record();
      started.current = true;
      setState({ phase: "recording" });
      if (Platform.OS !== "web") void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    } catch (e) {
      holding.current = false;
      setState({ phase: "error", message: errorMessage(e) || "The microphone couldn’t start. Type instead." });
    }
  };

  const stop = () => {
    holding.current = false;
    void finish();
  };

  const recording = state.phase === "recording";
  const listening = state.phase === "listening";
  return (
    <View style={styles.row}>
      <Pressable
        onPressIn={() => void start()}
        onPressOut={stop}
        disabled={disabled || listening}
        accessibilityRole="button"
        accessibilityLabel="Hold to talk"
        accessibilityHint="Hold while you say what you want, then let go. Your words appear in the box."
        style={({ pressed }) => [styles.mic, { backgroundColor: ac.accentSoft, borderColor: ac.accentSoft }, (pressed || recording) && styles.micOn, (disabled || listening) && { opacity: 0.4 }]}
      >
        <Mic size={22} color={recording ? color.white : ac.accent} strokeWidth={2} />
      </Pressable>
      <View style={{ flex: 1, gap: 2 }} accessibilityLiveRegion="polite">
        {recording ? (
          <T v="footnote" style={{ color: color.danger, fontWeight: "600" }}>
            ● Listening · {clock(rs.durationMillis / 1000)} · let go when you’re done
          </T>
        ) : listening ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Spinner />
            <T v="footnote">{state.stage === "transcribing" ? "Muse Voice Transcribe is writing it down…" : "Sending your voice…"}</T>
          </View>
        ) : state.phase === "error" ? (
          <T v="footnote" style={{ color: color.warning }}>
            {state.message}
          </T>
        ) : (
          <T v="footnote">Hold to talk. Your words appear in the box; nothing happens until you tap the button.</T>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 12 },
  mic: { width: 52, height: 52, borderRadius: 26, alignItems: "center", justifyContent: "center", borderWidth: 1 },
  micOn: { backgroundColor: color.danger, borderColor: color.danger, transform: [{ scale: 1.08 }] },
});
