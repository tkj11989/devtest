import { Redirect, router } from 'expo-router';
import { useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Button, Card, ErrorBanner, Row } from '../components/ui';
import { api, ApiError, type Booking, type Order, type PaymentMethod } from '../lib/api';
import { useBookingDraft } from '../lib/booking';
import { prettyDate, rupees } from '../lib/format';
import { colors, radius } from '../lib/theme';

const METHODS: { id: PaymentMethod; title: string; subtitle: string; icon: string }[] = [
  { id: 'ONLINE', title: 'Pay Online', subtitle: 'UPI, Card, Net Banking — instant confirmation', icon: '💳' },
  { id: 'OFFLINE', title: 'Pay at Venue', subtitle: 'Cash / UPI at the counter before you play', icon: '🏟️' },
];

export default function Payment() {
  const { draft } = useBookingDraft();
  const [method, setMethod] = useState<PaymentMethod>('ONLINE');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { sport, space, date, slot } = draft;

  if (!sport || !space || !date || !slot) return <Redirect href="/" />;

  async function confirm() {
    setLoading(true);
    setError(null);
    try {
      const res = await api<{ booking: Booking; order?: Order }>('/bookings', {
        body: { spaceId: space!.id, date, startHour: slot!.startHour, paymentMethod: method },
      });
      if (res.order) {
        router.push({
          pathname: '/checkout',
          params: { bookingId: res.booking.id, orderId: res.order.orderId, amount: res.order.amount, holdExpiresAt: res.booking.holdExpiresAt ?? '' },
        });
      } else {
        router.dismissAll();
        router.push({ pathname: '/confirmation', params: { bookingId: res.booking.id } });
      }
    } catch (e) {
      if (e instanceof ApiError && e.code === 'SLOT_UNAVAILABLE') {
        Alert.alert('Slot just got booked', e.message, [{ text: 'Pick another slot', onPress: () => router.back() }]);
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <View style={{ flex: 1 }}>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 16 }}>
        <Card>
          <Text style={styles.cardTitle}>Booking summary</Text>
          <Row label="Sport" value={`${sport.icon} ${sport.name}`} />
          <Row label="Venue" value={space.name} />
          <Row label="Location" value={space.location} />
          <Row label="Date" value={prettyDate(date)} />
          <Row label="Slot" value={slot.label} />
          <View style={styles.divider} />
          <View style={styles.totalRow}>
            <Text style={styles.totalLabel}>Total</Text>
            <Text style={styles.total}>{rupees(slot.price)}</Text>
          </View>
        </Card>

        <Text style={styles.section}>Payment method</Text>
        {METHODS.map((m) => {
          const active = m.id === method;
          return (
            <Pressable
              key={m.id}
              accessibilityRole="radio"
              accessibilityState={{ checked: active }}
              onPress={() => setMethod(m.id)}
              style={[styles.method, active && styles.methodActive]}
            >
              <Text style={{ fontSize: 26 }}>{m.icon}</Text>
              <View style={{ flex: 1 }}>
                <Text style={styles.methodTitle}>{m.title}</Text>
                <Text style={styles.methodSub}>{m.subtitle}</Text>
              </View>
              <View style={[styles.radio, active && styles.radioActive]}>{active && <View style={styles.radioDot} />}</View>
            </Pressable>
          );
        })}
        {method === 'OFFLINE' && (
          <Text style={styles.note}>Your slot is confirmed right away. Please pay {rupees(slot.price)} at the venue before your game.</Text>
        )}
        <ErrorBanner message={error} />
      </ScrollView>
      <View style={styles.footer}>
        <Button title={method === 'ONLINE' ? `Pay ${rupees(slot.price)}` : 'Confirm Booking'} onPress={confirm} loading={loading} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  cardTitle: { fontSize: 16, fontWeight: '800', color: colors.text, marginBottom: 8 },
  divider: { height: 1, backgroundColor: colors.border, marginVertical: 10 },
  totalRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  totalLabel: { fontSize: 16, fontWeight: '700', color: colors.text },
  total: { fontSize: 22, fontWeight: '800', color: colors.primary },
  section: { fontSize: 16, fontWeight: '700', color: colors.text },
  method: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 16,
    borderRadius: radius,
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  methodActive: { borderColor: colors.primary, backgroundColor: colors.primarySoft },
  methodTitle: { fontSize: 16, fontWeight: '700', color: colors.text },
  methodSub: { color: colors.muted, fontSize: 13, marginTop: 2 },
  radio: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: colors.border, alignItems: 'center', justifyContent: 'center' },
  radioActive: { borderColor: colors.primary },
  radioDot: { width: 11, height: 11, borderRadius: 6, backgroundColor: colors.primary },
  note: { color: colors.warning, backgroundColor: colors.warningSoft, padding: 12, borderRadius: 10 },
  footer: { padding: 16, backgroundColor: colors.card, borderTopWidth: 1, borderColor: colors.border },
});
