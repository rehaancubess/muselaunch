/**
 * "Link MuseLaunch": the phone has no password. On the web (Settings → Phone app → Link your phone)
 * MuseLaunch shows a QR code and an 8-character code that works once, for 10 minutes. The phone scans
 * the QR (or the person types the code) and gets its own token, kept in secure storage.
 */
import * as Application from "expo-application";
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from "expo-camera";
import * as Device from "expo-device";
import * as Haptics from "expo-haptics";
import { Redirect, router, useLocalSearchParams } from "expo-router";
import { ScanLine, ShieldCheck, X } from "lucide-react-native";
import { useEffect, useRef, useState } from "react";
import { Alert, Modal, Platform, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { createApi, errorMessage } from "../api/client";
import type { RedeemResponse } from "../api/types";
import { formatAsTyped, hostOf, isHttpUrl, normalizeCode, parseScanned } from "../lib/link-code";
import { useSession } from "../session";
import { Button, Field, Logo, Notice, T } from "../ui/components";
import { color, space } from "../ui/theme";
import { useAccent } from "../ui/accent";

function deviceName(): string {
  const name = Device.deviceName?.trim() || Device.modelName?.trim();
  if (name) return name.slice(0, 80);
  return Platform.OS === "ios" ? "iPhone" : Platform.OS === "android" ? "Android phone" : "Web preview";
}

export default function LinkScreen() {
  const ac = useAccent();
  const s = useSession();
  const params = useLocalSearchParams<{ code?: string; api?: string }>();
  const [code, setCode] = useState(() => formatAsTyped(typeof params.code === "string" ? params.code : ""));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [devTaps, setDevTaps] = useState(0);
  const [server, setServer] = useState("");
  const [serverFor, setServerFor] = useState<string | null>(null);
  const fromLink = typeof params.code === "string" && params.code.length > 0;

  const confirmServer = (api: string) => {
    const host = hostOf(api);
    if (Platform.OS === "web") {
      setServerFor(api.replace(/\/+$/, ""));
      return;
    }
    Alert.alert("A different MuseLaunch server", `This code is for ${host}, not the usual MuseLaunch. Only use it if you’re testing your own server.`, [
      { text: "Keep the usual", style: "cancel" },
      { text: `Use ${host}`, onPress: () => setServerFor(api.replace(/\/+$/, "")) },
    ]);
  };

  // Opened from the QR with the phone's own camera (muselaunch://link?code=…&api=…).
  useEffect(() => {
    if (typeof params.code === "string" && params.code) setCode(formatAsTyped(params.code));
    if (typeof params.api === "string" && isHttpUrl(params.api) && params.api.replace(/\/+$/, "") !== s.apiBase) confirmServer(params.api);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only for the link it was opened with
  }, [params.code, params.api]);

  if (!s.loaded) return null;
  if (s.linked && !fromLink) return <Redirect href="/" />;

  const redeem = async (raw: string, apiOverride?: string | null) => {
    const plain = normalizeCode(raw);
    if (!plain) {
      setError("Type the 8 characters shown on your computer, like ABCD-EFGH.");
      return;
    }
    setBusy(true);
    setError(null);
    const base = apiOverride ?? serverFor ?? s.apiBase;
    try {
      const api = createApi({ base, token: null });
      const r = await api.post<RedeemResponse>("/v1/device-links/redeem", {
        code: plain,
        deviceName: deviceName(),
        platform: Platform.OS === "ios" ? "ios" : Platform.OS === "android" ? "android" : "web",
        ...(Application.nativeApplicationVersion ? { appVersion: Application.nativeApplicationVersion } : {}),
      });
      if (Platform.OS !== "web") void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      await s.signIn(r.token, { id: r.device.id, name: r.device.name }, { apiBase: base });
      router.replace("/");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const onScanned = (text: string) => {
    const scanned = parseScanned(text);
    if (!scanned) return false;
    setScanning(false);
    setCode(formatAsTyped(scanned.code));
    if (scanned.api && scanned.api !== s.apiBase) {
      if (Platform.OS === "web") return true;
      Alert.alert("A different MuseLaunch server", `This code is for ${hostOf(scanned.api)}, not the usual MuseLaunch. Only use it if you’re testing your own server.`, [
        { text: "Keep the usual", style: "cancel", onPress: () => void redeem(scanned.code, s.apiBase) },
        {
          text: `Use ${hostOf(scanned.api)}`,
          onPress: () => {
            setServerFor(scanned.api);
            void redeem(scanned.code, scanned.api);
          },
        },
      ]);
      return true;
    }
    void redeem(scanned.code);
    return true;
  };

  const complete = Boolean(normalizeCode(code));
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: color.canvas }}>
      <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
        <Pressable onPress={() => setDevTaps((n) => n + 1)} accessibilityLabel="MuseLaunch" style={styles.brand}>
          <Logo size={64} />
          <T v="title3" style={{ marginTop: 14 }}>
            MuseLaunch
          </T>
          <T v="footnote">Create. Review. Grow.</T>
        </Pressable>

        <View style={{ gap: 8 }}>
          <T v="title1" accessibilityRole="header">
            Link MuseLaunch
          </T>
          <T v="body" style={{ color: color.ink2 }}>
            On your computer, open MuseLaunch and go to <T v="body" style={{ fontWeight: "600" }}>Settings → Phone app → Link your phone</T>. Then scan the QR code, or type the code.
          </T>
        </View>

        {s.notice ? <Notice tone="warning">{s.notice}</Notice> : null}
        {s.linked && fromLink ? <Notice tone="accent">This phone is already linked. Linking it again replaces that link.</Notice> : null}

        <Button title="Scan the QR code" icon={ScanLine} onPress={() => setScanning(true)} />

        <View style={{ gap: 10 }}>
          <T v="footnote" style={{ fontWeight: "600", color: color.ink }}>
            Or type the code
          </T>
          <Field
            value={code}
            onChangeText={(t) => {
              setCode(formatAsTyped(t));
              if (error) setError(null);
            }}
            placeholder="ABCD-EFGH"
            autoCapitalize="characters"
            autoCorrect={false}
            autoComplete="off"
            maxLength={9}
            returnKeyType="go"
            onSubmitEditing={() => void redeem(code)}
            invalid={Boolean(error)}
            accessibilityLabel="Link code"
            style={styles.code}
          />
          {error ? (
            <T v="footnote" style={{ color: color.danger }} accessibilityLiveRegion="polite">
              {error}
            </T>
          ) : null}
          <Button title="Link this phone" variant={complete ? "primary" : "outline"} loading={busy} disabled={!complete} onPress={() => void redeem(code)} />
        </View>

        <View style={styles.trust}>
          <ShieldCheck size={18} color={color.ink3} strokeWidth={1.9} />
          <T v="footnote" style={{ flex: 1 }}>
            No password on your phone. The code works once and only for 10 minutes. Remove this phone any time on the web, or unlink it in the app’s settings.
          </T>
        </View>

        {serverFor ? (
          <Notice tone="warning">
            <T v="footnote" style={{ color: color.warning }}>
              Linking to {hostOf(serverFor)} (a test server).{" "}
              <T v="footnote" style={{ color: ac.accent, fontWeight: "600" }} onPress={() => setServerFor(null)}>
                Use the usual MuseLaunch
              </T>
            </T>
          </Notice>
        ) : null}

        {devTaps >= 5 ? (
          <View style={styles.dev}>
            <T v="footnote" style={{ fontWeight: "600", color: color.ink }}>
              Developer: server
            </T>
            <T v="caption">Now: {s.apiBase}</T>
            <Field value={server} onChangeText={setServer} placeholder="http://192.168.1.20:8080" autoCapitalize="none" autoCorrect={false} keyboardType="url" accessibilityLabel="Server address" />
            <View style={{ flexDirection: "row", gap: 8 }}>
              <Button title="Use this server" size="md" variant="outline" disabled={!isHttpUrl(server)} onPress={() => void s.setApiBase(server.trim()).then(() => setServer(""))} style={{ flex: 1 }} />
              <Button title="Reset" size="md" variant="ghost" onPress={() => void s.setApiBase(null)} />
            </View>
          </View>
        ) : null}
      </ScrollView>

      <Scanner open={scanning} onClose={() => setScanning(false)} onScanned={onScanned} />
    </SafeAreaView>
  );
}

