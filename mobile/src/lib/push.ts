/**
 * Push notifications: this phone's Expo push token goes to the API (PUT /v1/me/device/push), which
 * sends through Expo when posts are ready to review, a post goes live, or the weekly summary is ready.
 * Each push carries `data.url`, a path in this app ("/?w=…&a=…" → Home, "/results?…" → Results).
 */
import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import type { Api } from "../api/client";
import type { DeviceView } from "../api/types";

if (Platform.OS !== "web") {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }),
  });
}

export type PushSetup = { token: string | null; state: "granted" | "denied" | "unavailable"; reason?: string };

/** Ask for permission (once; the OS remembers) and get this phone's Expo push token. */
export async function registerForPush(opts: { ask: boolean }): Promise<PushSetup> {
  if (Platform.OS === "web") return { token: null, state: "unavailable", reason: "Notifications work in the phone app." };
  if (!Device.isDevice) return { token: null, state: "unavailable", reason: "Notifications need a real phone (not a simulator)." };
  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("default", { name: "MuseLaunch", importance: Notifications.AndroidImportance.HIGH, lightColor: "#1d1d1f" });
  }
  let { status } = await Notifications.getPermissionsAsync();
  if (status !== "granted" && opts.ask) status = (await Notifications.requestPermissionsAsync()).status;
  if (status !== "granted") return { token: null, state: "denied", reason: "Notifications are off for MuseLaunch in your phone’s settings." };
  const projectId = (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId ?? Constants.easConfig?.projectId;
  if (!projectId) return { token: null, state: "unavailable", reason: "This build isn’t connected to its Expo project, so it can’t get notifications." };
  try {
    const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
    return { token, state: "granted" };
  } catch (err) {
    return { token: null, state: "unavailable", reason: `Notifications aren’t set up in this build (${(err as Error).message.slice(0, 120)}).` };
  }
}

/** Register (or refresh) this phone's token with MuseLaunch, keeping the person's switch as it is. */
export async function syncPushToken(api: Api, opts: { ask: boolean }): Promise<{ device: DeviceView | null; setup: PushSetup }> {
  const setup = await registerForPush(opts);
  if (!setup.token) return { device: null, setup };
  const r = await api.put<{ device: DeviceView }>("/v1/me/device/push", { token: setup.token });
  return { device: r.device, setup };
}

export async function setPushEnabled(api: Api, enabled: boolean): Promise<DeviceView> {
  return (await api.put<{ device: DeviceView }>("/v1/me/device/push", { enabled })).device;
}

export { routeForNotification } from "./notification-route";
