import { initializeApp } from "firebase-admin/app";
import { getFirestore, FieldValue, Transaction, DocumentReference } from "firebase-admin/firestore";
import { onCall, HttpsError, CallableRequest } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { defineString } from "firebase-functions/params";
import * as C from "./constants";
import * as L from "./logic";
import { directoryClient } from "./groups";

initializeApp();
const db = getFirestore();

const GROUP_EMAIL = defineString("PLATFORM_GROUP_EMAIL");
const ADMIN_USER = defineString("WORKSPACE_ADMIN_USER");

const uidOf = (req: CallableRequest): string => {
  if (!req.auth) throw new HttpsError("unauthenticated", "Sign in first.");
  return req.auth.uid;
};
const str = (v: unknown, name: string): string => {
  if (typeof v !== "string" || !v.trim()) throw new HttpsError("invalid-argument", `${name} is required`);
  return v.trim();
};
const ledger = (tx: Transaction, uid: string, delta: number, reason: string, poolId?: string) =>
  tx.create(db.collection("creditLedger").doc(), { uid, delta, reason, poolId: poolId ?? null, createdAt: Date.now() });
const queueGroup = (tx: Transaction, op: "add" | "remove", email: string) =>
  tx.create(db.collection("groupQueue").doc(), { op, email, attempts: 0, done: false, createdAt: Date.now() });

/** First sign-in: create the profile and the sign-up credit. Idempotent. */
export const ensureUser = onCall(async (req) => {
  const uid = uidOf(req);
  const email = req.auth!.token.email;
  if (!email) throw new HttpsError("failed-precondition", "Google account has no email.");
  const ref = db.collection("users").doc(uid);
  await db.runTransaction(async (tx) => {
    if ((await tx.get(ref)).exists) return;
    tx.set(ref, {
      uid, email, displayName: req.auth!.token.name ?? "", credits: C.SIGNUP_CREDITS, reputation: 0,
      activeTesterPools: 0, activeDevPools: 0, groupMember: false, status: "ok", createdAt: Date.now(),
    });
    ledger(tx, uid, C.SIGNUP_CREDITS, "signup");
  });
  return { ok: true };
});

/** Developer ticks the setup checklist items; a full pool then starts if it was only waiting on this. */
export const updateChecklist = onCall(async (req) => {
  const uid = uidOf(req);
  const appId = str(req.data.appId, "appId");
  const patch: Partial<C.Checklist> = {};
  for (const k of ["groupAdded", "buildReleased"] as const)
    if (typeof req.data[k] === "boolean") patch[k] = req.data[k];
  const appRef = db.collection("apps").doc(appId);
  await db.runTransaction(async (tx) => {
    const app = await tx.get(appRef);
    if (!app.exists || app.data()!.ownerUid !== uid) throw new HttpsError("permission-denied", "Not your app.");
    const checklist = { ...app.data()!.checklist, ...patch };
    const pools = await tx.get(db.collection("pools").where("appId", "==", appId).where("state", "==", "filling"));
    const limits = await tx.get(db.doc("config/limits"));
    tx.update(appRef, { checklist });
    for (const p of pools.docs) beginInstallIfReady(tx, p.ref, p.data() as C.Pool, checklist, bufferHoursOf(limits));
  });
  return { ok: true };
});

const OPEN_STATES = ["filling", "installing", "running", "at_risk"];
const bufferHoursOf = (limits: FirebaseFirestore.DocumentSnapshot) =>
  typeof limits.data()?.installBufferHours === "number" ? limits.data()!.installBufferHours : C.INSTALL_BUFFER_HOURS;

/** Day 1 of the 16-day test. */
const startedFields = (now: number, testers: number) => ({
  state: L.runningState(testers), startedAt: now, endsAt: now + C.DURATION_DAYS * C.DAY_MS, testerCount: testers, activeCount: testers,
});

/** Pool is full and set up: start the install buffer timer (or start straight away if everyone already installed). */
function beginInstallIfReady(tx: Transaction, ref: DocumentReference, pool: C.Pool, checklist: Partial<C.Checklist>, bufferHours: number) {
  if (!L.shouldBeginInstall(pool, checklist)) return;
  const now = Date.now();
  if ((pool.installedCount ?? 0) >= C.MIN_TESTERS) tx.update(ref, { ...startedFields(now, pool.testerCount), installDeadline: now });
  else tx.update(ref, { state: "installing", installStartedAt: now, installDeadline: L.installDeadline(now, bufferHours) });
}

