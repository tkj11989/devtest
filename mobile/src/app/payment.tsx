import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { Redirect, router } from 'expo-router';
import { useState, type ComponentProps } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button, Card, ErrorBanner, Row } from '../components/ui';
import { api, ApiError, type Booking, type Order, type PaymentChannel } from '../lib/api';
import { useBookingDraft } from '../lib/booking';
import { errorMessage, rupees } from '../lib/format';
import { colors } from '../lib/theme';

type Mci = ComponentProps<typeof MaterialCommunityIcons>['name'];
const ONLINE: { id: PaymentChannel; label: string; icon: Mci; color: string }[] = [
  { id: 'UPI', label: 'UPI (Google Pay, PhonePe, etc.)', icon: 'contactless-payment-circle', color: '#5F259F' },
  { id: 'CARD', label: 'Credit / Debit Card', icon: 'credit-card-outline', color: colors.text },
  { id: 'NETBANKING', label: 'Net Banking', icon: 'bank-outline', color: colors.text },
  { id: 'WALLET', label: 'Wallet (Paytm, Amazon Pay, etc.)', icon: 'wallet-outline', color: colors.text },
];

export default function Payment() {
  const { draft, update } = useBookingDraft();
  const insets = useSafeAreaInsets();
  // Venues without a payout account can't receive online payments yet.
  const onlineOk = draft.ground?.onlinePayments !== false;
  const [channel, setChannel] = useState<PaymentChannel>(onlineOk ? draft.channel ?? 'UPI' : 'VENUE');
  const [details, setDetails] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { ground, date, slot, quote } = draft;

  if (!ground || !date || !slot || !quote) return <Redirect href="/" />;
  const offline = channel === 'VENUE';

  async function pay() {
    setLoading(true);
    setError(null);
    update({ channel });
    try {
      const res = await api<{ booking: Booking; order?: Order }>('/bookings', {
        body: {
          groundId: ground!.id,
          date,
          startHour: slot!.startHour,
          couponCode: quote!.couponCode ?? undefined,
          paymentMethod: offline ? 'OFFLINE' : 'ONLINE',
          paymentChannel: offline ? undefined : channel,
        },
      });
      if (res.order) {
        router.push({
          pathname: '/checkout',
          params: {
            bookingId: res.booking.id,
            orderId: res.order.orderId,
            amount: res.order.amount,
            channel,
            holdExpiresAt: res.booking.holdExpiresAt ?? '',
          },
        });
      } else {
        router.dismissAll();
        router.push({ pathname: '/confirmation', params: { bookingId: res.booking.id } });
      }
    } catch (e) {
      if (e instanceof ApiError && e.code === 'SLOT_UNAVAILABLE') {
        Alert.alert('Slot just got booked', e.message, [{ text: 'Pick another slot', onPress: () => router.dismissTo('/select-slot') }]);
      }
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <View style={{ flex: 1 }}>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 16 }}>
        <Card>
          <Text style={styles.muted}>Amount to Pay</Text>
          <View style={styles.amountRow}>
            <Text style={styles.amount}>{rupees(quote.total)}</Text>
            <Pressable style={styles.details} onPress={() => setDetails((d) => !d)} hitSlop={8}>
              <Text style={styles.detailsText}>View Details</Text>
              <Ionicons name={details ? 'chevron-up' : 'chevron-down'} size={16} color={colors.primary} />
            </Pressable>
          </View>
          {details && (
            <View style={styles.breakdown}>
              <Row label="Booking Amount" value={rupees(quote.amount)} />
              <Row label="Platform Fee" value={rupees(quote.platformFee)} />
              {quote.discount > 0 && <Row label={`Coupon (${quote.couponCode})`} value={`– ${rupees(quote.discount)}`} valueStyle={{ color: colors.primary }} />}
              <View style={styles.split}>
                <Ionicons name="git-branch-outline" size={16} color={colors.primary} />
                <Text style={{ flex: 1, color: colors.muted, fontSize: 12 }}>
                  {rupees(quote.amount)} goes directly to {ground.name}. The platform fee goes to Sports Space.
                </Text>
              </View>
            </View>
          )}
        </Card>

        <Text style={styles.section}>Select Payment Method</Text>
        {!onlineOk && <Text style={styles.note}>{ground.name} accepts payment at the venue only right now.</Text>}
        <Card style={[{ paddingVertical: 4 }, !onlineOk && { opacity: 0.45 }]}>
          {ONLINE.map((m, i) => (
            <Method
              key={m.id}
              icon={m.icon}
              iconColor={m.color}
              label={m.label}
              active={channel === m.id}
              onPress={() => setChannel(m.id)}
              disabled={!onlineOk}
              last={i === ONLINE.length - 1}
            />
          ))}
        </Card>

        <Text style={styles.section}>Pay Offline</Text>
        <Card style={{ paddingVertical: 4 }}>
          <Method
            icon="cash-multiple"
            iconColor={colors.primary}
            label="Pay at Venue"
            sub="Pay by cash or UPI at the ground before you play"
            active={offline}
            onPress={() => setChannel('VENUE')}
            last
          />
        </Card>
        {offline && (
          <Text style={styles.note}>Your slot is confirmed right away. Please pay {rupees(quote.total)} at the venue counter.</Text>
        )}
        <ErrorBanner message={error} />
      </ScrollView>

      <View style={[styles.footer, { paddingBottom: 12 + insets.bottom }]}>
        <Button title={offline ? 'Confirm Booking' : `Pay ${rupees(quote.total)}`} onPress={pay} loading={loading} />
        <View style={styles.secure}>
          <Ionicons name="shield-checkmark" size={15} color={colors.primary} />
          <Text style={styles.muted}>100% Secure Payment</Text>
        </View>
      </View>
    </View>
  );
}

