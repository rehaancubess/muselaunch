import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as Notifications from "expo-notifications";
import { router, SplashScreen, Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect, useRef } from "react";
import { Platform } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { ApiError } from "../api/client";
import { routeForNotification } from "../lib/notification-route";
import { SessionProvider, useSession } from "../session";
import { color } from "../ui/theme";
import { AccentProvider } from "../ui/accent";
import { ToastProvider } from "../ui/toast";

void SplashScreen.preventAutoHideAsync().catch(() => {});

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // A 4xx won't change by asking again; a dropped connection or a 5xx might.
      retry: (n, err) => n < 2 && !(err instanceof ApiError && err.status >= 400 && err.status < 500),
      staleTime: 10_000,
    },
  },
});

/** Tapping a notification opens the right screen, on the app it's about (also from a cold start). */
function NotificationRouter() {
  const { loaded, linked, select } = useSession();
  const handled = useRef<string | null>(null);
  useEffect(() => {
    if (Platform.OS === "web" || !loaded || !linked) return;
    const open = (response: Notifications.NotificationResponse | null) => {
      if (!response) return;
      const id = response.notification.request.identifier;
      if (handled.current === id) return;
      handled.current = id;
      const to = routeForNotification(response.notification.request.content.data);
      if (!to) return;
      void select({ ...(to.workspaceId ? { workspaceId: to.workspaceId } : {}), ...(to.appId ? { appId: to.appId } : {}) }).then(() => router.navigate(to.path));
    };
    void Notifications.getLastNotificationResponseAsync().then(open);
    const sub = Notifications.addNotificationResponseReceivedListener(open);
    return () => sub.remove();
  }, [loaded, linked, select]);
  return null;
}

function SplashGate() {
  const { loaded } = useSession();
  useEffect(() => {
    if (loaded) void SplashScreen.hideAsync().catch(() => {});
  }, [loaded]);
  return null;
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        <SessionProvider>
          <AccentProvider>
          <ToastProvider>
            <SplashGate />
            <NotificationRouter />
            <StatusBar style="dark" />
            <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: color.canvas } }}>
              <Stack.Screen name="(tabs)" />
              <Stack.Screen name="link" options={{ gestureEnabled: false }} />
              <Stack.Screen name="settings" options={{ presentation: "modal" }} />
            </Stack>
          </ToastProvider>
          </AccentProvider>
        </SessionProvider>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}
