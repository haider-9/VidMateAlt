# VidmateAlt

VidmateAlt is an Android-first media app with a YouTube subscriptions feed and a download manager for direct HTTP and HTTPS file links. The Videos view can connect a Google account and show recent uploads from subscribed channels. YouTube does not expose its personalized Home recommendations through the official Data API, so this is a Following feed, not your Home feed. Video embeds are for playback; they are not downloaded. In Downloads, paste a direct media or file URL, track progress, cancel active downloads, and browse completed downloads in the local library. Files are saved in the device Downloads folder, and the library list is stored locally in the app.

This app does not extract media links from web pages or third-party streaming platforms. Use direct links to files you have permission to download.

## Connect YouTube

1. In Google Cloud Console, create/select a project and enable **YouTube Data API v3**.
2. Configure the OAuth consent screen and create an OAuth client with application type **Desktop app**.
3. Copy the client ID into the **Google OAuth client ID** field on the Videos screen. A client ID is public configuration, not a password.
4. Choose **Connect YouTube** and approve the read-only YouTube permission in your system browser.

The app uses OAuth PKCE and a temporary localhost callback. The access token is held in memory only; reconnect after restarting the app. Disconnect clears the current in-app feed. You can also revoke VidmateAlt's access from your Google Account security settings.

## Android Development

Requirements: Node.js, npm, Rust with Android targets, Android SDK and NDK, and Java 21. The Android project is generated under `src-tauri/gen/android`.

```sh
npm install
npm run tauri android dev
```

Build an arm64 debug APK with:

```sh
npm run tauri android build -- --debug --apk --target aarch64
```

The APK is written to `src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk`. Android build outputs are ignored by Git, so the APK is not included in commits or pushes. To install it with a USB-connected, authorized device, run:

```sh
adb install -r src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
```

For a frontend-only browser preview, run `npm run dev`; native download and account-linking features require the installed Android or desktop app.

## Desktop Development

```sh
npm run tauri dev
npm run tauri build
```

Frontend type checking and production bundling can be run independently with `npm run build`; backend compilation can be checked with `cargo check --manifest-path src-tauri/Cargo.toml`.
# VidMateAlt
