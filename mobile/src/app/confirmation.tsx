import { Ionicons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { GroundHeader } from '../components/GroundHeader';
import { Badge, Button, Card, ErrorBanner, Loading, Row } from '../components/ui';
import { api, type Booking } from '../lib/api';
import { errorMessage, maskPhone, prettyDate, rupees, slotRange } from '../lib/format';
import { shareBooking } from '../lib/share';
import { colors } from '../lib/theme';

const CONFETTI = [
  { top: 30, left: 30, c: '#F5C542', r: 20 },
  { top: 70, left: 80, c: '#7DDC9A', r: -30 },
  { top: 40, right: 50, c: '#F5C542', r: 45 },
  { top: 100, right: 30, c: '#FFFFFF', r: 10 },
  { top: 120, left: 40, c: '#FFFFFF', r: -15 },
  { top: 20, left: '55%', c: '#7DDC9A', r: 60 },
] as const;

export default function Confirmation() {
  const { bookingId } = useLocalSearchParams<{ bookingId: string }>();
  const insets = useSafeAreaInsets();
  const [booking, setBooking] = useState<Booking | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<Booking>(`/bookings/${bookingId}`).then(setBooking, (e) => setError(errorMessage(e)));
  }, [bookingId]);

  if (error) {
    return (
      <View style={{ padding: 16, paddingTop: insets.top + 16 }}>
        <ErrorBanner message={error} />
        <Button title="Go to My Bookings" onPress={() => router.navigate('/bookings')} />
      </View>
    );
  }
  if (!booking) return <Loading />;

  const paid = booking.paymentStatus === 'PAID';
  return (
    <ScrollView style={{ backgroundColor: colors.bg }} contentContainerStyle={{ paddingBottom: 24 + insets.bottom }}>
      <View style={[styles.hero, { paddingTop: insets.top + 36 }]}>
        {CONFETTI.map((c, i) => (
          <View key={i} style={[styles.confetti, { top: c.top, left: 'left' in c ? c.left : undefined, right: 'right' in c ? c.right : undefined, backgroundColor: c.c, transform: [{ rotate: `${c.r}deg` }] }]} />
        ))}
        <View style={styles.check}>
          <Ionicons name="checkmark" size={44} color={colors.primary} />
        </View>
        <Text style={styles.title}>Booking Confirmed!</Text>
        <Text style={styles.subtitle}>Your ground has been successfully booked.</Text>
      </View>

      <View style={{ paddingHorizontal: 16, marginTop: -36, gap: 14 }}>
        <Card>
          <GroundHeader
            id={booking.groundId}
            sportId={booking.sportId}
            indoor={booking.groundType === 'Indoor'}
            name={booking.groundName}
            location={`${booking.area}, ${booking.cityName}`}
            size={56}
          />
          <View style={styles.divider} />
          <Row label="Booking ID" value={booking.code} />
          <Row label="Date" value={prettyDate(booking.date)} />
          <Row label="Time" value={slotRange(booking.startHour)} />
          <Row
            label={paid ? 'Total Paid' : 'Amount Payable'}
            value={
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Text style={{ fontWeight: '800', color: colors.text }}>{rupees(booking.total)}</Text>
                <Badge label={paid ? 'Paid' : 'Pay at Venue'} tone={paid ? 'green' : 'amber'} />
              </View>
            }
          />
        </Card>

        {/* Intimation: the backend texts the booking details to the user. */}
        <View style={[styles.sms, booking.smsStatus === 'FAILED' && { backgroundColor: colors.warningSoft }]}>
          <Ionicons name="chatbubble-ellipses-outline" size={20} color={colors.primary} />
          <Text style={{ flex: 1, color: colors.text, fontSize: 13 }}>
            {booking.smsStatus === 'FAILED'
              ? "We couldn't send the confirmation SMS. Your booking is still confirmed — keep this Booking ID handy."
              : `Booking details sent by SMS to ${maskPhone(booking.phone)}.`}
          </Text>
        </View>

        <Button title="View Booking" onPress={() => router.replace({ pathname: '/ticket/[id]', params: { id: booking.id } })} />
        <Button title="Share" variant="outline" icon="share-social-outline" onPress={() => shareBooking(booking)} />
        <Button title="Back to Home" variant="outline" onPress={() => router.dismissAll()} style={{ borderColor: colors.border }} />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  hero: { backgroundColor: colors.primary, alignItems: 'center', paddingBottom: 60, paddingHorizontal: 24, overflow: 'hidden' },
  confetti: { position: 'absolute', width: 8, height: 14, borderRadius: 2, opacity: 0.85 },
  check: { width: 76, height: 76, borderRadius: 38, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center' },
  title: { color: '#fff', fontSize: 24, fontWeight: '800', marginTop: 16 },
  subtitle: { color: '#D8EFE0', marginTop: 6 },
  divider: { height: 1, backgroundColor: colors.border, marginVertical: 10 },
  sms: { flexDirection: 'row', gap: 10, alignItems: 'center', backgroundColor: colors.primarySoft, padding: 12, borderRadius: 10 },
});
