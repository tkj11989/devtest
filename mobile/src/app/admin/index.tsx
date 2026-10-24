import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Sheet } from '../../components/Sheet';
import { Badge, Button, ErrorBanner, Loading } from '../../components/ui';
import { api, type AdminSummary } from '../../lib/api';
import { errorMessage, maskPhone, rupees } from '../../lib/format';
import { colors, radius, shadow } from '../../lib/theme';

type Owner = AdminSummary['owners'][number];
type Action = { kind: 'link' | 'dues'; owner: Owner };

// Platform fees from online bookings stay in the platform's own payment
// gateway account; venue shares are routed straight to each owner.
export default function AdminDashboard() {
  const [data, setData] = useState<AdminSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [action, setAction] = useState<Action | null>(null);
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api<AdminSummary>('/admin/summary'));
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  function open(a: Action) {
    setAction(a);
    setFormError(null);
    setValue(a.kind === 'link' ? a.owner.payout?.linkedAccountId ?? '' : String(Math.max(a.owner.platformFeesDue, 0)));
  }

  async function submit() {
    if (!action) return;
    setSaving(true);
    setFormError(null);
    try {
      if (action.kind === 'link') {
        await api(`/admin/owners/${action.owner.phone}/linked-account`, { method: 'PUT', body: { linkedAccountId: value.trim() } });
      } else {
        await api(`/admin/owners/${action.owner.phone}/dues-received`, { body: { amount: Number(value) } });
      }
      setAction(null);
      load();
    } catch (e) {
      setFormError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  if (!data && !error) return <Loading />;
  const net = (data?.feesCollectedOnline ?? 0) + (data?.duesReceived ?? 0) - (data?.subsidiesPaid ?? 0);

  return (
    <ScrollView
      contentContainerStyle={{ padding: 16, gap: 14 }}
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
    >
      <ErrorBanner message={error} />
      <View style={styles.hero}>
        <Text style={{ color: '#C9D2CD' }}>Platform earnings (net)</Text>
        <Text style={styles.heroAmount}>{rupees(net)}</Text>
        <Text style={{ color: '#C9D2CD', fontSize: 12 }}>
          Credited to the platform's {data?.paymentProvider === 'razorpay' ? 'Razorpay' : 'payment gateway'} account
        </Text>
      </View>
      <View style={styles.grid}>
        <Stat label="Platform fees (online)" value={rupees(data?.feesCollectedOnline ?? 0)} />
        <Stat label="Fees received from venues" value={rupees(data?.duesReceived ?? 0)} />
        <Stat label="Fees due from venues" value={rupees(data?.feesDueFromVenues ?? 0)} warn={(data?.feesDueFromVenues ?? 0) > 0} />
        <Stat label="Coupon top-ups paid" value={rupees(data?.subsidiesPaid ?? 0)} />
        <Stat label="Paid out to owners" value={rupees(data?.paidToOwners ?? 0)} />
        <Stat label={`Bookings · GMV`} value={`${data?.bookings ?? 0} · ${rupees(data?.grossBookingValue ?? 0)}`} />
      </View>

      <Text style={styles.section}>Venue owners</Text>
      {data?.owners.map((o) => (
        <View key={o.phone} style={styles.owner}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
            <View style={{ flex: 1 }}>
              <Text style={styles.ownerName}>{o.name || maskPhone(o.phone)}</Text>
              <Text style={styles.muted}>
                {maskPhone(o.phone)} · {o.grounds.length} ground{o.grounds.length === 1 ? '' : 's'}
              </Text>
            </View>
            {o.payout ? (
              <Badge label={o.payout.status === 'ACTIVE' ? 'Payouts active' : 'Needs linking'} tone={o.payout.status === 'ACTIVE' ? 'green' : 'amber'} />
            ) : (
              <Badge label="No payout account" tone="red" />
            )}
          </View>
          {o.payout && (
            <View style={styles.dest}>
              <Ionicons name={o.payout.method === 'BANK' ? 'business-outline' : 'phone-portrait-outline'} size={16} color={colors.muted} />
              <Text style={{ flex: 1, color: colors.text, fontSize: 13 }}>
                {o.payout.destination} · {o.payout.accountHolder}
                {o.payout.linkedAccountId ? `\nRazorpay ${o.payout.linkedAccountId}` : ''}
              </Text>
            </View>
          )}
          <View style={{ flexDirection: 'row', gap: 16 }}>
            <Text style={styles.muted}>
              Paid out <Text style={styles.strong}>{rupees(o.paidToAccount)}</Text>
            </Text>
            <Text style={styles.muted}>
              Fees due <Text style={[styles.strong, o.platformFeesDue > 0 && { color: colors.warning }]}>{rupees(o.platformFeesDue)}</Text>
            </Text>
          </View>
          <View style={{ flexDirection: 'row', gap: 10 }}>
            {o.payout && (
              <Button
                title={o.payout.linkedAccountId ? 'Update Razorpay link' : 'Link Razorpay account'}
                variant="outline"
                onPress={() => open({ kind: 'link', owner: o })}
                style={styles.smallBtn}
              />
            )}
            {o.platformFeesDue > 0 && <Button title="Record fees received" variant="outline" onPress={() => open({ kind: 'dues', owner: o })} style={styles.smallBtn} />}
          </View>
        </View>
      ))}

      <Sheet
        visible={!!action}
        onClose={() => setAction(null)}
        title={action?.kind === 'link' ? 'Razorpay linked account' : 'Fees received from venue'}
      >
        <Text style={styles.muted}>
          {action?.kind === 'link'
            ? `Create a Route linked account for ${action.owner.payout?.destination} in the Razorpay dashboard, then paste its ID here.`
            : `Amount ${action?.owner.name || 'the owner'} has paid towards platform fees on pay-at-venue bookings.`}
        </Text>
        <TextInput
          style={styles.input}
          value={value}
          onChangeText={action?.kind === 'dues' ? (t) => setValue(t.replace(/\D/g, '')) : setValue}
          placeholder={action?.kind === 'link' ? 'acc_XXXXXXXXXXXXXX' : 'Amount in ₹'}
          placeholderTextColor={colors.muted}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType={action?.kind === 'dues' ? 'number-pad' : 'default'}
        />
        <ErrorBanner message={formError} />
        <Button title="Save" onPress={submit} loading={saving} disabled={!value} />
      </Sheet>
    </ScrollView>
  );
}

function Stat({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.muted}>{label}</Text>
      <Text style={[styles.statValue, warn && { color: colors.warning }]} numberOfLines={1} adjustsFontSizeToFit>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  hero: { backgroundColor: colors.text, borderRadius: radius, padding: 18, gap: 4 },
  heroAmount: { color: '#fff', fontSize: 30, fontWeight: '800' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  stat: { width: '48%', flexGrow: 1, backgroundColor: '#fff', borderRadius: radius, padding: 12, ...shadow },
  statValue: { fontSize: 17, fontWeight: '800', color: colors.text, marginTop: 4 },
  section: { fontSize: 16, fontWeight: '800', color: colors.text, marginTop: 4 },
  owner: { backgroundColor: '#fff', borderRadius: radius, padding: 14, gap: 10, ...shadow },
  ownerName: { fontSize: 15, fontWeight: '800', color: colors.text },
  muted: { color: colors.muted, fontSize: 12 },
  strong: { color: colors.text, fontWeight: '700' },
  dest: { flexDirection: 'row', gap: 8, backgroundColor: colors.bg, padding: 10, borderRadius: 8 },
  smallBtn: { flex: 1, minHeight: 40, paddingVertical: 8 },
  input: { borderWidth: 1.5, borderColor: colors.border, borderRadius: 10, padding: 12, fontSize: 16, color: colors.text },
});
