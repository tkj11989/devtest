# Document Summarizer: Android & iOS app

A React Native (Expo) app built from one codebase for Android and iOS. It is a client of the same
Document Summarizer server as the web UI, so it uses the **same Qwen model (Ollama), the same ChromaDB
RAG database and the same user accounts**. A document uploaded on the phone shows up on the web, and
the reverse.

## Features

- **Login with a one-time code** sent to your email or mobile number (SMS). The session token is
  stored in the iOS Keychain / Android Keystore (`expo-secure-store`).
- **Upload**: pick a file (PDF, DOCX, TXT, images), **scan a page with the camera**, or choose a photo.
- **Sections**: tick sections, choose *Brief / Bullets / Detailed*, view a section's full text.
- **Summary preview**: summaries appear section by section. Copy, Share, Regenerate,
  **← Back to sections** (keeps your selection) and **⌂ Home**.
- **Ask questions**: about one document or all of your documents, with expandable cited sources.

## Run in development

1. Start the server (see the main README) so the phone can reach it, binding to all interfaces:
   ```bash
   uvicorn docsum.main:app --host 0.0.0.0 --port 8000
   ```
2. Point the app at it:
   ```bash
   cd mobile
   cp .env.example .env   # set EXPO_PUBLIC_API_URL
   npm install
   ```
   | Where the app runs | `EXPO_PUBLIC_API_URL` |
   |---|---|
   | Android emulator | `http://10.0.2.2:8000` |
   | iOS simulator | `http://localhost:8000` |
   | Physical phone (same Wi-Fi) | `http://<your computer's LAN IP>:8000` |
3. Build and run a development build. The app uses native modules (camera, secure storage), so use a
   dev build instead of Expo Go:
   ```bash
   npx expo run:android        # needs Android Studio / SDK
   npx expo run:ios            # needs macOS + Xcode
   # or build in the cloud without local tooling:
   npx eas-cli@latest build --profile development --platform android|ios
   ```

## Release builds

```bash
npx eas-cli@latest build --platform android   # .aab for Google Play
npx eas-cli@latest build --platform ios       # for the App Store / TestFlight
```
Before releasing:
- Serve the API over **HTTPS** (e.g. a reverse proxy with a domain) and set `EXPO_PUBLIC_API_URL` to it.
  Plain HTTP is allowed in this config only for local development (`usesCleartextTraffic` on Android,
  `NSAllowsLocalNetworking` on iOS). Remove those from `app.json` once you use HTTPS.
- Change `ios.bundleIdentifier` / `android.package` in `app.json` (currently `com.example.docsum`) and the app icons.

## Checks

```bash
npm run typecheck
npm run lint
```

## Code layout

```
src/app/            Screens (Expo Router: each file is a route)
  _layout.tsx       Stack navigator; Stack.Protected sends logged-out users to /login
  login.tsx         Email/mobile entry, then 6-digit code
  index.tsx         Home: upload (file / camera / photos), documents, Ask all
  doc/[id]/index.tsx    Sections selection + style
  doc/[id]/summary.tsx  Summary preview, Back to sections / Home
  ask.tsx           RAG Q&A chat (one document or all)
src/lib/api.ts      Typed client for the server API
src/lib/auth.tsx    Session context + secure token storage
src/components/ui.tsx  Themed UI components (light/dark), markdown renderer
```
