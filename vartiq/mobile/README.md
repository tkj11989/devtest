# VartiQ for Android

The Android app is the VartiQ web app in a native shell ([Capacitor](https://capacitorjs.com)). It opens `https://vartiq.prayuktech.com`
(set in `capacitor.config.json`), so every change to the server shows up in the app at once, without a new release. The shell adds what a
browser cannot do: **notifications through Firebase**, the Back button, saving files through Android's share sheet, and a place in the
Play Store. Voice and video calls, voice notes, photos, location and everything else run in the app's WebView.

*This folder was generated and checked on a machine without the Android SDK, so the app has **not been built here**. Build it on a computer
with Android Studio (steps below) and report anything that does not work.*

## 1. Build and run it (debug)

You need Node 22, JDK 21 and [Android Studio](https://developer.android.com/studio) (it installs the Android SDK).

```bash
cd vartiq/mobile
npm install
npx cap sync android        # copies the settings and plugins into the Android project
npx cap open android        # opens it in Android Studio; press Run, pick an emulator or a phone
```

To try the app against a server on your own computer, change `server.url` to its address (for the emulator `http://10.0.2.2:3000`) and set
`"cleartext": true` while testing; put both back before a release.

## 2. Notifications (Firebase)

Browsers get notifications through Web Push. The app cannot, so it registers a Firebase Cloud Messaging (FCM) token and the server sends the
same small wake-ups ("Asha: New message", "Incoming video call", never the message itself) to it.

1. In the [Firebase console](https://console.firebase.google.com) create a project and **add an Android app** with the package name
   `com.prayuktech.vartiq`.
2. Download **`google-services.json`** and put it in `mobile/android/app/`. (It is ignored by git. Without it the app still works, only
   notifications do not.)
3. In *Project settings, Service accounts*, choose **Generate new private key**. Copy that JSON file to the server (for example
   `/etc/vartiq/fcm.json`, owner `root`, group `vartiq`, mode `640`) and add one line to `/etc/vartiq/vartiq.env`:
   `FCM_SERVICE_ACCOUNT=/etc/vartiq/fcm.json`, then `sudo systemctl restart vartiq`. (The server needs outbound HTTPS to
   `oauth2.googleapis.com` and `fcm.googleapis.com`.)
4. In the app: Profile, Notifications, **Turn on**. The Settings screen says when the server is not set up for the app.

Calls ring as a high-priority notification on their own "Calls" channel. A full-screen ring over the lock screen (like a phone call) is not
built yet.

## 3. A release for the Play Store

1. **Signing.** Make an upload key once and keep it (and its passwords) safe and out of git:
   `keytool -genkey -v -keystore vartiq-upload.jks -keyalg RSA -keysize 2048 -validity 10000 -alias upload`.
   In Android Studio: *Build, Generate Signed App Bundle*, choose **Android App Bundle**, release. Upload the `.aab` to the Play Console.
   Raise `versionCode` (and `versionName`) in `android/app/build.gradle` for every upload.
2. **Play Console.** A developer account costs a one-time fee, and an *organisation* account needs a registered business (see the notes in
   `docs/PLATFORM-GAPS.md`). Fill in:
   * **Privacy policy:** `https://vartiq.prayuktech.com/legal/privacy`
   * **Account deletion** (required): `https://vartiq.prayuktech.com/legal/delete-account` (people can also delete in the app, Profile)
   * **Data safety:** the answers are in `docs/PRIVACY-COMPLIANCE.md` (what is collected, why, encrypted in transit, deletable)
   * **Permissions** it will ask about: microphone and camera (calls, voice notes, video calls), location (only when you tap *Share location*),
     contacts (only when you tap *Find friends*; the numbers become fingerprints on the phone and are not kept), notifications. Nothing runs in the background except notifications.
   * **Target audience and content:** VartiQ lets people from 8 with a parent's or guardian's consent. Choosing an audience that includes
     children brings Google's *Families* rules; take your lawyer's advice before you choose.
3. **Test first** on a real phone: sign up, send a message, a photo, a voice note, make a voice and a video call over mobile data, turn
   notifications on, close the app and send a message from another account, tap the notification, save a document, press Back.

## 4. What is in this folder

| | |
|---|---|
| `capacitor.config.json` | app id, name, the server address, splash and status bar colours |
| `www/index.html` | the page shown when the server cannot be reached |
| `android/` | the Android Studio project (permissions are in `app/src/main/AndroidManifest.xml`) |
| `assets/` | the icon and splash sources; after changing them run `npx capacitor-assets generate --android --iconBackgroundColor '#061639' --splashBackgroundColor '#061639'` |

The code that talks to the shell is `public/native.js` (notifications, Back button, saving files); it does nothing in an ordinary browser.

## 5. iPhone

Not set up. `npm i @capacitor/ios && npx cap add ios` creates the project, but it needs a Mac with Xcode, an Apple Developer account, an APNs key
uploaded to Firebase, and Apple is stricter about apps that are mostly a website: plan for native additions (notifications, sharing, a share
extension) before applying.
