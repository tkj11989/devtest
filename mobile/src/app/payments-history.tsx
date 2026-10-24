import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { Badge, Empty, ErrorBanner, Loading, type Tone } from '../components/ui';
import { api, type Booking } from '../lib/api';
import { errorMessage, rupees, shortDate } from '../lib/format';
import { colors, radius, shadow } from '../lib/theme';

const CHANNEL: Record<string, string> = { UPI: 'UPI', CARD: 'Card', NETBANKING: 'Net Banking', WALLET: 'Wallet', VENUE: 'At venue' };
const STATUS: Record<Booking['paymentStatus'], { label: string; tone: Tone }> = {
  PAID: { label: 'Paid', tone: 'green' },
  PAY_AT_VENUE: { label: 'Due at venue', tone: 'amber' },
  REFUND_INITIATED: { label: 'Refunded', tone: 'grey' },
  PENDING: { label: 'Pending', tone: 'amber' },
};

export default function PaymentsHistory() {
  const [items, setItems] = useState<Booking[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      api<Booking[]>('/bookings').then(
        // Unpaid cancelled bookings never involved money.
        (b) => setItems(b.filter((x) => !(x.status === 'CANCELLED' && x.paymentStatus === 'PAY_AT_VENUE'))),
        (e) => setError(errorMessage(e)),
      );
    }, []),
  );

  if (!items && !error) return <Loading />;
  const spent = (items ?? []).filter((b) => b.paymentStatus === 'PAID').reduce((s, b) => s + b.total, 0);

  return (
    <FlatList
      data={items ?? []}
      keyExtractor={(b) => b.id}
      contentContainerStyle={{ padding: 16, gap: 10 }}
      ListHeaderComponent={
        <View style={{ marginBottom: 6 }}>
          <View style={styles.summary}>
            <Text style={{ color: '#D8EFE0' }}>Total paid online</Text>
            <Text style={styles.summaryAmount}>{rupees(spent)}</Text>
          </View>
          <ErrorBanner message={error} />
        </View>
      }
      ListEmptyComponent={<Empty icon="card-outline" title="No payments yet" />}
      renderItem={({ item }) => {
        const s = STATUS[item.paymentStatus];
        return (
          <Pressable style={styles.item} onPress={() => router.push({ pathname: '/ticket/[id]', params: { id: item.id } })}>
            <View style={{ flex: 1, gap: 3 }}>
              <Text style={styles.name}>{item.groundName}</Text>
              <Text style={styles.meta}>
                {item.code} · {shortDate(item.date)} · {CHANNEL[item.paymentChannel] ?? item.paymentChannel}
              </Text>
            </View>
            <View style={{ alignItems: 'flex-end', gap: 4 }}>
              <Text style={styles.amount}>{rupees(item.total)}</Text>
              <Badge label={s.label} tone={s.tone} />
            </View>
          </Pressable>
        );
      }}
    />
  );
}

const styles = StyleSheet.create({
  summary: { backgroundColor: colors.primary, borderRadius: radius, padding: 18, marginBottom: 6 },
  summaryAmount: { color: '#fff', fontSize: 28, fontWeight: '800', marginTop: 4 },
  item: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: '#fff', padding: 14, borderRadius: radius, ...shadow },
  name: { fontWeight: '700', color: colors.text },
  meta: { color: colors.muted, fontSize: 12 },
  amount: { fontWeight: '800', color: colors.text, fontSize: 15 },
});
