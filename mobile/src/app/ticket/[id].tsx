import { Ionicons } from '@expo/vector-icons';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { GroundArt } from '../../components/GroundArt';
import { QRCode } from '../../components/QRCode';
import { Badge, Button, ErrorBanner, Loading } from '../../components/ui';
import { api, type Booking } from '../../lib/api';
import { bookingBadge } from '../../lib/bookingStatus';
import { confirm } from '../../lib/confirm';
import { errorMessage, rupees, shortDate, slotRange } from '../../lib/format';
import { shareBooking } from '../../lib/share';
import { colors, radius, shadow } from '../../lib/theme';

export default function Ticket() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [booking, setBooking] = useState<Booking | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);

  useEffect(() => {
    api<Booking>(`/bookings/${id}`).then(setBooking, (e) => setError(errorMessage(e)));
  }, [id]);

  if (error && !booking) return <ErrorBanner message={error} />;
  if (!booking) return <Loading />;

  const badge = bookingBadge(booking);
  const active = booking.status === 'CONFIRMED' && !booking.started;

  function cancel() {
    const b = booking!;
    const refund = b.paymentStatus === 'PAID' ? `\n\n${rupees(b.total)} will be refunded to your original payment method.` : '';
    confirm(
      'Cancel booking?',
      `${b.groundName}\n${shortDate(b.date)}, ${slotRange(b.startHour)}${refund}`,
      'Cancel booking',
      async () => {
        setCancelling(true);
        try {
          const res = await api<{ booking: Booking }>(`/bookings/${b.id}/cancel`, { body: {} });
          setBooking({ ...res.booking, started: b.started });
        } catch (e) {
          setError(errorMessage(e));
        } finally {
          setCancelling(false);
        }
      },
      'Keep it',
    );
  }

  return (
    <>
      <Stack.Screen
        options={{
          headerRight: () => (
            <Pressable onPress={() => shareBooking(booking)} hitSlop={10} accessibilityLabel="Share ticket">
              <Ionicons name="share-social-outline" size={22} color={colors.text} />
            </Pressable>
          ),
        }}
      />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 16 }}>
        <View style={styles.ticket}>
          <GroundArt seed={booking.groundId} sportId={booking.sportId} indoor={booking.groundType === 'Indoor'} style={styles.image} />
          <View style={{ padding: 16, gap: 4 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
              <Text style={styles.name}>{booking.groundName}</Text>
              <Badge label={badge.label} tone={badge.tone} />
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
              <Ionicons name="location-outline" size={13} color={colors.muted} />
              <Text style={styles.muted}>
                {booking.area}, {booking.cityName}
              </Text>
            </View>
          </View>

          <View style={styles.grid}>
            <Field label="Date" value={shortDate(booking.date)} />
            <Field label="Time" value={slotRange(booking.startHour)} />
            <Field label="Booking ID" value={booking.code} />
            <Field label="Amount" value={rupees(booking.total)} />
          </View>

          {/* perforation */}
          <View style={styles.perforation}>
            <View style={[styles.notch, { left: -12 }]} />
            <View style={styles.dash} />
            <View style={[styles.notch, { right: -12 }]} />
          </View>

          <View style={{ alignItems: 'center', padding: 20, gap: 10, opacity: booking.status === 'CANCELLED' ? 0.25 : 1 }}>
            <QRCode value={`SPORTSSPACE:${booking.code}:${booking.id}`} size={150} />
            <Text style={styles.muted}>Show this ticket at the venue</Text>
          </View>
        </View>

        {booking.paymentStatus === 'PAY_AT_VENUE' && booking.status === 'CONFIRMED' && (
          <Text style={styles.note}>Please pay {rupees(booking.total)} at the venue counter before your slot starts.</Text>
        )}
        <ErrorBanner message={error} />
        {active && <Button title="Cancel Booking" variant="danger" onPress={cancel} loading={cancelling} />}
      </ScrollView>
    </>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ width: '50%', paddingVertical: 8 }}>
      <Text style={styles.muted}>{label}</Text>
      <Text style={styles.value}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  ticket: { backgroundColor: '#fff', borderRadius: 16, overflow: 'hidden', ...shadow },
  image: { width: '100%', height: 150 },
  name: { fontSize: 18, fontWeight: '800', color: colors.text, flex: 1 },
  muted: { color: colors.muted, fontSize: 12 },
  value: { color: colors.text, fontSize: 15, fontWeight: '700', marginTop: 3 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: 16, paddingBottom: 8 },
  perforation: { height: 24, justifyContent: 'center' },
  notch: { position: 'absolute', width: 24, height: 24, borderRadius: 12, backgroundColor: colors.bg },
  dash: { marginHorizontal: 18, borderTopWidth: 1.5, borderColor: colors.border, borderStyle: 'dashed' },
  note: { color: colors.warning, backgroundColor: colors.warningSoft, padding: 12, borderRadius: radius },
});
