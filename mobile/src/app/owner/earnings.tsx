import { Ionicons } from '@expo/vector-icons';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { Badge, Empty, ErrorBanner, Loading } from '../../components/ui';
import { api, type Earnings } from '../../lib/api';
import { errorMessage, rupees } from '../../lib/format';
import { LEDGER_LABEL } from '../../lib/ledger';
import { colors, radius, shadow } from '../../lib/theme';

export default function OwnerEarnings() {
  const [data, setData] = useState<Earnings | null>(null);
  const [error, setError] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      api<Earnings>('/owner/earnings').then(setData, (e) => setError(errorMessage(e)));
    }, []),
  );

  if (!data && !error) return <Loading />;
  // Platform fee lines are the platform's money; owners see their own lines.
  const entries = (data?.entries ?? []).filter((e) => e.type !== 'PLATFORM_FEE');
  const due = data?.platformFeesDue ?? 0;

  return (
    <FlatList
      data={entries}
      keyExtractor={(e) => e.id}
      contentContainerStyle={{ padding: 16, gap: 10 }}
      ListHeaderComponent={
        <View style={{ gap: 12, marginBottom: 6 }}>
          <ErrorBanner message={error} />
          <View style={styles.hero}>
            <Text style={{ color: '#D8EFE0' }}>Credited to your account</Text>
            <Text style={styles.heroAmount}>{rupees(data?.paidToAccount ?? 0)}</Text>
            <Text style={{ color: '#D8EFE0', fontSize: 12 }}>From online bookings, sent directly to your payout account</Text>
          </View>
          <View style={{ flexDirection: 'row', gap: 12 }}>
            <View style={styles.stat}>
              <Text style={styles.statLabel}>Collected at venue</Text>
              <Text style={styles.statValue}>{rupees(data?.collectedAtVenue ?? 0)}</Text>
            </View>
            <View style={styles.stat}>
              <Text style={styles.statLabel}>{due < 0 ? 'Sports Space owes you' : 'Platform fees due'}</Text>
              <Text style={[styles.statValue, due > 0 && { color: colors.warning }]}>{rupees(Math.abs(due))}</Text>
            </View>
          </View>
          {due > 0 && (
            <Text style={styles.dueNote}>
              Platform fees on pay-at-venue bookings are collected by you at the ground. Please pay {rupees(due)} to Sports Space.
            </Text>
          )}
          <Pressable style={styles.account} onPress={() => router.push('/owner/payout')}>
            <Ionicons name={data?.payout?.method === 'BANK' ? 'business-outline' : 'phone-portrait-outline'} size={22} color={colors.primary} />
            <View style={{ flex: 1 }}>
              <Text style={styles.statLabel}>Payout account</Text>
              <Text style={{ fontWeight: '700', color: colors.text }}>{data?.payout?.destination ?? 'Not added yet'}</Text>
            </View>
            {data?.payout && <Badge label={data.payout.status === 'ACTIVE' ? 'Active' : 'Pending'} tone={data.payout.status === 'ACTIVE' ? 'green' : 'amber'} />}
            <Ionicons name="chevron-forward" size={18} color={colors.muted} />
          </Pressable>
          <Text style={styles.section}>Transactions</Text>
        </View>
      }
      ListEmptyComponent={<Empty icon="wallet-outline" title="No transactions yet" subtitle="Payments for your bookings will appear here." />}
      renderItem={({ item }) => {
        const incoming = item.type === 'OWNER_PAYOUT' || item.type === 'PLATFORM_SUBSIDY' || item.type === 'VENUE_COLLECTION';
        const positive = incoming ? item.amount > 0 : item.amount < 0;
        return (
          <View style={styles.row}>
            <View style={[styles.icon, !positive && { backgroundColor: colors.warningSoft }]}>
              <Ionicons name={positive ? 'arrow-down' : 'arrow-up'} size={18} color={positive ? colors.primary : colors.warning} />
            </View>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={styles.rowTitle}>{item.reversal ? `${LEDGER_LABEL[item.type]} (reversed)` : LEDGER_LABEL[item.type]}</Text>
              <Text style={styles.rowMeta}>
                {[item.bookingCode, item.groundName, new Date(item.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })].filter(Boolean).join(' · ')}
              </Text>
              {item.destination && !item.reversal && <Text style={styles.rowMeta}>To {item.destination}</Text>}
            </View>
            <View style={{ alignItems: 'flex-end', gap: 3 }}>
              <Text style={[styles.amount, { color: positive ? colors.primary : colors.text }]}>
                {positive ? '+' : '–'}
                {rupees(Math.abs(item.amount))}
              </Text>
              {item.status !== 'PROCESSED' && <Badge label={item.status === 'INITIATED' ? 'In transit' : 'Failed'} tone={item.status === 'FAILED' ? 'red' : 'amber'} />}
            </View>
          </View>
        );
      }}
    />
  );
}

const styles = StyleSheet.create({
  hero: { backgroundColor: colors.primary, borderRadius: radius, padding: 18, gap: 4 },
  heroAmount: { color: '#fff', fontSize: 30, fontWeight: '800' },
  stat: { flex: 1, backgroundColor: '#fff', borderRadius: radius, padding: 14, ...shadow },
  statLabel: { color: colors.muted, fontSize: 12 },
  statValue: { fontSize: 18, fontWeight: '800', color: colors.text, marginTop: 4 },
  dueNote: { color: colors.warning, backgroundColor: colors.warningSoft, padding: 10, borderRadius: 8, fontSize: 12 },
  account: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: '#fff', borderRadius: radius, padding: 14, ...shadow },
  section: { fontSize: 16, fontWeight: '800', color: colors.text, marginTop: 4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: '#fff', borderRadius: radius, padding: 12, ...shadow },
  icon: { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.primarySoft, alignItems: 'center', justifyContent: 'center' },
  rowTitle: { fontWeight: '700', color: colors.text, fontSize: 14 },
  rowMeta: { color: colors.muted, fontSize: 12 },
  amount: { fontWeight: '800', fontSize: 15 },
});
