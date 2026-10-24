import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert, FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { Button, Card, ErrorBanner, Loading } from '../components/ui';
import { api, type Booking } from '../lib/api';
import { prettyDate, rupees, toISODate } from '../lib/format';
import { colors } from '../lib/theme';

const STATUS: Record<Booking['status'], { label: string; color: string; bg: string }> = {
  CONFIRMED: { label: 'Confirmed', color: colors.primary, bg: colors.primarySoft },
  PENDING_PAYMENT: { label: 'Awaiting payment', color: colors.warning, bg: colors.warningSoft },
  CANCELLED: { label: 'Cancelled', color: colors.danger, bg: colors.dangerSoft },
  FAILED: { label: 'Failed', color: colors.danger, bg: colors.dangerSoft },
};

function isUpcoming(b: Booking) {
  const now = new Date();
  const today = toISODate(now);
  return b.date > today || (b.date === today && b.startHour > now.getHours());
}

export default function MyBookings() {
  const [bookings, setBookings] = useState<Booking[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      setBookings(await api<Booking[]>('/bookings'));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  function cancel(b: Booking) {
    Alert.alert('Cancel booking?', `${b.spaceName}\n${prettyDate(b.date)}, ${b.slotLabel}`, [
      { text: 'Keep it', style: 'cancel' },
      {
        text: 'Cancel booking',
        style: 'destructive',
        onPress: async () => {
          try {
            await api(`/bookings/${b.id}/cancel`, { body: {} });
            load();
          } catch (e) {
            Alert.alert('Could not cancel', e instanceof Error ? e.message : String(e));
          }
        },
      },
    ]);
  }

  if (!bookings && !error) return <Loading />;

  return (
    <FlatList
      data={bookings ?? []}
      keyExtractor={(b) => b.id}
      contentContainerStyle={{ padding: 16, gap: 12 }}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={async () => {
            setRefreshing(true);
            await load();
            setRefreshing(false);
          }}
        />
      }
      ListHeaderComponent={<ErrorBanner message={error} />}
      ListEmptyComponent={<Text style={styles.empty}>No bookings yet. Go grab a slot! 🏏</Text>}
      renderItem={({ item }) => {
        const s = STATUS[item.status];
        const canCancel = item.status === 'CONFIRMED' && isUpcoming(item);
        return (
          <Card style={{ gap: 4 }}>
            <View style={styles.top}>
              <Text style={styles.name}>{item.spaceName}</Text>
              <Text style={[styles.pill, { color: s.color, backgroundColor: s.bg }]}>{s.label}</Text>
            </View>
            <Text style={styles.meta}>
              {item.sportName} · 📍 {item.location}
            </Text>
            <Text style={styles.when}>
              {prettyDate(item.date)} · {item.slotLabel}
            </Text>
            <Text style={styles.meta}>
              {item.code} · {rupees(item.amount)} ·{' '}
              {item.paymentStatus === 'PAID' ? 'Paid online' : item.paymentStatus === 'PAY_AT_VENUE' ? 'Pay at venue' : 'Unpaid'}
            </Text>
            {canCancel && <Button title="Cancel booking" variant="danger" onPress={() => cancel(item)} style={{ marginTop: 10, minHeight: 42, paddingVertical: 10 }} />}
          </Card>
        );
      }}
    />
  );
}

const styles = StyleSheet.create({
  top: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  name: { fontSize: 16, fontWeight: '700', color: colors.text, flex: 1 },
  pill: { fontSize: 12, fontWeight: '700', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12, overflow: 'hidden' },
  meta: { color: colors.muted, fontSize: 13 },
  when: { color: colors.text, fontWeight: '600', marginTop: 2 },
  empty: { textAlign: 'center', color: colors.muted, marginTop: 60, fontSize: 15 },
});
