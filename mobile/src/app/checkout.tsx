import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Button, Card, ErrorBanner } from '../components/ui';
import { api, ApiError, type Booking } from '../lib/api';
import { rupees } from '../lib/format';
import { colors, radius } from '../lib/theme';

const OPTIONS = ['UPI', 'Card', 'Net Banking'] as const;

// Test-mode payment gateway, backed by the API's mock provider. For live
// payments, replace `capture` with Razorpay Checkout (react-native-razorpay),
// which returns the same { paymentId, signature } pair for /bookings/:id/pay.
export default function Checkout() {
  const { bookingId, orderId, amount, holdExpiresAt } = useLocalSearchParams<{
    bookingId: string;
    orderId: string;
    amount: string;
    holdExpiresAt: string;
  }>();
  const [option, setOption] = useState<(typeof OPTIONS)[number]>('UPI');
  const [busy, setBusy] = useState<'pay' | 'fail' | 'cancel' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(() => remaining(holdExpiresAt));

  useEffect(() => {
    const t = setInterval(() => setSecondsLeft(remaining(holdExpiresAt)), 1000);
    return () => clearInterval(t);
  }, [holdExpiresAt]);

  async function capture(outcome: 'success' | 'fail') {
    setBusy(outcome === 'success' ? 'pay' : 'fail');
    setError(null);
    try {
      const { paymentId, signature } = await api<{ paymentId: string; signature: string }>('/payments/mock-checkout', {
        body: { orderId, outcome },
      });
      await api<{ booking: Booking }>(`/bookings/${bookingId}/pay`, { body: { paymentId, signature } });
      router.dismissAll();
      router.push({ pathname: '/confirmation', params: { bookingId } });
    } catch (e) {
      if (e instanceof ApiError && e.code === 'HOLD_EXPIRED') {
        setSecondsLeft(0);
      }
      setError(e instanceof Error ? e.message : String(e));
      setBusy(null);
    }
  }

  async function cancel() {
    setBusy('cancel');
    // Release the held slot right away instead of waiting for it to expire.
    await api(`/bookings/${bookingId}/cancel`, { body: {} }).catch(() => {});
    router.back();
  }

  const expired = secondsLeft <= 0;
  const mm = String(Math.floor(secondsLeft / 60)).padStart(2, '0');
  const ss = String(secondsLeft % 60).padStart(2, '0');

  return (
    <View style={styles.container}>
      <View style={styles.badge}>
        <Text style={styles.badgeText}>TEST MODE · No real money is charged</Text>
      </View>
      <Card style={{ alignItems: 'center', gap: 4 }}>
        <Text style={styles.muted}>Amount payable</Text>
        <Text style={styles.amount}>{rupees(Number(amount))}</Text>
        <Text style={styles.muted}>Order {orderId}</Text>
        <Text style={[styles.timer, expired && { color: colors.danger }]}>
          {expired ? 'Slot hold expired' : `Slot held for ${mm}:${ss}`}
        </Text>
      </Card>

      <View style={styles.options}>
        {OPTIONS.map((o) => (
          <Pressable key={o} onPress={() => setOption(o)} style={[styles.option, o === option && styles.optionActive]}>
            <Text style={[styles.optionText, o === option && { color: colors.primary }]}>{o}</Text>
          </Pressable>
        ))}
      </View>

      <ErrorBanner message={error} />
      <View style={{ gap: 12, marginTop: 'auto' }}>
        <Button
          title={`Pay ${rupees(Number(amount))} via ${option}`}
          onPress={() => capture('success')}
          loading={busy === 'pay'}
          disabled={expired || !!busy}
        />
        <Button title="Simulate payment failure" variant="danger" onPress={() => capture('fail')} loading={busy === 'fail'} disabled={expired || !!busy} />
        <Button title={expired ? 'Back to slots' : 'Cancel payment'} variant="outline" onPress={cancel} loading={busy === 'cancel'} disabled={!!busy && busy !== 'cancel'} />
      </View>
    </View>
  );
}

function remaining(iso?: string) {
  if (!iso) return 600;
  return Math.max(0, Math.round((Date.parse(iso) - Date.now()) / 1000));
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16, gap: 16 },
  badge: { alignSelf: 'center', backgroundColor: colors.warningSoft, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20 },
  badgeText: { color: colors.warning, fontWeight: '700', fontSize: 12 },
  muted: { color: colors.muted, fontSize: 13 },
  amount: { fontSize: 34, fontWeight: '800', color: colors.text },
  timer: { marginTop: 8, fontWeight: '700', color: colors.primary },
  options: { flexDirection: 'row', gap: 10 },
  option: { flex: 1, padding: 14, borderRadius: radius, borderWidth: 1.5, borderColor: colors.border, backgroundColor: colors.card, alignItems: 'center' },
  optionActive: { borderColor: colors.primary, backgroundColor: colors.primarySoft },
  optionText: { fontWeight: '700', color: colors.text },
});
