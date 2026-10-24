import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { Button, Card, ErrorBanner, Loading, Row } from '../components/ui';
import { api, type Booking } from '../lib/api';
import { maskPhone, prettyDate, rupees } from '../lib/format';
import { colors } from '../lib/theme';

export default function Confirmation() {
  const { bookingId } = useLocalSearchParams<{ bookingId: string }>();
  const [booking, setBooking] = useState<Booking | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<Booking>(`/bookings/${bookingId}`).then(setBooking, (e) => setError(e.message));
  }, [bookingId]);

  if (error) {
    return (
      <View style={{ padding: 16 }}>
        <ErrorBanner message={error} />
        <Button title="Go to My Bookings" onPress={() => router.replace('/bookings')} />
      </View>
    );
  }
  if (!booking) return <Loading />;

  const paid = booking.paymentStatus === 'PAID';
  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 16 }}>
      <View style={styles.hero}>
        <View style={styles.check}>
          <Text style={styles.checkMark}>✓</Text>
        </View>
        <Text style={styles.title}>Booking Confirmed!</Text>
        <Text style={styles.code}>Booking ID: {booking.code}</Text>
      </View>

      {/* Intimation: the backend texts the booking details to the user. */}
      <View style={[styles.sms, booking.smsStatus === 'FAILED' && styles.smsFailed]}>
        <Text style={{ fontSize: 22 }}>💬</Text>
        <Text style={styles.smsText}>
          {booking.smsStatus === 'FAILED'
            ? "We couldn't send the confirmation SMS. Your booking is still confirmed — keep this Booking ID handy."
            : `Booking details have been sent by SMS to ${maskPhone(booking.phone)}.`}
        </Text>
      </View>

      <Card>
        <Row label="Sport" value={booking.sportName} />
        <Row label="Venue" value={booking.spaceName} />
        <Row label="Location" value={booking.location} />
        <Row label="Date" value={prettyDate(booking.date)} />
        <Row label="Slot" value={booking.slotLabel} />
        <Row label="Amount" value={rupees(booking.amount)} />
        <Row label="Payment" value={paid ? 'Paid online ✅' : 'Pay at venue'} />
      </Card>

      {!paid && (
        <Text style={styles.note}>Please pay {rupees(booking.amount)} at the venue counter before your slot starts.</Text>
      )}

      <Button title="View My Bookings" onPress={() => router.replace('/bookings')} />
      <Button title="Book Another Slot" variant="outline" onPress={() => router.dismissAll()} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  hero: { alignItems: 'center', paddingVertical: 12 },
  check: { width: 80, height: 80, borderRadius: 40, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' },
  checkMark: { color: '#fff', fontSize: 44, fontWeight: '800' },
  title: { fontSize: 24, fontWeight: '800', color: colors.text, marginTop: 14 },
  code: { color: colors.muted, marginTop: 4, fontWeight: '600', letterSpacing: 0.5 },
  sms: { flexDirection: 'row', gap: 12, alignItems: 'center', backgroundColor: colors.primarySoft, padding: 14, borderRadius: 12 },
  smsFailed: { backgroundColor: colors.warningSoft },
  smsText: { flex: 1, color: colors.text },
  note: { color: colors.warning, backgroundColor: colors.warningSoft, padding: 12, borderRadius: 10 },
});
