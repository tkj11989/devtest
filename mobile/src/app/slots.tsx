import { Redirect, router, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button, ErrorBanner } from '../components/ui';
import { api, type Slot } from '../lib/api';
import { useBookingDraft } from '../lib/booking';
import { prettyDate, rupees, upcomingDates } from '../lib/format';
import { colors, radius } from '../lib/theme';

const DAYS_SHOWN = 14;

export default function DateAndSlotSelect() {
  const { draft, update } = useBookingDraft();
  const insets = useSafeAreaInsets();
  const dates = useMemo(() => upcomingDates(DAYS_SHOWN), []);
  const [date, setDate] = useState(draft.date ?? dates[0].iso);
  const [selected, setSelected] = useState<number | null>(draft.slot?.startHour ?? null);
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const space = draft.space;

  // Refetch on focus too, so slots taken while the user was away disappear.
  useFocusEffect(
    useCallback(() => {
      if (!space) return;
      let active = true;
      setSlots(null);
      setError(null);
      api<{ slots: Slot[] }>(`/spaces/${space.id}/slots?date=${date}`).then(
        (r) => {
          if (!active) return;
          setSlots(r.slots);
          setSelected((h) => (r.slots.some((s) => s.startHour === h && s.status === 'AVAILABLE') ? h : null));
        },
        (e) => active && setError(e.message),
      );
      return () => {
        active = false;
      };
    }, [space, date]),
  );

  if (!space) return <Redirect href="/" />;
  const slot = slots?.find((s) => s.startHour === selected);
  const available = slots?.filter((s) => s.status === 'AVAILABLE').length ?? 0;

  return (
    <View style={{ flex: 1 }}>
      <ScrollView contentContainerStyle={{ paddingBottom: 24 }}>
        <View style={styles.venue}>
          <Text style={styles.venueName}>{space.name}</Text>
          <Text style={styles.venueMeta}>📍 {space.location}</Text>
        </View>

        <Text style={styles.section}>Select date</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 16, gap: 10 }}>
          {dates.map((d) => {
            const active = d.iso === date;
            return (
              <Pressable key={d.iso} onPress={() => setDate(d.iso)} style={[styles.date, active && styles.dateActive]}>
                <Text style={[styles.dateWeek, active && styles.white]}>{d.weekday}</Text>
                <Text style={[styles.dateDay, active && styles.white]}>{d.day}</Text>
                <Text style={[styles.dateMonth, active && styles.white]}>{d.month}</Text>
              </Pressable>
            );
          })}
        </ScrollView>

        <View style={styles.sectionRow}>
          <Text style={styles.section}>Select slot</Text>
          {slots && <Text style={styles.availability}>{available} available</Text>}
        </View>
        <View style={styles.legend}>
          <Legend color={colors.card} border={colors.border} label="Available" />
          <Legend color={colors.primary} label="Selected" />
          <Legend color={colors.disabled} label="Booked / Past" />
        </View>

        <View style={{ paddingHorizontal: 16 }}>
          <ErrorBanner message={error} />
          {!slots && !error && <ActivityIndicator color={colors.primary} style={{ marginTop: 24 }} />}
          {slots && available === 0 && <Text style={styles.none}>No slots left on {prettyDate(date)}. Try another date.</Text>}
          <View style={styles.grid}>
            {slots?.map((s) => {
              const isSel = s.startHour === selected;
              const off = s.status !== 'AVAILABLE';
              return (
                <Pressable
                  key={s.startHour}
                  disabled={off}
                  onPress={() => setSelected(s.startHour)}
                  style={[styles.slot, isSel && styles.slotSel, off && styles.slotOff]}
                >
                  <Text style={[styles.slotText, isSel && styles.white, off && styles.slotTextOff]}>{s.label}</Text>
                  {s.status === 'BOOKED' && <Text style={styles.slotTag}>Booked</Text>}
                </Pressable>
              );
            })}
          </View>
        </View>
      </ScrollView>

      <View style={[styles.footer, { paddingBottom: 12 + insets.bottom }]}>
        <View style={{ flex: 1 }}>
          <Text style={styles.footerLabel}>{slot ? `${prettyDate(date)} · ${slot.label}` : 'No slot selected'}</Text>
          <Text style={styles.footerPrice}>{slot ? rupees(slot.price) : '—'}</Text>
        </View>
        <Button
          title="Proceed"
          disabled={!slot}
          style={{ paddingHorizontal: 28 }}
          onPress={() => {
            update({ date, slot });
            router.push('/payment');
          }}
        />
      </View>
    </View>
  );
}

function Legend({ color, border, label }: { color: string; border?: string; label: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
      <View style={{ width: 14, height: 14, borderRadius: 4, backgroundColor: color, borderWidth: border ? 1 : 0, borderColor: border }} />
      <Text style={{ color: colors.muted, fontSize: 12 }}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  venue: { padding: 16, backgroundColor: colors.card, borderBottomWidth: 1, borderColor: colors.border },
  venueName: { fontSize: 18, fontWeight: '800', color: colors.text },
  venueMeta: { color: colors.muted, marginTop: 4 },
  section: { fontSize: 16, fontWeight: '700', color: colors.text, marginHorizontal: 16, marginTop: 20, marginBottom: 10 },
  sectionRow: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', paddingRight: 16 },
  availability: { color: colors.primary, fontWeight: '600' },
  date: {
    width: 62,
    paddingVertical: 10,
    borderRadius: 12,
    alignItems: 'center',
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
  },
  dateActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  dateWeek: { fontSize: 12, color: colors.muted, fontWeight: '600' },
  dateDay: { fontSize: 20, fontWeight: '800', color: colors.text, marginVertical: 2 },
  dateMonth: { fontSize: 12, color: colors.muted },
  white: { color: '#fff' },
  legend: { flexDirection: 'row', gap: 16, marginHorizontal: 16, marginBottom: 12 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  slot: {
    width: '48%',
    flexGrow: 1,
    paddingVertical: 14,
    borderRadius: radius,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    alignItems: 'center',
  },
  slotSel: { backgroundColor: colors.primary, borderColor: colors.primary },
  slotOff: { backgroundColor: colors.disabled, borderColor: colors.disabled },
  slotText: { fontWeight: '600', color: colors.text, fontSize: 14 },
  slotTextOff: { color: '#A5B0AA', textDecorationLine: 'line-through' },
  slotTag: { fontSize: 11, color: colors.danger, marginTop: 2 },
  none: { color: colors.muted, textAlign: 'center', marginVertical: 16 },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingTop: 12,
    backgroundColor: colors.card,
    borderTopWidth: 1,
    borderColor: colors.border,
  },
  footerLabel: { color: colors.muted, fontSize: 13 },
  footerPrice: { fontSize: 20, fontWeight: '800', color: colors.text },
});