function Scanner({ open, onClose, onScanned }: { open: boolean; onClose: () => void; onScanned: (text: string) => boolean }) {
  const [permission, requestPermission] = useCameraPermissions();
  const [hint, setHint] = useState<string | null>(null);
  const lastBad = useRef(0);
  useEffect(() => {
    if (open && permission && !permission.granted && permission.canAskAgain) void requestPermission();
  }, [open, permission, requestPermission]);
  const onBarcode = (r: BarcodeScanningResult) => {
    if (onScanned(r.data)) return;
    if (Date.now() - lastBad.current > 2500) {
      lastBad.current = Date.now();
      setHint("That isn’t a MuseLaunch link code. Scan the code in Settings → Phone app.");
    }
  };
  return (
    <Modal visible={open} animationType="slide" onRequestClose={onClose} presentationStyle="fullScreen">
      <View style={{ flex: 1, backgroundColor: color.black }}>
        {permission?.granted ? <CameraView style={StyleSheet.absoluteFill} facing="back" barcodeScannerSettings={{ barcodeTypes: ["qr"] }} onBarcodeScanned={open ? onBarcode : undefined} /> : null}
        <SafeAreaView style={{ flex: 1, justifyContent: "space-between", padding: space.gutter }}>
          <View style={{ flexDirection: "row", justifyContent: "flex-end" }}>
            <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close the scanner" style={styles.close}>
              <X size={22} color={color.white} />
            </Pressable>
          </View>
          <View style={styles.frame} />
          <View style={{ gap: 10 }}>
            {permission && !permission.granted ? (
              <View style={{ gap: 10 }}>
                <T v="body" style={{ color: color.white, textAlign: "center" }}>
                  MuseLaunch needs the camera to scan the code. You can also close this and type it.
                </T>
                {permission.canAskAgain ? <Button title="Allow the camera" onPress={() => void requestPermission()} /> : <T v="footnote" style={{ color: "#ddd", textAlign: "center" }}>Turn on the camera for MuseLaunch in your phone’s settings.</T>}
              </View>
            ) : (
              <T v="body" style={{ color: color.white, textAlign: "center" }}>
                {hint ?? "Point your camera at the QR code on your computer."}
              </T>
            )}
          </View>
        </SafeAreaView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  page: { padding: space.gutter, paddingTop: 28, gap: 22, maxWidth: 560, width: "100%", alignSelf: "center" },
  brand: { alignItems: "center", paddingVertical: 8 },
  code: { fontSize: 24, letterSpacing: 4, textAlign: "center", fontWeight: "600", minHeight: 58 },
  trust: { flexDirection: "row", gap: 10, alignItems: "flex-start", paddingTop: 4 },
  dev: { gap: 8, padding: 14, borderRadius: 16, backgroundColor: color.mist },
  close: { width: 44, height: 44, borderRadius: 22, backgroundColor: "rgba(0,0,0,0.45)", alignItems: "center", justifyContent: "center" },
  frame: { alignSelf: "center", width: 240, height: 240, borderRadius: 28, borderWidth: 3, borderColor: "rgba(255,255,255,0.9)" },
});
