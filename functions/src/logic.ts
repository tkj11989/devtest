import * as C from "./constants";

const DAY = 86_400_000;

export const checklistComplete = (c?: Partial<C.Checklist>) => !!(c && c.groupAdded && c.buildReleased && c.linkPasted);

/** Day number of a running pool: day 1 is the day it started. */
export const dayNumber = (startedAt: number, now: number) => Math.floor((now - startedAt) / DAY) + 1;

export const isActiveStatus = (s: C.MemberStatus) => s === "joined" || s === "installed" || s === "active";

export type JoinError =
  | "user_blocked" | "tester_slots_full" | "own_app" | "same_app" | "already_member"
  | "pool_closed" | "pool_full" | "too_late";

export function checkJoin(a: {
  user: C.UserDoc; uid: string; pool: C.Pool; now: number;
  alreadyMember: boolean; sameAppMembership: boolean;
}): JoinError | null {
  const { user, pool, now } = a;
  if (user.status === "banned" || (user.status === "cooldown" && (user.cooldownUntil ?? 0) > now)) return "user_blocked";
  if (a.uid === pool.ownerUid) return "own_app";
  if (a.alreadyMember) return "already_member";
  if (a.sameAppMembership) return "same_app";
  if (user.activeTesterPools >= C.MAX_ACTIVE_POOLS) return "tester_slots_full";
  if (pool.testerCount >= C.MIN_TESTERS) return "pool_full";
  if (pool.state === "filling") return null;
  // Replacements for dropouts: only early in a running pool, so they can still stay opted in long enough.
  if ((pool.state === "running" || pool.state === "at_risk") && pool.startedAt !== undefined) {
    return dayNumber(pool.startedAt, now) <= C.LATE_JOIN_MAX_DAY ? null : "too_late";
  }
  return "pool_closed";
}

/** Filling -> Running when full and the developer's setup is confirmed. */
export const shouldStart = (p: C.Pool, checklist?: Partial<C.Checklist>) =>
  p.state === "filling" && p.testerCount >= C.MIN_TESTERS && checklistComplete(checklist);

/** Pool state for a running pool given the current number of active testers. */
export function runningState(activeCount: number): "running" | "at_risk" {
  return activeCount < C.AT_RISK_BELOW ? "at_risk" : "running";
}

/** Day-16 decision: Complete if at least 12 testers stayed active, else Failed. */
export const finalState = (activeCount: number): "complete" | "failed" =>
  activeCount >= C.GOOGLE_MIN_TESTERS ? "complete" : "failed";

export const hasEnded = (startedAt: number, now: number) => dayNumber(startedAt, now) > C.DURATION_DAYS;

/** True if the tester has missed too many days in a row and should be dropped. */
export function shouldDrop(m: C.Member, startedAt: number, now: number): boolean {
  if (!isActiveStatus(m.status)) return false;
  const last = m.lastCheckIn ?? Math.max(m.joinedAt, startedAt);
  return Math.floor((now - last) / DAY) >= C.MAX_MISSED_DAYS;
}

/** Does a member earn the completion credit? */
export const earnsReward = (m: C.Member) =>
  isActiveStatus(m.status) && m.checkInCount >= C.MIN_CHECKINS_TO_EARN && !!m.feedback8 && !!m.feedback16;

/** UTC calendar day key used to make check-ins idempotent per day. */
export const dayKey = (now: number) => new Date(now).toISOString().slice(0, 10);
