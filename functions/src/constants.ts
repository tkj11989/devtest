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
export const MIN_TEST_SECONDS = 30; // a daily test only counts after the tester used the app this long
export const MAX_TEST_SESSION_MINUTES = 120; // sessions older than this are abandoned
export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;
// Once a pool has its 18 testers, they get this long to download the app before day 1 (config/limits.installBufferHours).
export const INSTALL_BUFFER_HOURS = 24;

// filling -> installing (buffer timer) -> running/at_risk -> complete/failed
export type PoolState = "filling" | "installing" | "running" | "at_risk" | "complete" | "failed" | "cancelled";
export type MemberStatus = "joined" | "installed" | "active" | "dropped" | "completed";

// No opt-in link step: the developer only confirms the group and the closed-track build.
export interface Checklist { groupAdded: boolean; buildReleased: boolean }
export interface Pool {
  state: PoolState; appId: string; ownerUid: string;
  testerCount: number; activeCount: number; startedAt?: number; // epoch ms
  installedCount?: number; installDeadline?: number;
}
export interface UserDoc { credits: number; activeTesterPools: number; activeDevPools: number; status: "ok" | "banned" | "cooldown"; cooldownUntil?: number; maxTesterPools?: number }
export interface Member { status: MemberStatus; lastCheckIn?: number; checkInCount: number; joinedAt: number; feedback8?: boolean; feedback16?: boolean }
