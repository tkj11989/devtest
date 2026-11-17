# Release checklist

## Build the native apps (Capacitor)
```bash
npm install
npx cap add android && npx cap add ios      # first time
npx cap sync
npx cap open android   # Android Studio → Build → Generate Signed Bundle (AAB)
npx cap open ios       # Xcode → Product → Archive
```
- [ ] Set `appId`, version, icons (1024² + adaptive icon) and splash in native projects.
- [ ] Android: add AdMob **App ID** meta-data to `AndroidManifest.xml`; iOS: `GADApplicationIdentifier` + `SKAdNetworkItems` + `NSUserTrackingUsageDescription` (only if you enable personalised ads).
- [ ] Admin → Advertising: real ad unit IDs, **test mode OFF**; verify in a release build with test device IDs registered.
- [ ] Ship `content-overrides.json` if you changed content.

## Policy & privacy review (must be done by a person)
- [ ] **Google Play Families Policy** (apps with children as a target audience): Designed for Families questionnaire, child-directed ads only from certified ad SDKs/formats, content rating (IARC), Data safety form (this build collects no personal data; list ad SDK data).
- [ ] **Apple App Store – Kids Category / privacy**: age rating, privacy “nutrition label”, no third-party analytics/ads in Kids Category unless permitted; review parental-gate requirements for external links & purchases.
- [ ] **COPPA / GDPR-K / local rules**: verifiable parental consent only needed if personal data is collected — the game collects none; confirm after adding any backend. Publish a privacy policy URL; provide account/data deletion (in-app: Settings → Delete all my data).
- [ ] AdMob: set *Tag for child-directed treatment* and *under age of consent* at account level; max ad content rating G for child apps; consent (UMP) for EEA/UK adults if personalised ads are enabled.
- [ ] Review educational content for accuracy: Admin → Quality & Reports (resolve all flags), spot-check history/science facts; ensure *Debated* labels are applied.

## Quality gates
- [ ] `npm test` green; `npm run test:browser` green.
- [ ] Manual matrix in `docs/TESTING.md` completed on real devices.
- [ ] No test ads in release build; no console errors; crash-free session on 30-minute soak.
- [ ] Store assets: screenshots (phone/tablet), feature graphic, description, support email (Admin → Settings).
- [ ] Backend (optional, post-launch): global leaderboards, multi-user admin auth, ad revenue API ingestion.
