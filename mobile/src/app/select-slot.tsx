import { Redirect, router, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Calendar } from '../components/Calendar';
import { Button, Card, ErrorBanner } from '../components/ui';
import { api, type Slot } from '../lib/api';
import { useBookingDraft } from '../lib/booking';
import { addDays, errorMessage, hourLabel, rupees, toISODate } from '../lib/format';
import { colors } from '../lib/theme';

const MAX_DAYS_AHEAD = 30;

export default function SelectSlot() {
  const { draft, update } = useBookingDraft();
  const insets = useSafeAreaInsets();
  const today = useMemo(() => toISODate(new Date()), []);
  const [date, setDate] = useState(draft.date ?? today);
  const [selected, setSelected] = useState<number | null>(draft.slot?.startHour ?? null);
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ground = draft.ground;

  // Refetch on focus too, so slots taken while the user was away disappear.
  useFocusEffect(
    useCallback(() => {
      if (!ground) return;
      let active = true;
      setSlots(null);
      setError(null);
      api<{ slots: Slot[] }>(`/grounds/${ground.id}/slots?date=${date}`).then(
        (r) => {
          if (!active) return;
          setSlots(r.slots);
          setSelected((h) => (r.slots.some((s) => s.startHour === h && s.status === 'AVAILABLE') ? h : null));
        },
        (e) => active && setError(errorMessage(e)),
      );
      return () => {
        active = false;
      };
    }, [ground, date]),
  );

  if (!ground) return <Redirect href="/" />;
  const slot = slots?.find((s) => s.startHour === selected);
  const open = slots?.filter((s) => s.status === 'AVAILABLE') ?? [];
  const minPrice = slots?.length ? Math.min(...slots.map((s) => s.price)) : ground.pricePerHour;

  return (
    <View style={{ flex: 1 }}>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 16 }}>
        <Card>
          <Calendar value={date} onChange={setDate} minDate={today} maxDate={addDays(today, MAX_DAYS_AHEAD)} />
        </Card>

        <View style={styles.sectionRow}>
          <Text style={styles.section}>Available Slots</Text>
          <Text style={styles.per}>{rupees(minPrice)} per hour</Text>
        </View>

        <ErrorBanner message={error} />
        {!slots && !error && <ActivityIndicator color={colors.primary} />}
        {slots && open.length === 0 && <Text style={styles.none}>No slots left on this day. Please pick another date.</Text>}
        <View style={styles.grid}>
          {slots
            ?.filter((s) => s.status !== 'PAST')
            .map((s) => {
              const isSel = s.startHour === selected;
              const booked = s.status !== 'AVAILABLE';
              return (
                <Pressable
                  key={s.startHour}
                  disabled={booked}
                  onPress={() => setSelected(s.startHour)}
                  accessibilityLabel={`${s.label}${booked ? ', booked' : ''}`}
                  accessibilityState={{ selected: isSel, disabled: booked }}
                  style={[styles.slot, isSel && styles.slotSel, booked && styles.slotOff]}
                >
                  <Text style={[styles.slotTop, isSel && styles.white, booked && styles.offText]}>{hourLabel(s.startHour)}</Text>
                  <Text style={[styles.slotBottom, isSel && styles.white, booked && styles.offText]}>
                    {booked ? 'Booked' : hourLabel(s.startHour + 1)}
                  </Text>
                  {s.price !== minPrice && !booked && <Text style={[styles.slotPrice, isSel && styles.white]}>{rupees(s.price)}</Text>}
                </Pressable>
              );
            })}
        </View>
      </ScrollView>

      <View style={[styles.footer, { paddingBottom: 12 + insets.bottom }]}>
        <Button
          title={slot ? `Continue · ${rupees(slot.price)}` : 'Continue'}
          disabled={!slot}
          onPress={() => {
            update({ date, slot, quote: undefined });
            router.push('/summary');
          }}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  sectionRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  section: { fontSize: 16, fontWeight: '800', color: colors.text },
  per: { color: colors.muted, fontSize: 13 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  slot: {
    width: '31%',
    flexGrow: 1,
    maxWidth: '32.5%',
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: '#fff',
    alignItems: 'center',
  },
  slotSel: { backgroundColor: colors.primary, borderColor: colors.primary },
  slotOff: { backgroundColor: colors.disabled, borderColor: colors.disabled },
  slotTop: { fontWeight: '700', color: colors.text, fontSize: 13 },
  slotBottom: { color: colors.muted, fontSize: 12, marginTop: 2 },
  slotPrice: { color: colors.primary, fontSize: 11, fontWeight: '700', marginTop: 2 },
  white: { color: '#fff' },
  offText: { color: '#A9B2AD' },
  none: { color: colors.muted, textAlign: 'center' },
  footer: { paddingHorizontal: 16, paddingTop: 12, backgroundColor: '#fff', borderTopWidth: 1, borderColor: colors.border },
});