function Method({
  icon,
  iconColor,
  label,
  sub,
  active,
  onPress,
  disabled,
  last,
}: {
  icon: Mci;
  iconColor: string;
  label: string;
  sub?: string;
  active: boolean;
  onPress: () => void;
  disabled?: boolean;
  last?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ checked: active, disabled }}
      onPress={onPress}
      disabled={disabled}
      style={[styles.method, !last && { borderBottomWidth: 1, borderBottomColor: colors.border }]}
    >
      <MaterialCommunityIcons name={icon} size={26} color={iconColor} />
      <View style={{ flex: 1 }}>
        <Text style={styles.methodLabel}>{label}</Text>
        {sub && <Text style={[styles.muted, { marginTop: 2 }]}>{sub}</Text>}
      </View>
      <View style={[styles.radio, active && styles.radioActive]}>{active && <View style={styles.radioDot} />}</View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  muted: { color: colors.muted, fontSize: 13 },
  amountRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 4 },
  amount: { fontSize: 30, fontWeight: '800', color: colors.text },
  details: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  detailsText: { color: colors.primary, fontWeight: '700', fontSize: 13 },
  split: { flexDirection: 'row', gap: 6, alignItems: 'center', marginTop: 6, backgroundColor: colors.primarySoft, padding: 8, borderRadius: 8 },
  breakdown: { marginTop: 10, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 6 },
  section: { fontSize: 16, fontWeight: '800', color: colors.text, marginBottom: -4 },
  method: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 14 },
  methodLabel: { fontSize: 14, fontWeight: '600', color: colors.text },
  radio: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: '#C6CEC9', alignItems: 'center', justifyContent: 'center' },
  radioActive: { borderColor: colors.primary },
  radioDot: { width: 11, height: 11, borderRadius: 6, backgroundColor: colors.primary },
  note: { color: colors.warning, backgroundColor: colors.warningSoft, padding: 12, borderRadius: 10 },
  footer: { paddingHorizontal: 16, paddingTop: 12, backgroundColor: '#fff', borderTopWidth: 1, borderColor: colors.border, gap: 10 },
  secure: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 },
});
