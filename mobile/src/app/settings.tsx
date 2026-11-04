/**
 * Settings: who this phone acts for, which app is open, notifications on/off (the in-app switch;
 * the API stops sending when it's off), "Unlink this phone", and a hidden developer setting for the
 * server address (tap the version five times).
 */
import * as Application from "expo-application";
import { router } from "expo-router";
import { Bell, Check, LogOut, Smartphone } from "lucide-react-native";
import { useState } from "react";
import { Alert, Platform, Pressable, ScrollView, StyleSheet, Switch, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { errorMessage } from "../api/client";
import { AppIcon } from "../features/header";
import { useDevice, usePushSetup } from "../features/push";
import { hostOf, isHttpUrl } from "../lib/link-code";
import { setPushEnabled, syncPushToken } from "../lib/push";
import { useSession } from "../session";
import { Button, Card, Divider, Field, Logo, Notice, T } from "../ui/components";
import { color, space } from "../ui/theme";
import { useToast } from "../ui/toast";
import { useQueryClient } from "@tanstack/react-query";
import { useAccent } from "../ui/accent";

const fmtDate = (iso?: string) => (iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "");

export default function SettingsScreen() {
  const ac = useAccent();
  const s = useSession();
  const toast = useToast();
  const qc = useQueryClient();
  const device = useDevice();
  const pushSetup = usePushSetup();
  const [busy, setBusy] = useState<string | null>(null);
  const [taps, setTaps] = useState(0);
  const [server, setServer] = useState("");

  const notificationsOn = device.data?.notifications.enabled ?? true;
  const toggle = async (on: boolean) => {
    setBusy("push");
    try {
      let d = await setPushEnabled(s.api, on);
      if (on && !d.notifications.registered) {
        const r = await syncPushToken(s.api, { ask: true });
        qc.setQueryData(["push-setup"], r.setup);
        if (r.device) d = r.device;
        if (!r.setup.token && r.setup.reason) toast({ title: "Notifications can’t reach this phone yet", body: r.setup.reason, tone: "error" });
      }
      qc.setQueryData(["device", s.api.base], d);
      toast({ title: on ? "Notifications on" : "Notifications off", body: on ? "Posts ready to review, posts going live and your weekly summary." : "MuseLaunch won’t send this phone notifications." });
    } catch (e) {
      toast({ title: "Couldn’t change that", body: errorMessage(e), tone: "error" });
    } finally {
      setBusy(null);
    }
  };

  const unlink = () => {
    const go = async () => {
      setBusy("unlink");
      try {
        await s.api.del("/v1/me/device");
      } catch {
        // Already removed on the web: unlinking here still forgets it.
      }
      await s.signOut(null);
      setBusy(null);
      router.replace("/link");
    };
    if (Platform.OS === "web") return void go();
    Alert.alert("Unlink this phone?", "It stops acting for you right away. You can link it again from MuseLaunch on the web.", [
      { text: "Cancel", style: "cancel" },
      { text: "Unlink", style: "destructive", onPress: () => void go() },
    ]);
  };

  const who = s.me?.user.displayName || s.me?.user.email || "you";
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: color.mist }}>
      <View style={styles.top}>
        <T v="title3" accessibilityRole="header">
          Settings
        </T>
        <Pressable onPress={() => (router.canGoBack() ? router.back() : router.replace("/"))} accessibilityRole="button" hitSlop={10}>
          <T v="body" style={{ color: ac.accent, fontWeight: "600" }}>
            Done
          </T>
        </Pressable>
      </View>
      <ScrollView contentContainerStyle={{ padding: space.gutter, gap: 22, paddingBottom: 48 }}>
        <Card style={{ gap: 4 }}>
          <T v="footnote">Signed in on this phone as</T>
          <T v="headline">{who}</T>
          {s.me?.user.email && s.me.user.displayName ? <T v="footnote">{s.me.user.email}</T> : null}
          {s.workspace ? <T v="footnote">{`Workspace: ${s.workspace.name}`}</T> : null}
        </Card>

        {s.me && s.me.workspaces.length > 1 ? (
          <Group title="Workspace">
            {s.me.workspaces.map((w, i) => (
              <View key={w.workspace.id}>
                {i ? <Divider style={{ marginLeft: 16 }} /> : null}
                <Pressable onPress={() => void s.select({ workspaceId: w.workspace.id, appId: null })} accessibilityRole="button" style={styles.item}>
                  <T v="body" style={{ flex: 1 }}>
                    {w.workspace.name}
                  </T>
                  {w.workspace.id === s.workspaceId ? <Check size={20} color={ac.accent} /> : null}
                </Pressable>
              </View>
            ))}
          </Group>
        ) : null}

        {s.apps.length ? (
          <Group title="App">
            {s.apps.map((a, i) => (
              <View key={a.id}>
                {i ? <Divider style={{ marginLeft: 60 }} /> : null}
                <Pressable onPress={() => void s.select({ appId: a.id })} accessibilityRole="button" accessibilityState={{ selected: a.id === s.appId }} style={styles.item}>
                  <AppIcon app={a} size={32} />
                  <T v="body" style={{ flex: 1 }} numberOfLines={1}>
                    {a.name}
                  </T>
                  {a.id === s.appId ? <Check size={20} color={ac.accent} /> : null}
                </Pressable>
              </View>
            ))}
          </Group>
        ) : null}

        <Group title="Notifications">
          <View style={styles.item}>
            <Bell size={20} color={color.ink2} />
            <View style={{ flex: 1, gap: 2 }}>
              <T v="body">Notifications</T>
              <T v="caption">Posts ready to review (at most one an hour per app), a post going live, and your weekly summary.</T>
            </View>
            <Switch value={notificationsOn} onValueChange={(v) => void toggle(v)} disabled={busy === "push" || !device.data} trackColor={{ true: ac.accent, false: color.mist2 }} thumbColor={color.white} {...(Platform.OS === "web" ? ({ activeThumbColor: color.white } as object) : {})} accessibilityLabel="Notifications" />
          </View>
          {notificationsOn && device.data && !device.data.notifications.registered ? (
            <View style={{ paddingHorizontal: 16, paddingBottom: 14 }}>
              <T v="caption" style={{ color: color.warning }}>
                {pushSetup.data?.reason ?? (Platform.OS === "web" ? "Notifications work in the phone app, not in a browser preview." : "This phone hasn’t registered for notifications yet.")}
              </T>
            </View>
          ) : null}
        </Group>

        <Group title="This phone">
          <View style={styles.item}>
            <Smartphone size={20} color={color.ink2} />
            <View style={{ flex: 1, gap: 2 }}>
              <T v="body">{device.data?.name ?? s.device?.name ?? "This phone"}</T>
              {device.data ? <T v="caption">{`Linked ${fmtDate(device.data.createdAt)} · link lasts until ${fmtDate(device.data.expiresAt)}`}</T> : null}
            </View>
          </View>
          <Divider style={{ marginLeft: 16 }} />
          <Pressable onPress={unlink} accessibilityRole="button" style={styles.item} disabled={busy === "unlink"}>
            <LogOut size={20} color={color.danger} />
            <T v="body" style={{ color: color.danger, fontWeight: "600" }}>
              Unlink this phone
            </T>
          </Pressable>
        </Group>
        <T v="footnote" style={{ marginTop: -12, paddingHorizontal: 4 }}>
          You can also remove this phone on the web: Settings → Phone app.
        </T>

        {!s.isDefaultApi ? <Notice tone="warning">{`Using a test server: ${hostOf(s.apiBase)}`}</Notice> : null}

        <Pressable onPress={() => setTaps((n) => n + 1)} accessibilityRole="text" style={{ alignItems: "center", gap: 6, paddingTop: 8 }}>
          <Logo size={36} />
          <T v="footnote">{`MuseLaunch ${Application.nativeApplicationVersion ?? ""}`.trim()}</T>
          <T v="caption">Create. Review. Grow.</T>
        </Pressable>

        {taps >= 5 ? (
          <Card style={{ gap: 8 }}>
            <T v="footnote" style={{ fontWeight: "600", color: color.ink }}>
              Developer: server
            </T>
            <T v="caption">{`Now: ${s.apiBase}. Changing it unlinks this phone (a link belongs to one server).`}</T>
            <Field value={server} onChangeText={setServer} placeholder="http://192.168.1.20:8080" autoCapitalize="none" autoCorrect={false} keyboardType="url" accessibilityLabel="Server address" />
            <View style={{ flexDirection: "row", gap: 8 }}>
              <Button
                title="Use and unlink"
                size="md"
                variant="outline"
                disabled={!isHttpUrl(server)}
                style={{ flex: 1 }}
                onPress={() =>
                  void (async () => {
                    await s.signOut(null);
                    await s.setApiBase(server.trim());
                    router.replace("/link");
                  })()
                }
              />
              <Button
                title="Reset"
                size="md"
                variant="ghost"
                onPress={() =>
                  void (async () => {
                    if (!s.isDefaultApi) {
                      await s.signOut(null);
                      await s.setApiBase(null);
                      router.replace("/link");
                    }
                  })()
                }
              />
            </View>
          </Card>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={{ gap: 8 }}>
      <T v="footnote" style={{ fontWeight: "600", paddingHorizontal: 4, textTransform: "uppercase", letterSpacing: 0.5, fontSize: 12 }}>
        {title}
      </T>
      <Card padded={false} style={{ overflow: "hidden" }}>
        {children}
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  top: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: space.gutter, paddingVertical: 14, backgroundColor: color.mist },
  item: { flexDirection: "row", alignItems: "center", gap: 14, paddingHorizontal: 16, minHeight: 56, paddingVertical: 10 },
});
