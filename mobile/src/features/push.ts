import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { Platform } from "react-native";
import type { DeviceView } from "../api/types";
import { syncPushToken, type PushSetup } from "../lib/push";
import { useSession } from "../session";

/** This phone, as MuseLaunch knows it (name, notifications switch). */
export function useDevice() {
  const { api, linked } = useSession();
  return useQuery({ queryKey: ["device", api.base], queryFn: () => api.get<{ device: DeviceView }>("/v1/me/device").then((r) => r.device), enabled: linked, staleTime: 60_000 });
}

/** What the OS said about notifications on the last try (Settings shows it). */
export function usePushSetup() {
  return useQuery<PushSetup | null>({ queryKey: ["push-setup"], queryFn: () => null, enabled: false, initialData: null, staleTime: Infinity });
}

/**
 * Once per launch, after linking: if the person kept notifications on, ask the OS (the first time)
 * and send this phone's Expo push token to MuseLaunch.
 */
export function usePushRegistration() {
  const { api, linked, loaded } = useSession();
  const qc = useQueryClient();
  const done = useRef<string | null>(null);
  useEffect(() => {
    if (!loaded || !linked || Platform.OS === "web" || done.current === api.base) return;
    done.current = api.base;
    void (async () => {
      try {
        const { device } = await api.get<{ device: DeviceView }>("/v1/me/device");
        qc.setQueryData(["device", api.base], device);
        if (!device.notifications.enabled) return;
        const r = await syncPushToken(api, { ask: true });
        qc.setQueryData(["push-setup"], r.setup);
        if (r.device) qc.setQueryData(["device", api.base], r.device);
      } catch {
        // Notifications are a nice-to-have: the app works without them (Settings says why).
      }
    })();
  }, [loaded, linked, api, qc]);
}
