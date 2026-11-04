// Run before an EAS build (build-phone-*.cmd do it): checks the app config and, for Android push
// notifications, points app.json at Firebase's google-services.json when it's in mobile/.
// Without that file the Android build still works; only push notifications stay off on Android.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const appJsonPath = join(root, "app.json");
const platform = process.argv[2] ?? "android";
const app = JSON.parse(readFileSync(appJsonPath, "utf8"));
const expo = app.expo;
const before = JSON.stringify(app);

const hasGoogle = existsSync(join(root, "google-services.json"));
if (hasGoogle) expo.android.googleServicesFile = "./google-services.json";
else delete expo.android.googleServicesFile;

if (JSON.stringify(app) !== before) writeFileSync(appJsonPath, `${JSON.stringify(app, null, 2)}\n`);

const line = (ok, text) => console.log(`  ${ok ? "OK  " : "NOTE"}  ${text}`);
console.log("");
console.log(`  MuseLaunch ${expo.version} · ${expo.ios.bundleIdentifier} (iOS) · ${expo.android.package} (Android)`);
line(true, `Talks to ${process.env.EXPO_PUBLIC_API_URL || expo.extra?.apiUrl}`);
line(Boolean(expo.extra?.eas?.projectId), expo.extra?.eas?.projectId ? `Expo project ${expo.extra.eas.projectId}` : "No Expo project yet: the build will offer to create one (answer Yes).");
if (platform === "android") {
  line(hasGoogle, hasGoogle ? "google-services.json found: Android push notifications are on." : "No google-services.json in mobile\\ yet: the app works, but Android push notifications stay off until you add it (see mobile\\README.md).");
}
console.log("");
