/**
 * Where the phone keeps its link: the device token in the iOS Keychain / Android Keystore
 * (expo-secure-store). On web (only used to preview the app in a browser) localStorage stands in.
 */
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

export const KEYS = {
  token: "ml.token",
  device: "ml.device",
  api: "ml.api",
  workspace: "ml.workspace",
  app: "ml.app",
  user: "ml.user",
} as const;

const web = Platform.OS === "web";

export async function getItem(key: string): Promise<string | null> {
  try {
    if (web) return typeof localStorage !== "undefined" ? localStorage.getItem(key) : null;
    return await SecureStore.getItemAsync(key);
  } catch {
    return null;
  }
}

export async function setItem(key: string, value: string | null): Promise<void> {
  try {
    if (web) {
      if (typeof localStorage === "undefined") return;
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
      return;
    }
    if (value === null) await SecureStore.deleteItemAsync(key);
    else await SecureStore.setItemAsync(key, value, { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY });
  } catch {
    // Storage can fail (a locked device, a private browser window): the app keeps working this session.
  }
}
