import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { parseISODate, toISODate } from '../lib/format';
import { colors } from '../lib/theme';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

type Props = { value: string; onChange: (iso: string) => void; minDate: string; maxDate: string };

export function Calendar({ value, onChange, minDate, maxDate }: Props) {
  const [month, setMonth] = useState(() => {
    const d = parseISODate(value);
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  const min = parseISODate(minDate);
  const max = parseISODate(maxDate);
  const canPrev = month > new Date(min.getFullYear(), min.getMonth(), 1);
  const canNext = new Date(month.getFullYear(), month.getMonth() + 1, 1) <= max;

  const daysInMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const cells: (string | null)[] = [
    ...Array<null>(month.getDay()).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => toISODate(new Date(month.getFullYear(), month.getMonth(), i + 1))),
  ];
  while (cells.length % 7) cells.push(null);

  const shift = (by: number) => setMonth((m) => new Date(m.getFullYear(), m.getMonth() + by, 1));

  return (
    <View>
      <View style={styles.header}>
        <Pressable onPress={() => shift(-1)} disabled={!canPrev} hitSlop={10} accessibilityLabel="Previous month">
          <Ionicons name="chevron-back" size={20} color={canPrev ? colors.text : colors.border} />
        </Pressable>
        <Text style={styles.month}>{month.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}</Text>
        <Pressable onPress={() => shift(1)} disabled={!canNext} hitSlop={10} accessibilityLabel="Next month">
          <Ionicons name="chevron-forward" size={20} color={canNext ? colors.text : colors.border} />
        </Pressable>
      </View>
      <View style={styles.row}>
        {WEEKDAYS.map((d) => (
          <Text key={d} style={styles.weekday}>
            {d}
          </Text>
        ))}
      </View>
      {Array.from({ length: cells.length / 7 }, (_, r) => (
        <View key={r} style={styles.row}>
          {cells.slice(r * 7, r * 7 + 7).map((iso, i) => {
            if (!iso) return <View key={i} style={styles.cell} />;
            const disabled = iso < minDate || iso > maxDate;
            const selected = iso === value;
            return (
              <Pressable
                key={iso}
                style={styles.cell}
                disabled={disabled}
                onPress={() => onChange(iso)}
                accessibilityLabel={iso}
                accessibilityState={{ selected, disabled }}
              >
                <View style={[styles.day, selected && styles.daySelected]}>
                  <Text style={[styles.dayText, disabled && styles.dayDisabled, selected && styles.daySelectedText]}>
                    {parseISODate(iso).getDate()}
                  </Text>
                </View>
              </Pressable>
            );
          })}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 4, marginBottom: 12 },
  month: { fontSize: 16, fontWeight: '700', color: colors.text },
  row: { flexDirection: 'row' },
  weekday: { flex: 1, textAlign: 'center', fontSize: 12, color: colors.muted, marginBottom: 6 },
  cell: { flex: 1, alignItems: 'center', paddingVertical: 3 },
  day: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
  daySelected: { backgroundColor: colors.primary },
  dayText: { fontSize: 15, color: colors.text, fontWeight: '500' },
  dayDisabled: { color: '#C3CAC6' },
  daySelectedText: { color: '#fff', fontWeight: '700' },
});
