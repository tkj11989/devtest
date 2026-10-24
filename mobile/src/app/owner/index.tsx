import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState, type ComponentProps } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Badge, Button, Chip, Empty, ErrorBanner, Loading } from '../../components/ui';
import { api, qs, type Payout } from '../../lib/api';
import { confirm } from '../../lib/confirm';
import { errorMessage, rupees } from '../../lib/format';
import { colors, radius, shadow } from '../../lib/theme';
import { useOwnerGrounds } from '../../lib/useOwnerGrounds';

type Dashboard = {
  totalBookings: number;
  totalRevenue: number;
  upcoming: number;
  completed: number;
  pendingPayments: number;
  today: {
    id: string;
    code: string;
    groundName: string;
    slotLabel: string;
    customerName: string;
    amount: number;
    paymentStatus: 'PAID' | 'PAY_AT_VENUE' | 'REFUND_INITIATED' | 'PENDING';
  }[];
};

type Mci = ComponentProps<typeof MaterialCommunityIcons>['name'];

export default function OwnerDashboard() {
  const { grounds, error: groundsError } = useOwnerGrounds();
  const [groundId, setGroundId] = useState<string | null>(null);
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [payout, setPayout] = useState<Payout | null | undefined>(undefined);

  const load = useCallback(async () => {
    try {
      const [d, p] = await Promise.all([api<Dashboard>(`/owner/dashboard${qs({ groundId })}`), api<Payout | null>('/owner/payout')]);
      setData(d);
      setPayout(p);
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [groundId]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  function collect(b: Dashboard['today'][number]) {
    confirm('Mark payment collected?', `${b.customerName} · ${b.slotLabel}\n${rupees(b.amount)} received at the venue.`, 'Mark Paid', async () => {
      await api(`/owner/bookings/${b.id}/collect`, { body: {} }).catch((e) => setError(errorMessage(e)));
      load();
    });
  }

  if (!data && !error) return <Loading />;
  const multi = (grounds?.length ?? 0) > 1;

  return (
    <ScrollView
      contentContainerStyle={{ paddingBottom: 24 }}
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
      <View style={styles.band}>
        {multi && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingHorizontal: 16, paddingBottom: 14 }}>
            <Chip label="All Grounds" active={!groundId} onPress={() => setGroundId(null)} onDark />
            {grounds!.map((g) => (
              <Chip key={g.id} label={g.name} active={groundId === g.id} onPress={() => setGroundId(g.id)} onDark />
            ))}
          </ScrollView>
        )}
        <View style={{ height: 64 }} />
      </View>

      <View style={styles.stats}>
        <Stat icon="calendar-check-outline" value={String(data?.totalBookings ?? 0)} label="Total Bookings" />
        <Stat icon="cash-multiple" value={rupees(data?.totalRevenue ?? 0)} label="Total Revenue" />
        <Stat icon="calendar-clock-outline" value={String(data?.upcoming ?? 0)} label="Upcoming" />
        <Stat icon="check-decagram-outline" value={String(data?.completed ?? 0)} label="Completed" />
      </View>

      <View style={{ paddingHorizontal: 16, gap: 12 }}>
        <ErrorBanner message={error ?? groundsError} />
        {payout === null && (
          <Pressable style={styles.setup} onPress={() => router.push('/owner/payout')}>
            <Ionicons name="alert-circle" size={22} color={colors.warning} />
            <View style={{ flex: 1 }}>
              <Text style={{ fontWeight: '800', color: colors.text }}>Add your payout account</Text>
              <Text style={{ color: colors.muted, fontSize: 12 }}>Players can only pay at the venue until you add a UPI ID or bank account.</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={colors.muted} />
          </Pressable>
        )}
        {payout && (
          <Pressable style={styles.payout} onPress={() => router.push('/owner/earnings')}>
            <Ionicons name="wallet-outline" size={22} color={colors.primary} />
            <View style={{ flex: 1 }}>
              <Text style={{ fontWeight: '800', color: colors.text }}>Earnings & Payouts</Text>
              <Text style={{ color: colors.muted, fontSize: 12 }} numberOfLines={1}>
                {payout.status === 'ACTIVE' ? `Online payments go to ${payout.destination}` : 'Payout account pending verification'}
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={colors.muted} />
          </Pressable>
        )}
        <Button
          title="Manage Slots"
          icon="time-outline"
          variant="outline"
          onPress={() => router.push({ pathname: '/owner/slots', params: groundId ? { groundId } : {} })}
        />
        {!!data?.pendingPayments && (
          <Text style={styles.pending}>
            {data.pendingPayments} booking{data.pendingPayments > 1 ? 's' : ''} to be paid at the venue
          </Text>
        )}

        <Text style={styles.section}>Today's Bookings</Text>
        {data?.today.length === 0 && <Empty icon="calendar-outline" title="No bookings today" />}
        {data?.today.map((b) => {
          const paid = b.paymentStatus === 'PAID';
          return (
            <Pressable key={b.id} style={styles.booking} onPress={() => !paid && collect(b)} disabled={paid}>
              <Ionicons name={paid ? 'checkmark-circle' : 'time'} size={22} color={paid ? colors.primary : colors.warning} />
              <View style={{ flex: 1 }}>
                <Text style={styles.slot}>{b.slotLabel.replace(' - ', ' – ')}</Text>
                <Text style={styles.customer}>
                  {b.customerName}
                  {multi && !groundId ? ` · ${b.groundName}` : ''}
                </Text>
              </View>
              <View style={{ alignItems: 'flex-end', gap: 4 }}>
                <Badge label={paid ? 'Confirmed' : 'Pending'} tone={paid ? 'green' : 'amber'} />
                {!paid && <Text style={styles.tap}>Tap to mark paid</Text>}
              </View>
            </Pressable>
          );
        })}
      </View>
    </ScrollView>
  );
}

function Stat({ icon, value, label }: { icon: Mci; value: string; label: string }) {
  return (
    <View style={styles.stat}>
      <MaterialCommunityIcons name={icon} size={24} color={colors.primary} />
      <View style={{ flex: 1 }}>
        <Text style={styles.statValue} numberOfLines={1} adjustsFontSizeToFit>
          {value}
        </Text>
        <Text style={styles.statLabel}>{label}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  band: { backgroundColor: colors.primary, paddingTop: 4 },
  stats: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, paddingHorizontal: 16, marginTop: -56, marginBottom: 16 },
  stat: { width: '47%', flexGrow: 1, flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: '#fff', borderRadius: radius, padding: 14, ...shadow },
  statValue: { fontSize: 20, fontWeight: '800', color: colors.text },
  statLabel: { fontSize: 12, color: colors.muted },
  setup: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: colors.warningSoft, borderRadius: radius, padding: 14 },
  payout: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: '#fff', borderRadius: radius, padding: 14, ...shadow },
  pending: { color: colors.warning, backgroundColor: colors.warningSoft, padding: 10, borderRadius: 8, textAlign: 'center' },
  section: { fontSize: 16, fontWeight: '800', color: colors.text, marginTop: 6 },
  booking: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: '#fff', borderRadius: radius, padding: 14, ...shadow },
  slot: { fontWeight: '700', color: colors.text },
  customer: { color: colors.muted, fontSize: 13, marginTop: 2 },
  tap: { fontSize: 10, color: colors.muted },
});