/**
 * Settles a pool in the install buffer: start testing when all 18 have installed or the timer ran out with
 * at least 12 installed; otherwise reopen it for joins. Testers who never installed are released (no penalty).
 */
async function settleInstallPhase(poolId: string): Promise<string> {
  const poolRef = db.collection("pools").doc(poolId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(poolRef);
    const p = snap.data() as C.Pool | undefined;
    if (!p || p.state !== "installing") return p?.state ?? "missing";
    const now = Date.now();
    const decision = L.installPhase({ installedCount: p.installedCount ?? 0, deadline: p.installDeadline ?? now, now });
    if (decision === "wait") return "installing";
    const members = await tx.get(db.collection("poolMembers").where("poolId", "==", poolId));
    const installed = members.docs.filter((m) => L.isInstalledStatus(m.data().status)).length;
    const notInstalled = members.docs.filter((m) => m.data().status === "joined");
    // Read the users first (transactions need all reads before writes); a deleted account must not wedge the pool.
    const users = await Promise.all(notInstalled.map((m) => tx.get(db.collection("users").doc(m.data().uid))));
    notInstalled.forEach((m, i) => {
      tx.update(m.ref, { status: "dropped", reason: "not_installed", droppedAt: now });
      if (users[i].exists) tx.update(users[i].ref, { activeTesterPools: FieldValue.increment(-1) });
    });
    if (decision === "start") {
      tx.update(poolRef, { ...startedFields(now, installed), installedCount: installed });
      return "running";
    }
    tx.update(poolRef, { state: "filling", testerCount: installed, activeCount: installed, installedCount: installed, installDeadline: FieldValue.delete() });
    return "filling";
  });
}

/** The app calls this when it sees the buffer timer has run out, so the pool moves on without waiting for the sweep. */
export const refreshPool = onCall(async (req) => {
  uidOf(req);
  return { state: await settleInstallPhase(str(req.data.poolId, "poolId")) };
});

/** Backstop for install deadlines when nobody has the app open. */
export const installSweep = onSchedule("every 10 minutes", async () => {
  const pools = await db.collection("pools").where("state", "==", "installing").where("installDeadline", "<=", Date.now()).get();
  for (const p of pools.docs) await settleInstallPhase(p.id);
});

export const createPool = onCall(async (req) => {
  const uid = uidOf(req);
  const appId = str(req.data.appId, "appId");
  const userRef = db.collection("users").doc(uid);
  const appRef = db.collection("apps").doc(appId);
  const poolRef = db.collection("pools").doc();
  await db.runTransaction(async (tx) => {
    const [user, app] = await Promise.all([tx.get(userRef), tx.get(appRef)]);
    if (!user.exists) throw new HttpsError("failed-precondition", "Call ensureUser first.");
    if (!app.exists || app.data()!.ownerUid !== uid) throw new HttpsError("permission-denied", "Not your app.");
    if (!L.checklistComplete(app.data()!.checklist)) throw new HttpsError("failed-precondition", "Finish the setup checklist first.");
    const u = user.data() as C.UserDoc;
    if (u.status === "banned") throw new HttpsError("permission-denied", "Account banned.");
    if (u.activeDevPools >= C.MAX_ACTIVE_POOLS) throw new HttpsError("resource-exhausted", "You already have 2 active pools.");
    if (u.credits < C.POOL_COST) throw new HttpsError("failed-precondition", "Not enough credits.");
    // Spec: same app may run in two pools, with no shared testers (enforced in joinPool via sameAppMembership).
    const open = await tx.get(db.collection("pools").where("appId", "==", appId).where("state", "in", OPEN_STATES));
    if (open.size >= 2) throw new HttpsError("resource-exhausted", "This app already has 2 active pools.");
    tx.set(poolRef, {
      poolId: poolRef.id, appId, ownerUid: uid, state: "filling", minTesters: C.MIN_TESTERS, durationDays: C.DURATION_DAYS,
      createdAt: Date.now(), testerCount: 0, activeCount: 0,
    });
    tx.update(userRef, { credits: FieldValue.increment(-C.POOL_COST), activeDevPools: FieldValue.increment(1) });
    ledger(tx, uid, -C.POOL_COST, "pool_open", poolRef.id);
  });
  return { poolId: poolRef.id };
});

