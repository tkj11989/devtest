import type { LedgerEntry } from './api';

// How each ledger line reads from the owner's point of view.
export const LEDGER_LABEL: Record<LedgerEntry['type'], string> = {
  OWNER_PAYOUT: 'Online payment credited',
  PLATFORM_SUBSIDY: 'Coupon top-up from Sports Space',
  PLATFORM_FEE: 'Platform fee',
  VENUE_COLLECTION: 'Collected at venue',
  FEE_DUE: 'Platform fee due',
  DUES_SETTLED: 'Platform fee paid',
};
