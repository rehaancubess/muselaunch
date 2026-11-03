import { router } from "expo-router";
import { Check, ChevronDown, Settings } from "lucide-react-native";
import { useState } from "react";
import { Image, Pressable, StyleSheet, View } from "react-native";
import { useAssetUrl } from "../api/hooks";
import type { App } from "../api/types";
import { useSession } from "../session";
import { IconButton, Sheet, T } from "../ui/components";
import { color, space } from "../ui/theme";
import { useAccent } from "../ui/accent";

export function AppIcon({ app, size = 32 }: { app: App | null; size?: number }) {
  const ac = useAccent();
  const icon = useAssetUrl(app?.iconAssetId);
  const r = Math.round(size * 0.26);
  if (icon.data?.url) return <Image source={{ uri: icon.data.url }} style={{ width: size, height: size, borderRadius: r, backgroundColor: color.mist }} accessibilityIgnoresInvertColors />;
  return (
    <View style={{ width: size, height: size, borderRadius: r, backgroundColor: ac.accent, alignItems: "center", justifyContent: "center" }}>
      <T v="headline" style={{ color: color.white, fontSize: size * 0.48, lineHeight: size * 0.6 }}>
        {(app?.name ?? "M").trim().charAt(0).toUpperCase()}
      </T>
    </View>
  );
}

/** The app name (switch apps when there are several) and Settings. */
export function AppHeader() {
  const ac = useAccent();
  const { app, apps, select } = useSession();
  const [picking, setPicking] = useState(false);
  const many = apps.length > 1;
  return (
    <View style={styles.bar}>
      <Pressable
        disabled={!many}
        onPress={() => setPicking(true)}
        accessibilityRole={many ? "button" : "text"}
        accessibilityLabel={many ? `${app?.name ?? "Your app"}. Switch app` : (app?.name ?? "Your app")}
        style={({ pressed }) => [styles.app, pressed && { opacity: 0.6 }]}
      >
        <AppIcon app={app} />
        <T v="headline" numberOfLines={1} style={{ flexShrink: 1 }}>
          {app?.name ?? "MuseLaunch"}
        </T>
        {many ? <ChevronDown size={18} color={color.ink2} /> : null}
      </Pressable>
      <IconButton icon={Settings} label="Settings" onPress={() => router.push("/settings")} />
      <Sheet open={picking} onClose={() => setPicking(false)} title="Your apps">
        <View style={{ gap: 4 }}>
          {apps.map((a) => (
            <Pressable
              key={a.id}
              accessibilityRole="button"
              accessibilityState={{ selected: a.id === app?.id }}
              onPress={() => {
                void select({ appId: a.id });
                setPicking(false);
              }}
              style={({ pressed }) => [styles.pick, pressed && { backgroundColor: color.mist }]}
            >
              <AppIcon app={a} size={36} />
              <T v="body" style={{ flex: 1 }} numberOfLines={1}>
                {a.name}
              </T>
              {a.id === app?.id ? <Check size={20} color={ac.accent} /> : null}
            </Pressable>
          ))}
        </View>
      </Sheet>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12, paddingHorizontal: space.gutter, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: color.line, backgroundColor: color.surface },
  app: { flexDirection: "row", alignItems: "center", gap: 10, flexShrink: 1, minHeight: 44 },
  pick: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 56, paddingHorizontal: 8, borderRadius: 14 },
});
