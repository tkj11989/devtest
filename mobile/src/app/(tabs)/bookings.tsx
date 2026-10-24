import { Ionicons } from '@expo/vector-icons';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { GroundArt } from '../../components/GroundArt';
import { Badge, Empty, ErrorBanner, Loading, Segmented } from '../../components/ui';
import { api, type Booking } from '../../lib/api';
import { bookingBadge } from '../../lib/bookingStatus';
import { errorMessage, prettyDate, rupees, slotRange } from '../../lib/format';
import { colors, radius, shadow } from '../../lib/theme';

type Tab = 'upcoming' | 'past' | 'cancelled';
const TABS: { id: Tab; label: string }[] = [
  { id: 'upcoming', label: 'Upcoming' },
  { id: 'past', label: 'Past' },
  { id: 'cancelled', label: 'Cancelled' },
];

const inTab = (b: Booking, tab: Tab) =>
  tab === 'cancelled' ? b.status === 'CANCELLED' : b.status !== 'CANCELLED' && (tab === 'past') === !!b.started;

export default function MyBookings() {
  const [tab, setTab] = useState<Tab>('upcoming');
  const [bookings, setBookings] = useState<Booking[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      setBookings(await api<Booking[]>('/bookings'));
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

  if (!bookings && !error) return <Loading />;
  // Upcoming reads soonest-first; past and cancelled newest-first (API order).
  const list = (bookings ?? []).filter((b) => inTab(b, tab));
  if (tab === 'upcoming') list.reverse();

  return (
    <FlatList
      data={list}
      keyExtractor={(b) => b.id}
      contentContainerStyle={{ padding: 16, gap: 12 }}
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
      ListHeaderComponent={
        <View style={{ marginBottom: 4 }}>
          <Segmented options={TABS} value={tab} onChange={setTab} />
          <ErrorBanner message={error} />
        </View>
      }
      ListEmptyComponent={
        <Empty
          icon="calendar-outline"
          title={tab === 'upcoming' ? 'No upcoming bookings' : tab === 'past' ? 'No past bookings' : 'No cancelled bookings'}
          subtitle={tab === 'upcoming' ? 'Find a ground and book your next game.' : undefined}
        />
      }
      renderItem={({ item }) => {
        const badge = bookingBadge(item);
        return (
          <Pressable style={({ pressed }) => [styles.card, pressed && { opacity: 0.9 }]} onPress={() => router.push({ pathname: '/ticket/[id]', params: { id: item.id } })}>
            <GroundArt seed={item.groundId} sportId={item.sportId} indoor={item.groundType === 'Indoor'} style={styles.image} />
            <View style={{ flex: 1, gap: 3 }}>
              <Text style={styles.name} numberOfLines={1}>
                {item.groundName}
              </Text>
              <Text style={styles.meta}>{prettyDate(item.date)}</Text>
              <Text style={styles.meta}>{slotRange(item.startHour)}</Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 2 }}>
                <Text style={styles.price}>{rupees(item.total)}</Text>
                <Badge label={badge.label} tone={badge.tone} />
              </View>
            </View>
            <Ionicons name="chevron-forward" size={18} color={colors.muted} />
          </Pressable>
        );
      }}
    />
  );
}

const styles = StyleSheet.create({
  card: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: '#fff', borderRadius: radius, padding: 10, ...shadow },
  image: { width: 96, height: 88, borderRadius: 10 },
  name: { fontSize: 15, fontWeight: '700', color: colors.text },
  meta: { color: colors.muted, fontSize: 12 },
  price: { fontSize: 15, fontWeight: '800', color: colors.text },
});
