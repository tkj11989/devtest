import test from "node:test";
import assert from "node:assert/strict";
import * as L from "../src/logic";
import * as C from "../src/constants";

const DAY = 86_400_000;
const user: C.UserDoc = { credits: 1, activeTesterPools: 0, activeDevPools: 0, status: "ok" };
const pool: C.Pool = { state: "filling", appId: "a", ownerUid: "dev", testerCount: 5, activeCount: 5 };
const base = { user, uid: "t1", pool, now: 0, alreadyMember: false, sameAppMembership: false };

test("join allowed in a filling pool", () => assert.equal(L.checkJoin(base), null));
test("owner cannot join own app", () => assert.equal(L.checkJoin({ ...base, uid: "dev" }), "own_app"));
test("same app twice is rejected", () => assert.equal(L.checkJoin({ ...base, sameAppMembership: true }), "same_app"));
test("2-pool cap", () => assert.equal(L.checkJoin({ ...base, user: { ...user, activeTesterPools: 2 } }), "tester_slots_full"));
test("full pool", () => assert.equal(L.checkJoin({ ...base, pool: { ...pool, testerCount: 18 } }), "pool_full"));
test("banned user blocked", () => assert.equal(L.checkJoin({ ...base, user: { ...user, status: "banned" } }), "user_blocked"));
test("cooldown expires", () => {
  const u: C.UserDoc = { ...user, status: "cooldown", cooldownUntil: 100 };
  assert.equal(L.checkJoin({ ...base, user: u, now: 50 }), "user_blocked");
  assert.equal(L.checkJoin({ ...base, user: u, now: 150 }), null);
});
test("replacements only early in a running pool", () => {
  const p: C.Pool = { ...pool, state: "at_risk", testerCount: 15, startedAt: 0 };
  assert.equal(L.checkJoin({ ...base, pool: p, now: DAY }), null);
  assert.equal(L.checkJoin({ ...base, pool: p, now: 5 * DAY }), "too_late");
});
test("complete pool is closed", () => assert.equal(L.checkJoin({ ...base, pool: { ...pool, state: "complete" } }), "pool_closed"));

test("start needs 18 testers and full checklist", () => {
  const full = { ...pool, testerCount: 18 };
  const ok = { groupAdded: true, buildReleased: true, linkPasted: true };
  assert.equal(L.shouldStart(full, ok), true);
  assert.equal(L.shouldStart(full, { ...ok, linkPasted: false }), false);
  assert.equal(L.shouldStart({ ...full, testerCount: 17 }, ok), false);
});
test("at-risk threshold is 14", () => {
  assert.equal(L.runningState(14), "running");
  assert.equal(L.runningState(13), "at_risk");
});
test("day-16 decision uses Google's 12", () => {
  assert.equal(L.finalState(12), "complete");
  assert.equal(L.finalState(11), "failed");
});
test("day numbering and end", () => {
  assert.equal(L.dayNumber(0, 0), 1);
  assert.equal(L.hasEnded(0, 15 * DAY + 1), false);
  assert.equal(L.hasEnded(0, 16 * DAY), true);
});
test("drop after 3 missed days", () => {
  const m: C.Member = { status: "active", checkInCount: 4, joinedAt: 0, lastCheckIn: 0 };
  assert.equal(L.shouldDrop(m, 0, 2 * DAY), false);
  assert.equal(L.shouldDrop(m, 0, 3 * DAY), true);
  assert.equal(L.shouldDrop({ ...m, status: "dropped" }, 0, 9 * DAY), false);
});
test("per-user package limit overrides the platform default", () => {
  assert.equal(L.testerPoolLimit(user), 2);
  assert.equal(L.testerPoolLimit(user, 3), 3);
  assert.equal(L.testerPoolLimit({ ...user, maxTesterPools: 5 }, 3), 5);
  assert.equal(L.testerPoolLimit({ ...user, maxTesterPools: 0 }), 0);
  const u = { ...user, activeTesterPools: 2, maxTesterPools: 4 };
  assert.equal(L.checkJoin({ ...base, user: u }), null);
  assert.equal(L.checkJoin({ ...base, user: { ...u, activeTesterPools: 4 } }), "tester_slots_full");
  assert.equal(L.checkJoin({ ...base, user: { ...user, activeTesterPools: 2 }, platformLimit: 3 }), null);
});
test("tester days roll every 24 h from the tester's own start", () => {
  const start = L.testerDayStart(5 * DAY + 3600_000, 2 * DAY); // late joiner: own start wins
  assert.equal(start, 5 * DAY + 3600_000);
  assert.equal(L.testerDay(start, start), 1);
  assert.equal(L.testerDay(start, start + DAY - 1), 1);
  assert.equal(L.testerDay(start, start + DAY), 2);
  assert.equal(L.nextDayAt(start, start + 10), start + DAY);
  assert.equal(L.testerDayStart(0, 2 * DAY), 2 * DAY); // joined while filling: pool start wins
});
test("a test counts only after 30 s, within its own day", () => {
  const s = { startedAt: 1000, day: 1, dayStart: 0 };
  assert.equal(L.checkSession({ ...s, now: 1000 + 29_999 }), "too_short");
  assert.equal(L.checkSession({ ...s, now: 1000 + 30_000 }), null);
  assert.equal(L.checkSession({ ...s, now: 1000 + 3 * 3600_000 }), "expired");
  assert.equal(L.checkSession({ startedAt: DAY - 10_000, day: 1, dayStart: 0, now: DAY + 25_000 }), "wrong_day");
});
test("reward needs check-ins and both feedbacks", () => {
  const m: C.Member = { status: "active", checkInCount: 12, joinedAt: 0, feedback8: true, feedback16: true };
  assert.equal(L.earnsReward(m), true);
  assert.equal(L.earnsReward({ ...m, feedback16: false }), false);
  assert.equal(L.earnsReward({ ...m, checkInCount: 11 }), false);
});