export const joinPool = onCall(async (req) => {
  const uid = uidOf(req);
  const poolId = str(req.data.poolId, "poolId");
  const poolRef = db.collection("pools").doc(poolId);
  const userRef = db.collection("users").doc(uid);
  const memberRef = db.collection("poolMembers").doc(`${poolId}_${uid}`);
  const result = await db.runTransaction(async (tx) => {
    const [pool, user, member] = await Promise.all([tx.get(poolRef), tx.get(userRef), tx.get(memberRef)]);
    if (!pool.exists || !user.exists) throw new HttpsError("not-found", "Pool or user not found.");
    const p = pool.data() as C.Pool;
    const app = await tx.get(db.collection("apps").doc(p.appId)); // all reads before writes
    const limits = await tx.get(db.doc("config/limits"));
    const platformLimit = Number.isInteger(limits.data()?.maxTesterPools) ? limits.data()!.maxTesterPools : C.MAX_ACTIVE_POOLS;
    // Same-app rule: any membership in another pool of this app (any state still holding the slot).
    const siblings = await tx.get(db.collection("pools").where("appId", "==", p.appId).where("state", "in", OPEN_STATES));
    let sameApp = false;
    for (const s of siblings.docs) {
      if (s.id === poolId) continue;
      const m = await tx.get(db.collection("poolMembers").doc(`${s.id}_${uid}`));
      if (m.exists && L.isActiveStatus(m.data()!.status)) sameApp = true;
    }
    const err = L.checkJoin({ user: user.data() as C.UserDoc, uid, pool: p, now: Date.now(), alreadyMember: member.exists, sameAppMembership: sameApp, platformLimit });
    if (err) throw new HttpsError("failed-precondition", err);

    tx.create(memberRef, { poolId, uid, appId: p.appId, status: "joined", joinedAt: Date.now(), checkInCount: 0, feedback8: false, feedback16: false });
    tx.update(userRef, { activeTesterPools: FieldValue.increment(1) });
    const next = { ...p, testerCount: p.testerCount + 1, activeCount: p.activeCount + 1 };
    tx.update(poolRef, { testerCount: next.testerCount, activeCount: next.activeCount });
    if (!user.data()!.groupMember) { queueGroup(tx, "add", user.data()!.email); tx.update(userRef, { groupMember: true }); }
    if (p.state === "filling") beginInstallIfReady(tx, poolRef, next, app.data()?.checklist, bufferHoursOf(limits));
    if (p.state === "at_risk") tx.update(poolRef, { state: L.runningState(next.activeCount) });
    // No opt-in link: the tester installs the package and the app confirms the install with confirmInstalled.
    return { packageName: app.data()?.packageName ?? null, installBufferHours: bufferHoursOf(limits) };
  });
  return result;
});

/** Tester leaves before the end: no credit, reputation penalty, cooldown after repeat exits. Group membership stays. */
export const leavePool = onCall(async (req) => {
  const uid = uidOf(req);
  const poolId = str(req.data.poolId, "poolId");
  await db.runTransaction(async (tx) => {
    const memberRef = db.collection("poolMembers").doc(`${poolId}_${uid}`);
    const poolRef = db.collection("pools").doc(poolId);
    const userRef = db.collection("users").doc(uid);
    const [m, pool, user] = await Promise.all([tx.get(memberRef), tx.get(poolRef), tx.get(userRef)]);
    if (!m.exists || !L.isActiveStatus(m.data()!.status)) throw new HttpsError("failed-precondition", "Not an active member.");
    const p = pool.data() as C.Pool;
    tx.update(memberRef, { status: "dropped", droppedAt: Date.now(), reason: "left" });
    const running = p.state === "running" || p.state === "at_risk";
    const activeCount = p.activeCount - 1;
    const installedDrop = L.isInstalledStatus(m.data()!.status) ? { installedCount: FieldValue.increment(-1) } : {};
    // Filling or installing: the slot frees up and can be refilled. Running: the slot is gone, state may drop to at_risk.
    tx.update(poolRef, { activeCount, ...installedDrop, ...(running ? { state: L.runningState(activeCount) } : { testerCount: p.testerCount - 1 }) });
    const rep = (user.data()!.reputation ?? 0) - (running ? 1 : 0);
    tx.update(userRef, {
      activeTesterPools: FieldValue.increment(-1), reputation: rep,
      ...(running && rep <= -3 ? { status: "cooldown", cooldownUntil: Date.now() + 7 * 86_400_000 } : {}),
    });
  });
  return { ok: true };
});

