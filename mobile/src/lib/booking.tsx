import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import type { Slot, Space, Sport } from './api';

// The selections made while walking through the booking flow.
export type Draft = { sport?: Sport; space?: Space; date?: string; slot?: Slot };

type DraftState = { draft: Draft; update: (patch: Partial<Draft>) => void; reset: () => void };

const DraftContext = createContext<DraftState | null>(null);

export function BookingDraftProvider({ children }: { children: ReactNode }) {
  const [draft, setDraft] = useState<Draft>({});
  const value = useMemo(
    () => ({
      draft,
      update: (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch })),
      reset: () => setDraft({}),
    }),
    [draft],
  );
  return <DraftContext.Provider value={value}>{children}</DraftContext.Provider>;
}

export function useBookingDraft() {
  const ctx = useContext(DraftContext);
  if (!ctx) throw new Error('useBookingDraft must be used inside BookingDraftProvider');
  return ctx;
}
