// Seeds the LOCAL Firebase emulators with demo developers, apps and filling pools.
// Run with the emulators up:  npm --prefix functions run seed
// Refuses to run against a real project.
process.env.FIRESTORE_EMULATOR_HOST ||= "127.0.0.1:8080";
process.env.FIREBASE_AUTH_EMULATOR_HOST ||= "127.0.0.1:9099";

const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");

initializeApp({ projectId: "apptestprayuktech" });
const db = getFirestore();
const auth = getAuth();
const now = Date.now();

const devs = [
  { email: "dev1@test.local", name: "Asha (dev)", app: "Budget Buddy", pkg: "com.demo.budgetbuddy", fill: 17,
    desc: "Track daily spending in two taps.", steps: "Add three expenses, open the monthly chart, export CSV." },
  { email: "dev2@test.local", name: "Ravi (dev)", app: "Quiz Sprint", pkg: "com.demo.quizsprint", fill: 6,
    desc: "60-second trivia rounds.", steps: "Play two rounds, check the leaderboard, change the theme." },
  { email: "dev3@test.local", name: "Meera (dev)", app: "Plant Pal", pkg: "com.demo.plantpal", fill: 0,
    desc: "Watering reminders for house plants.", steps: "Add a plant, set a reminder, mark it watered." },
  // Uses an app that is preinstalled on the Android emulator, so "Test app (30 s)" really opens something.
  { email: "dev4@test.local", name: "Kiran (dev)", app: "Calendar (emulator demo)", pkg: "com.google.android.calendar", fill: 17,
    desc: "Demo package that is installed on the emulator.", steps: "Open the calendar, create an event, keep it open 30 seconds." },
];

async function user(email, displayName) {
  try { return (await auth.getUserByEmail(email)).uid; }
  catch { return (await auth.createUser({ email, password: "password", displayName })).uid; }
}

(async () => {
  // Platform default package limit; a user doc's own `maxTesterPools` overrides it.
  await db.doc("config/limits").set({ maxTesterPools: 2, rewardedAdCredits: 0.25, rewardedAdDailyCap: 3 }, { merge: true });
  for (const d of devs) {
    const poolIdCheck = `pool_${d.pkg.split(".").pop()}`;
    if ((await db.doc(`pools/${poolIdCheck}`).get()).exists) { console.log(`${d.app}: already seeded, skipped`); continue; }
    const uid = await user(d.email, d.name);
    await db.doc(`users/${uid}`).set({
      uid, email: d.email, displayName: d.name, credits: 0, reputation: 0,
      activeTesterPools: 0, activeDevPools: 1, groupMember: true, status: "ok", createdAt: now,
    });
    const appId = `app_${d.pkg.split(".").pop()}`;
    await db.doc(`apps/${appId}`).set({
      appId, ownerUid: uid, name: d.app, packageName: d.pkg, description: d.desc, testInstructions: d.steps,
      checklist: { groupAdded: true, buildReleased: true, linkPasted: true },
    });
    await db.doc(`appSecrets/${appId}`).set({ optInLink: `https://play.google.com/apps/testing/${d.pkg}` });
    const poolId = `pool_${d.pkg.split(".").pop()}`;
    await db.doc(`pools/${poolId}`).set({
      poolId, appId, ownerUid: uid, state: "filling", minTesters: 18, durationDays: 16,
      createdAt: now - d.fill * 60_000, testerCount: d.fill, activeCount: d.fill,
    });
    for (let i = 1; i <= d.fill; i++) {
      const tuid = `seed_tester_${i}`;
      await db.doc(`poolMembers/${poolId}_${tuid}`).set({
        poolId, uid: tuid, appId, status: "joined", joinedAt: now, checkInCount: 0, feedback8: false, feedback16: false,
      });
    }
    console.log(`${d.app}: pool ${poolId} with ${d.fill}/18 testers, owner ${d.email}`);
  }
  console.log("Seeded. Developer logins use password: password");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
