// Values from the spec ("Mutual App Testing Platform – Product & Technical Spec").
export const MIN_TESTERS = 18; // pool size: 6 spare above Google's 12
export const DURATION_DAYS = 16; // 2 spare days above Google's 14
export const GOOGLE_MIN_TESTERS = 12;
export const AT_RISK_BELOW = 14;
export const MAX_ACTIVE_POOLS = 2; // per user, as tester and as developer
export const SIGNUP_CREDITS = 1;
export const COMPLETION_REWARD = 1;
export const POOL_COST = 1;
export const MAX_MISSED_DAYS = 3; // consecutive missed check-ins before a tester is dropped
export const MIN_CHECKINS_TO_EARN = 12; // "check-ins on most days"
export const LATE_JOIN_MAX_DAY = 2; // replacements may join a running pool until this day
export const FEEDBACK_DAYS = [8, 16] as const;

export type PoolState = "filling" | "running" | "at_risk" | "complete" | "failed" | "cancelled";
export type MemberStatus = "joined" | "installed" | "active" | "dropped" | "completed";

export interface Checklist { groupAdded: boolean; buildReleased: boolean; linkPasted: boolean }
export interface Pool {
  state: PoolState; appId: string; ownerUid: string;
  testerCount: number; activeCount: number; startedAt?: number; // epoch ms
}
export interface UserDoc { credits: number; activeTesterPools: number; activeDevPools: number; status: "ok" | "banned" | "cooldown"; cooldownUntil?: number }
export interface Member { status: MemberStatus; lastCheckIn?: number; checkInCount: number; joinedAt: number; feedback8?: boolean; feedback16?: boolean }
