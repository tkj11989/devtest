import { Redirect, router, Stack } from 'expo-router';
import { useEffect, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { ErrorBanner, Loading } from '../components/ui';
import { api, type Space } from '../lib/api';
import { useBookingDraft } from '../lib/booking';
import { rupees } from '../lib/format';
import { colors, radius } from '../lib/theme';

const hour12 = (h: number) => `${h % 12 || 12}${h < 12 || h === 24 ? 'am' : 'pm'}`;

export default function SpaceSelect() {
  const { draft, update } = useBookingDraft();
  const [spaces, setSpaces] = useState<Space[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sport = draft.sport;

  useEffect(() => {
    if (sport) api<Space[]>(`/sports/${sport.id}/spaces`).then(setSpaces, (e) => setError(e.message));
  }, [sport]);

  if (!sport) return <Redirect href="/" />;
  if (!spaces && !error) return <Loading />;

  return (
    <>
      <Stack.Screen options={{ title: `${sport.icon} ${sport.name}` }} />
      <FlatList
        data={spaces ?? []}
        keyExtractor={(s) => s.id}
        contentContainerStyle={{ padding: 16, gap: 12 }}
        ListHeaderComponent={<ErrorBanner message={error} />}
        ListEmptyComponent={!error ? <Text style={styles.empty}>No venues for {sport.name} yet.</Text> : undefined}
        renderItem={({ item }) => (
          <Pressable
            style={({ pressed }) => [styles.card, pressed && { opacity: 0.85 }]}
            onPress={() => {
              update({ space: item, date: undefined, slot: undefined });
              router.push('/slots');
            }}
          >
            <View style={styles.thumb}>
              <Text style={{ fontSize: 30 }}>{sport.icon}</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.name}>{item.name}</Text>
              <Text style={styles.meta}>📍 {item.location}</Text>
              <Text style={styles.meta}>
                🕒 {hour12(item.openHour)} – {hour12(item.closeHour)}
              </Text>
            </View>
            <View style={{ alignItems: 'flex-end' }}>
              <Text style={styles.price}>{rupees(item.pricePerSlot)}</Text>
              <Text style={styles.per}>per hour</Text>
            </View>
          </Pressable>
        )}
      />
    </>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: colors.card,
    borderRadius: radius,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 14,
  },
  thumb: { width: 60, height: 60, borderRadius: 12, backgroundColor: colors.primarySoft, alignItems: 'center', justifyContent: 'center' },
  name: { fontSize: 16, fontWeight: '700', color: colors.text },
  meta: { color: colors.muted, marginTop: 3, fontSize: 13 },
  price: { fontSize: 17, fontWeight: '800', color: colors.primary },
  per: { color: colors.muted, fontSize: 12 },
  empty: { textAlign: 'center', color: colors.muted, marginTop: 40 },
});