/** Developer cancels a Filling pool and gets the credit back. Testers are released. */
export const cancelPool = onCall(async (req) => {
  const uid = uidOf(req);
  const poolId = str(req.data.poolId, "poolId");
  const poolRef = db.collection("pools").doc(poolId);
  const members = await db.collection("poolMembers").where("poolId", "==", poolId).get();
  await db.runTransaction(async (tx) => {
    const pool = await tx.get(poolRef);
    const p = pool.data() as C.Pool | undefined;
    if (!p || p.ownerUid !== uid) throw new HttpsError("permission-denied", "Not your pool.");
    if (p.state !== "filling") throw new HttpsError("failed-precondition", "Only a Filling pool can be cancelled.");
    for (const m of members.docs) {
      if (!L.isActiveStatus(m.data().status)) continue;
      tx.update(m.ref, { status: "dropped", reason: "pool_cancelled" });
      tx.update(db.collection("users").doc(m.data().uid), { activeTesterPools: FieldValue.increment(-1) });
    }
    tx.update(poolRef, { state: "cancelled", activeCount: 0 });
    tx.update(db.collection("users").doc(uid), { credits: FieldValue.increment(C.POOL_COST), activeDevPools: FieldValue.increment(-1) });
    ledger(tx, uid, C.POOL_COST, "pool_cancelled_refund", poolId);
  });
  return { ok: true };
});

/**
 * The app found the package installed on the tester's phone and reports it. The install status lives here,
 * in the backend (member.status "installed", installedAt, pool.installedCount). When all 18 testers of a pool
 * in the install buffer have installed, testing starts immediately instead of waiting for the timer.
 */
export const confirmInstalled = onCall(async (req) => {
  const uid = uidOf(req);
  const poolId = str(req.data.poolId, "poolId");
  const ref = db.collection("poolMembers").doc(`${poolId}_${uid}`);
  const poolRef = db.collection("pools").doc(poolId);
  const out = await db.runTransaction(async (tx) => {
    const [m, pool] = await Promise.all([tx.get(ref), tx.get(poolRef)]);
    if (!m.exists) throw new HttpsError("not-found", "Not a member.");
    const p = pool.data() as C.Pool;
    if (L.isInstalledStatus(m.data()!.status)) return { installed: true, state: p.state, already: true };
    if (m.data()!.status !== "joined" || !OPEN_STATES.includes(p.state)) throw new HttpsError("failed-precondition", "Nothing to confirm.");
    const now = Date.now();
    tx.update(ref, { status: "installed", installedAt: now });
    const installedCount = (p.installedCount ?? 0) + 1;
    tx.update(poolRef, { installedCount });
    return { installed: true, state: p.state, installedCount };
  });
  // Last of the 18 installed: start testing now (settle runs its own transaction).
  const state = out.state === "installing" ? await settleInstallPhase(poolId) : out.state;
  return { ...out, state };
});

const checkInRef = (poolId: string, uid: string, day: number) => db.collection("checkIns").doc(`${poolId}_${uid}_d${day}`);

/**
 * Daily test, step 1: the tester taps "Test app". The server stamps the start time (the client clock is
 * never trusted) and returns the package to launch. One recorded test per tester per 24 h day.
 */
export const startTestSession = onCall(async (req) => {
  const uid = uidOf(req);
  const poolId = str(req.data.poolId, "poolId");
  const now = Date.now();
  const memberRef = db.collection("poolMembers").doc(`${poolId}_${uid}`);
  const sessionRef = db.collection("testSessions").doc();
  return db.runTransaction(async (tx) => {
    const [m, pool] = await Promise.all([tx.get(memberRef), tx.get(db.collection("pools").doc(poolId))]);
    if (!m.exists || !L.isActiveStatus(m.data()!.status)) throw new HttpsError("failed-precondition", "Not an active member.");
    if (!L.isInstalledStatus(m.data()!.status)) throw new HttpsError("failed-precondition", "not_installed");
    const p = pool.data() as C.Pool;
    if ((p.state !== "running" && p.state !== "at_risk") || p.startedAt === undefined)
      throw new HttpsError("failed-precondition", "pool_not_running");
    // A replacement who installed after the pool started counts days from their own install.
    const dayStart = L.testerDayStart(m.data()!.installedAt ?? m.data()!.joinedAt, p.startedAt);
    const day = L.testerDay(dayStart, now);
    if ((await tx.get(checkInRef(poolId, uid, day))).exists)
      throw new HttpsError("already-exists", "already_tested_today", { nextDayAt: L.nextDayAt(dayStart, now) });
    const app = await tx.get(db.collection("apps").doc(p.appId));
    tx.create(sessionRef, { poolId, uid, appId: p.appId, day, dayStart, startedAt: now, status: "open" });
    return {
      sessionId: sessionRef.id, packageName: app.data()?.packageName ?? null, day,
      minSeconds: C.MIN_TEST_SECONDS, nextDayAt: L.nextDayAt(dayStart, now),
    };
  });
});

