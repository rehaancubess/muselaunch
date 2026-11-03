# MuseLaunch phone app (iPhone + Android)

Expo SDK 58 (React Native 0.88, expo-router), TypeScript. Three tabs like the web: **Home** (review and
schedule posts, Edit by typing or holding the mic, Share to Instagram / TikTok yourself and then "Did you
post it?"), **Create** (the web's Create request: Promote my app / Show a feature / Use a suggested idea,
format, length, the real credit cost, Generate video; the server makes the video and the app shows where
it stands from `GET /apps/:appId/create-runs`, with Try again / Finish it at the new price when the run
stops for a decision) and **Results** (three numbers, the daily chart, best post, the tip). Push
notifications when posts are ready to review, when a post goes live and when the Always on weekly summary
is ready.

The interface colour follows the open app (`src/lib/app-theme.ts` `themeFor(app)`): the app's
`theme.color` (picked from its icon, changeable on the web in About your app) drives the accents;
without one it's monochrome (graphite). The phone only reads it.

This folder is **outside the pnpm workspace**: it has its own `package.json` and `package-lock.json`, and
`pnpm install`, the web/API builds and the Cloud Run deploy ignore it.

## Sign-in: link the phone from the web (no passwords on the phone)

1. On the web: **Settings → More settings → Phone app → Link your phone**. It shows a QR code and an
   8-character code (works once, for 10 minutes).
2. In the app: **Scan the QR code** (or point the iPhone camera at it: it opens the app), or type the code.
3. The phone gets its own long token (kept in the iOS Keychain / Android Keystore). Remove a phone on the
   web any time, or **Settings → Unlink this phone** in the app. A link lasts 90 days.

The app talks to the production API by default
(`https://muselaunch-api-264489246542.us-central1.run.app`). For a local server: on the Link screen tap
the MuseLaunch logo five times and enter the server address (e.g. `http://192.168.1.20:8080` on your
Wi-Fi), or scan a QR code made by that server.

## Build it (Windows, from the repo root)

You need Node.js (already there if you run MuseLaunch) and your Expo account. Double-click:

| Script | What you get |
|---|---|
| `build-phone-android.cmd` | An **APK** built on Expo's servers, with a link and QR code to install it on Android. |
| `build-phone-ios.cmd` | An **iPhone build** sent to **TestFlight** (App Store Connect). |

What they ask the first time (answer **Yes** to each):

- **Expo login** (username/email + password).
- "Would you like to automatically create an EAS project for @you/muselaunch?" → **Yes** (it writes the
  project id into `app.json`; commit that change).
- Android: "Generate a new Android Keystore?" → **Yes**.
- iOS: your **Apple Developer** login (Apple ID, password, the 6-digit code). Then **Yes** to: set up
  the distribution certificate, the provisioning profile, and **"Set up Push Notifications"** (EAS creates
  the Apple push key; nothing to do by hand for iOS push).
- iOS submit: if it asks to create the app in App Store Connect → **Yes**. If the name "MuseLaunch" is
  taken on the App Store, create the app in App Store Connect with another name (e.g. "MuseLaunch Studio")
  and the bundle id `com.muselaunch.app`, then run the script again.

After the iOS script: Apple processes the build for 10–30 minutes. In **App Store Connect → your app →
TestFlight → Internal Testing**, add yourself as a tester, install **TestFlight** on the iPhone and install
MuseLaunch from it.

After the Android script: open the build link on the phone, download the APK, allow your browser to
install apps if Android asks, install.

The bundle id / package is `com.muselaunch.app` in `app.json` (`ios.bundleIdentifier`,
`android.package`). Change both before the first build if you want another one (it can't change later
for the same store listing).

## Android push notifications (Firebase, about 5 minutes)

iPhone push works with no extra steps. Android push goes through Firebase Cloud Messaging, so Expo needs
your Firebase project's Android app file and a key:

1. **Firebase console** (console.firebase.google.com) → open the MuseLaunch project (the same one the web
   sign-in uses) → **Project settings** (gear) → **General** → **Your apps** → **Add app** → **Android**.
   Package name: `com.muselaunch.app`. Nickname: MuseLaunch. **Register app**.
2. **Download google-services.json** and put it in this folder: `mobile\google-services.json`. (It's in
   `.gitignore`; the build scripts upload it to EAS anyway.)
3. Still in Project settings → **Service accounts** → **Generate new private key** → **Generate key**. A
   JSON file downloads (keep it private; don't put it in the repo).
4. In `mobile\` run `npx eas-cli@latest credentials` → **Android** → **production** (or the build
   profile you use) → **Google Service Account** → **Manage your Google Service Account Key for Push
   Notifications (FCM V1)** → **Set up a Google Service Account Key for Push Notifications (FCM V1)** →
   **Upload a new service account key** → pick the JSON from step 3.
5. Run `build-phone-android.cmd` again (the app needs a new build to include google-services.json).

The server needs no secret for Expo's push service. Only if you turn on "enhanced push security" for the
project on expo.dev, put an Expo access token in `.env` as `EXPO_ACCESS_TOKEN` and deploy again.

## How push works

- After linking, the app asks for notification permission once and sends its Expo push token to
  `PUT /v1/me/device/push`. **Settings → Notifications** in the app turns them off (the server stops
  sending; the token stays so turning them on again is instant).
- The API sends through `https://exp.host/--/api/v2/push/send`:
  - posts ready to review (a new approval request; Autopilot's batch sends one; at most one push per app
    per hour; "2 posts are ready to review") → opens Home, to the people who can schedule posts;
  - a post went live through a connected account → opens Results;
  - Always on's weekly summary (once a week while Always on is on) → opens Results.
- Tokens Expo reports as `DeviceNotRegistered` (the app was uninstalled) are removed, from the send
  tickets right away and from the receipts the hourly Always on cron checks.

## Develop

```powershell
cd mobile
npm install
npx expo start            # scan the QR with a development build (Expo Go lacks some modules)
npx tsc --noEmit          # typecheck
npm test                  # unit tests (jest-expo): lib/*.test.ts
npx expo-doctor           # dependency/config check
npx expo export -p web    # a browser preview (camera, mic, share sheet and push are phone-only)
```

The pure logic (headline, times, "where a run stands", Results numbers and tips, link codes, notification
routes) is in `src/lib/` and ported from the web (`apps/web/src/features/*`); keep them in step. API
response types are copied in `src/api/types.ts` from `packages/contracts` (see the comment there).

Icons and the splash are generated from the logo: `node mobile/scripts/make-icons.mjs` (from the repo
root, after `pnpm install`).

## What only works on a real phone

The camera (QR scanning), the microphone (hold to talk), the share sheet (saving the video and handing it
to Instagram/TikTok) and push notifications. A browser preview shows every screen, uses typed codes and
typed instructions, and opens the video in a new tab instead of the share sheet.
