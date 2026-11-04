import { Redirect } from "expo-router";
import { Platform } from "react-native";
import { Tabs } from "expo-router/js-tabs";
import { ChartNoAxesColumn, House, Sparkles } from "lucide-react-native";
import { useToday } from "../../api/hooks";
import { isPostChangeRunning } from "../../api/types";
import { usePushRegistration } from "../../features/push";
import { useSession } from "../../session";
import { color } from "../../ui/theme";
import { useAccent } from "../../ui/accent";

/** Home / Create / Results, like the web. Not linked yet → the Link screen. */
export default function TabsLayout() {
  const ac = useAccent();
  const { loaded, linked } = useSession();
  usePushRegistration();
  const today = useToday();
  const waiting = (today.data?.posts ?? []).filter((p) => p.decision && !isPostChangeRunning(p.change)).length;
  if (!loaded) return null;
  if (!linked) return <Redirect href="/link" />;
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: ac.accent,
        tabBarInactiveTintColor: color.ink2,
        // A browser preview has no safe-area inset: give the labels room.
        tabBarStyle: { borderTopColor: color.line, backgroundColor: color.surface, ...(Platform.OS === "web" ? { height: 64, paddingTop: 6, paddingBottom: 8 } : {}) },
        tabBarLabelStyle: { fontSize: 11, fontWeight: "600" },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Home",
          tabBarIcon: ({ color: c }) => <House size={24} color={c} strokeWidth={1.9} />,
          tabBarBadge: waiting ? waiting : undefined,
          tabBarBadgeStyle: { backgroundColor: ac.accent, color: color.white, fontSize: 11 },
        }}
      />
      <Tabs.Screen name="create" options={{ title: "Create", tabBarIcon: ({ color: c }) => <Sparkles size={24} color={c} strokeWidth={1.9} /> }} />
      <Tabs.Screen name="results" options={{ title: "Results", tabBarIcon: ({ color: c }) => <ChartNoAxesColumn size={24} color={c} strokeWidth={1.9} /> }} />
    </Tabs>
  );
}