/**
 * Daily test, step 2: the tester is back in our app. If at least 30 s passed since the server-stamped
 * start, that day is recorded. If not, the session stays open so the tester can go back and continue.
 */
export const finishTestSession = onCall(async (req) => {
  const uid = uidOf(req);
  const sessionRef = db.collection("testSessions").doc(str(req.data.sessionId, "sessionId"));
  const now = Date.now();
  return db.runTransaction(async (tx) => {
    const s = await tx.get(sessionRef);
    if (!s.exists || s.data()!.uid !== uid) throw new HttpsError("not-found", "Session not found.");
    const d = s.data()!;
    const seconds = Math.floor((now - d.startedAt) / 1000);
    if (d.status !== "open") throw new HttpsError("failed-precondition", "Session already closed.");
    const memberRef = db.collection("poolMembers").doc(`${d.poolId}_${uid}`);
    const ciRef = checkInRef(d.poolId, uid, d.day);
    const [m, ci] = await Promise.all([tx.get(memberRef), tx.get(ciRef)]);
    if (!m.exists || !L.isActiveStatus(m.data()!.status)) throw new HttpsError("failed-precondition", "Not an active member.");

    const err = L.checkSession({ startedAt: d.startedAt, day: d.day, dayStart: d.dayStart, now });
    if (err === "too_short") return { recorded: false, reason: err, seconds, minSeconds: C.MIN_TEST_SECONDS };
    if (err || ci.exists) {
      tx.update(sessionRef, { status: "rejected", reason: err ?? "already_tested_today", seconds, endedAt: now });
      return { recorded: false, reason: err ?? "already_tested_today", seconds, minSeconds: C.MIN_TEST_SECONDS };
    }
    tx.update(sessionRef, { status: "done", seconds, endedAt: now });
    tx.create(ciRef, { poolId: d.poolId, uid, day: d.day, seconds, sessionId: sessionRef.id, createdAt: now });
    tx.update(memberRef, { status: "active", lastCheckIn: now, lastTestDay: d.day, checkInCount: FieldValue.increment(1) });
    return { recorded: true, day: d.day, seconds, nextDayAt: L.nextDayAt(d.dayStart, now) };
  });
});

