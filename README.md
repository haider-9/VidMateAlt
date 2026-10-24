# VidmateAlt

VidmateAlt is a responsive media app with a YouTube subscriptions feed and a download manager for direct HTTP and HTTPS file links. The Videos view can connect a Google account and show recent uploads from subscribed channels. YouTube does not expose its personalized Home recommendations through the official Data API, so this is a Following feed, not your Home feed. Video embeds are for playback; they are not downloaded. In Downloads, paste a direct media or file URL, track progress, cancel active downloads, and browse completed downloads in the local library. Files are saved in your system's `Downloads` folder, and the library list is stored locally in the app.

This app does not extract media links from web pages or third-party streaming platforms. Use direct links to files you have permission to download.

## Connect YouTube

1. In Google Cloud Console, create/select a project and enable **YouTube Data API v3**.
2. Configure the OAuth consent screen and create an OAuth client with application type **Desktop app**.
3. Copy the client ID into the **Google OAuth client ID** field on the Videos screen. A client ID is public configuration, not a password.
4. Choose **Connect YouTube** and approve the read-only YouTube permission in your system browser.

The app uses OAuth PKCE and a temporary localhost callback. The access token is held in memory only; reconnect after restarting the app. Disconnect clears the current in-app feed. You can also revoke VidmateAlt's access from your Google Account security settings.

## Development

Requirements: Node.js, npm, Rust, and the system dependencies required by Tauri 2 for your operating system.

```sh
npm install
npm run tauri dev
```

For a frontend-only preview, run `npm run dev`. Native download commands are available only inside the Tauri app.

## Build

```sh
npm run tauri build
```

Frontend type checking and production bundling can be run independently with `npm run build`; backend compilation can be checked with `cargo check --manifest-path src-tauri/Cargo.toml`.
# VidMateAlt
