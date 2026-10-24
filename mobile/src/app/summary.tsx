import { Ionicons } from '@expo/vector-icons';
import { Redirect, router } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { GroundHeader } from '../components/GroundHeader';
import { Sheet } from '../components/Sheet';
import { Button, Card, ErrorBanner, Row, type IconName } from '../components/ui';
import { api, ApiError, type Coupon, type Quote } from '../lib/api';
import { useBookingDraft } from '../lib/booking';
import { errorMessage, prettyDate, rupees, slotRange } from '../lib/format';
import { colors } from '../lib/theme';

export default function BookingSummary() {
  const { draft, update } = useBookingDraft();
  const insets = useSafeAreaInsets();
  const [quote, setQuote] = useState<Quote | null>(draft.quote ?? null);
  const [coupons, setCoupons] = useState<Coupon[]>([]);
  const [sheet, setSheet] = useState(false);
  const [code, setCode] = useState('');
  const [couponError, setCouponError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { ground, date, slot } = draft;

  const fetchQuote = (couponCode?: string) =>
    api<Quote>('/bookings/quote', { body: { groundId: ground!.id, date, startHour: slot!.startHour, couponCode } });

  useEffect(() => {
    if (!ground || !date || !slot) return;
    fetchQuote(draft.couponCode).then(setQuote, (e) => {
      if (e instanceof ApiError && e.code === 'SLOT_UNAVAILABLE') {
        Alert.alert('Slot just got booked', e.message, [{ text: 'Pick another slot', onPress: () => router.back() }]);
      }
      setError(errorMessage(e));
    });
    api<Coupon[]>('/coupons').then(setCoupons, () => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!ground || !date || !slot) return <Redirect href="/" />;

  async function applyCoupon(c: string) {
    setApplying(true);
    setCouponError(null);
    try {
      const q = await fetchQuote(c);
      setQuote(q);
      update({ couponCode: q.couponCode ?? undefined });
      setSheet(false);
      setCode('');
    } catch (e) {
      setCouponError(errorMessage(e));
    } finally {
      setApplying(false);
    }
  }

  async function removeCoupon() {
    const q = await fetchQuote();
    setQuote(q);
    update({ couponCode: undefined });
  }

  return (
    <View style={{ flex: 1 }}>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 14 }}>
        <Card>
          <GroundHeader id={ground.id} sportId={ground.sportId} indoor={ground.type === 'Indoor'} name={ground.name} location={`${ground.area}, ${ground.cityName}`} />
        </Card>

        <Card style={{ gap: 4 }}>
          <InfoRow icon="calendar-outline" label="Date" value={prettyDate(date)} />
          <InfoRow icon="time-outline" label="Time Slot" value={`${slotRange(slot.startHour)} (1 Hour)`} />
          <InfoRow icon="pricetag-outline" label="Price" value={rupees(slot.price)} last />
        </Card>

        {quote?.couponCode ? (
          <View style={[styles.coupon, styles.couponApplied]}>
            <Ionicons name="checkmark-circle" size={20} color={colors.primary} />
            <Text style={{ flex: 1, color: colors.text }}>
              <Text style={{ fontWeight: '800' }}>{quote.couponCode}</Text> applied · You save {rupees(quote.discount)}
            </Text>
            <Pressable onPress={removeCoupon} hitSlop={8}>
              <Text style={{ color: colors.danger, fontWeight: '700' }}>Remove</Text>
            </Pressable>
          </View>
        ) : (
          <Pressable style={styles.coupon} onPress={() => setSheet(true)}>
            <Ionicons name="pricetags-outline" size={20} color={colors.primary} />
            <Text style={{ flex: 1, color: colors.text, fontWeight: '600' }}>Apply Coupon</Text>
            <Ionicons name="chevron-forward" size={18} color={colors.muted} />
          </Pressable>
        )}

        <Card>
          {quote ? (
            <>
              <Row label="Booking Amount" value={rupees(quote.amount)} />
              <Row label="Platform Fee" value={rupees(quote.platformFee)} />
              {quote.discount > 0 && <Row label="Coupon Discount" value={`– ${rupees(quote.discount)}`} valueStyle={{ color: colors.primary }} />}
              <View style={styles.divider} />
              <View style={styles.totalRow}>
                <Text style={styles.totalLabel}>Total Amount</Text>
                <Text style={styles.total}>{rupees(quote.total)}</Text>
              </View>
            </>
          ) : (
            !error && <ActivityIndicator color={colors.primary} />
          )}
          <ErrorBanner message={error} />
        </Card>
      </ScrollView>

      <View style={[styles.footer, { paddingBottom: 12 + insets.bottom }]}>
        <Button
          title="Proceed to Payment"
          disabled={!quote}
          onPress={() => {
            update({ quote: quote! });
            router.push('/payment');
          }}
        />
      </View>

      <Sheet visible={sheet} onClose={() => setSheet(false)} title="Apply Coupon">
        <View style={styles.codeRow}>
          <TextInput
            style={styles.codeInput}
            value={code}
            onChangeText={(t) => setCode(t.toUpperCase())}
            placeholder="Enter coupon code"
            placeholderTextColor={colors.muted}
            autoCapitalize="characters"
            autoCorrect={false}
          />
          <Pressable onPress={() => applyCoupon(code)} disabled={!code || applying}>
            <Text style={[styles.apply, (!code || applying) && { opacity: 0.4 }]}>APPLY</Text>
          </Pressable>
        </View>
        <ErrorBanner message={couponError} />
        {coupons.map((c) => (
          <Pressable key={c.code} style={styles.couponOption} onPress={() => applyCoupon(c.code)} disabled={applying}>
            <View style={styles.codeTag}>
              <Text style={styles.codeTagText}>{c.code}</Text>
            </View>
            <Text style={{ flex: 1, color: colors.muted }}>{c.description}</Text>
            <Text style={styles.apply}>APPLY</Text>
          </Pressable>
        ))}
      </Sheet>
    </View>
  );
}

function InfoRow({ icon, label, value, last }: { icon: IconName; label: string; value: string; last?: boolean }) {
  return (
    <View style={[styles.info, !last && { borderBottomWidth: 1, borderBottomColor: colors.border }]}>
      <View style={styles.infoIcon}>
        <Ionicons name={icon} size={18} color={colors.text} />
      </View>
      <View>
        <Text style={styles.infoLabel}>{label}</Text>
        <Text style={styles.infoValue}>{value}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  info: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 12 },
  infoIcon: { width: 36, height: 36, borderRadius: 10, backgroundColor: colors.disabled, alignItems: 'center', justifyContent: 'center' },
  infoLabel: { color: colors.muted, fontSize: 12 },
  infoValue: { color: colors.text, fontSize: 15, fontWeight: '700', marginTop: 2 },
  coupon: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: '#fff', borderRadius: 12, padding: 16, borderWidth: 1, borderColor: colors.border, borderStyle: 'dashed' },
  couponApplied: { borderColor: colors.primary, backgroundColor: colors.primarySoft, borderStyle: 'solid' },
  divider: { height: 1, backgroundColor: colors.border, marginVertical: 8 },
  totalRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  totalLabel: { fontSize: 16, fontWeight: '800', color: colors.text },
  total: { fontSize: 18, fontWeight: '800', color: colors.text },
  footer: { paddingHorizontal: 16, paddingTop: 12, backgroundColor: '#fff', borderTopWidth: 1, borderColor: colors.border },
  codeRow: { flexDirection: 'row', alignItems: 'center', borderWidth: 1.5, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 12 },
  codeInput: { flex: 1, paddingVertical: 12, fontSize: 15, color: colors.text, letterSpacing: 1 },
  apply: { color: colors.primary, fontWeight: '800' },
  couponOption: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 12, borderTopWidth: 1, borderTopColor: colors.border },
  codeTag: { borderWidth: 1, borderStyle: 'dashed', borderColor: colors.primary, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4, backgroundColor: colors.primarySoft },
  codeTagText: { color: colors.primary, fontWeight: '800', fontSize: 12 },
});