export const submitFeedback = onCall(async (req) => {
  const uid = uidOf(req);
  const poolId = str(req.data.poolId, "poolId");
  const day = req.data.day;
  if (!(C.FEEDBACK_DAYS as readonly number[]).includes(day)) throw new HttpsError("invalid-argument", "day must be 8 or 16");
  const rating = Number(req.data.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw new HttpsError("invalid-argument", "rating 1-5");
  const text = str(req.data.text, "text").slice(0, 2000);
  const memberRef = db.collection("poolMembers").doc(`${poolId}_${uid}`);
  await db.runTransaction(async (tx) => {
    const [m, pool] = await Promise.all([tx.get(memberRef), tx.get(db.collection("pools").doc(poolId))]);
    if (!m.exists || !L.isActiveStatus(m.data()!.status)) throw new HttpsError("failed-precondition", "Not an active member.");
    const p = pool.data() as C.Pool;
    if (p.startedAt === undefined || L.dayNumber(p.startedAt, Date.now()) < day) throw new HttpsError("failed-precondition", `Day ${day} has not been reached.`);
    const fb = db.collection("feedback").doc(`${poolId}_${uid}_${day}`);
    if ((await tx.get(fb)).exists) throw new HttpsError("already-exists", "Feedback already sent.");
    tx.create(fb, { poolId, uid, day, rating, text, createdAt: Date.now() });
    tx.update(memberRef, { [`feedback${day}`]: true });
  });
  return { ok: true };
});

/** Rewarded video bonus, capped per day by config/limits. */
export const claimRewardedAd = onCall(async (req) => {
  const uid = uidOf(req);
  const cfg = (await db.doc("config/limits").get()).data() ?? {};
  const rate: number = cfg.rewardedAdCredits ?? 0.25, cap: number = cfg.rewardedAdDailyCap ?? 3;
  const userRef = db.collection("users").doc(uid);
  const claimRef = db.collection("adClaims").doc(`${uid}_${L.dayKey(Date.now())}`);
  await db.runTransaction(async (tx) => {
    const c = await tx.get(claimRef);
    const n: number = c.exists ? c.data()!.count : 0;
    if (n >= cap) throw new HttpsError("resource-exhausted", "Daily rewarded-ad cap reached.");
    tx.set(claimRef, { uid, count: n + 1 });
    tx.update(userRef, { credits: FieldValue.increment(rate) });
    ledger(tx, uid, rate, "rewarded_ad");
  });
  return { ok: true };
});

/** Scheduled: drop inactive testers, raise At risk, finish pools at day 16. */
export const dailySweep = onSchedule("every day 02:00", async () => {
  const now = Date.now();
  const pools = await db.collection("pools").where("state", "in", ["running", "at_risk"]).get();
  for (const doc of pools.docs) {
    const poolId = doc.id;
    const members = await db.collection("poolMembers").where("poolId", "==", poolId).get();
    await db.runTransaction(async (tx) => {
      const poolSnap = await tx.get(doc.ref);
      const p = poolSnap.data() as C.Pool;
      if (p.state !== "running" && p.state !== "at_risk") return;
      const live = await Promise.all(members.docs.map((m) => tx.get(m.ref)));
      let active = 0;
      for (const m of live) if (L.isActiveStatus(m.data()!.status)) active++;

      if (L.hasEnded(p.startedAt!, now)) {
        const result = L.finalState(active);
        for (const m of live) {
          const d = m.data() as C.Member & { uid: string };
          if (!L.isActiveStatus(d.status)) continue;
          const reward = result === "complete" && L.earnsReward(d);
          tx.update(m.ref, { status: "completed", rewarded: reward });
          tx.update(db.collection("users").doc(d.uid), {
            activeTesterPools: FieldValue.increment(-1), ...(reward ? { credits: FieldValue.increment(C.COMPLETION_REWARD) } : {}),
          });
          if (reward) ledger(tx, d.uid, C.COMPLETION_REWARD, "test_completed", poolId);
        }
        tx.update(doc.ref, { state: result, activeCount: active, finishedAt: now });
        const owner = db.collection("users").doc(p.ownerUid);
        tx.update(owner, { activeDevPools: FieldValue.increment(-1), ...(result === "failed" ? { credits: FieldValue.increment(C.POOL_COST) } : {}) });
        if (result === "failed") ledger(tx, p.ownerUid, C.POOL_COST, "pool_failed_refund", poolId);
        return;
      }
      for (const m of live) {
        if (!L.shouldDrop(m.data() as C.Member, p.startedAt!, now)) continue;
        tx.update(m.ref, { status: "dropped", reason: "missed_checkins", droppedAt: now });
        tx.update(db.collection("users").doc(m.data()!.uid), { activeTesterPools: FieldValue.increment(-1), reputation: FieldValue.increment(-1) });
        active--;
      }
      tx.update(doc.ref, { activeCount: active, state: L.runningState(active) });
    });
  }
});

/** Worker for the Directory API queue. Retries up to 5 times; a failed op stays in the queue for inspection. */
export const processGroupQueue = onDocumentCreated("groupQueue/{id}", async (event) => {
  const snap = event.data;
  if (!snap) return;
  const { op, email } = snap.data();
  if (process.env.FUNCTIONS_EMULATOR === "true") {
    // Local development: there is no Workspace group, so record the op as done without calling Google.
    await snap.ref.update({ done: true, doneAt: Date.now(), skipped: "emulator" });
    return;
  }
  const client = directoryClient(ADMIN_USER.value());
  try {
    await client[op as "add" | "remove"](GROUP_EMAIL.value(), email);
    await snap.ref.update({ done: true, doneAt: Date.now() });
  } catch (e) {
    const attempts = (snap.data().attempts ?? 0) + 1;
    await snap.ref.update({ attempts, lastError: String(e) });
    if (attempts < 5) throw e; // let the platform retry
  }
});

/** Anyone can file a report; moderation happens in the console. */
export const fileReport = onCall(async (req) => {
  const uid = uidOf(req);
  await db.collection("reports").add({
    reporterUid: uid, targetType: str(req.data.targetType, "targetType"), targetId: str(req.data.targetId, "targetId"),
    reason: str(req.data.reason, "reason").slice(0, 1000), status: "open", createdAt: Date.now(),
  });
  return { ok: true };
});
