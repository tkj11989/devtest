import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { api, qs, type Ground, type Sport } from '../lib/api';
import { errorMessage } from '../lib/format';
import { usePreferences } from '../lib/preferences';
import { colors } from '../lib/theme';
import { GroundListItem } from './GroundCard';
import { Chip, Empty, ErrorBanner } from './ui';

type Filter = 'All' | 'Turf' | 'Stadium' | 'Indoor' | 'Floodlight';
const FILTERS: Filter[] = ['All', 'Turf', 'Stadium', 'Indoor', 'Floodlight'];

type Props = {
  initialType?: string;
  nearMe?: boolean;
  autoFocus?: boolean;
  favoritesOnly?: boolean;
  showSports?: boolean; // let the user switch sport here (Explore tab)
};

export function GroundList({ initialType, nearMe: initialNear, autoFocus, favoritesOnly, showSports }: Props) {
  const { city, sport, setSport, coords, locate } = usePreferences();
  const [filter, setFilter] = useState<Filter>((FILTERS as string[]).includes(initialType ?? '') ? (initialType as Filter) : 'All');
  const [nearMe, setNearMe] = useState(!!initialNear);
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [sports, setSports] = useState<Sport[]>([]);
  const [grounds, setGrounds] = useState<Ground[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);

  useEffect(() => {
    if (showSports) api<Sport[]>(`/sports${qs({ city })}`).then(setSports, () => {});
  }, [showSports, city]);

  useEffect(() => {
    if (nearMe && !coords) {
      locate().then((c) => {
        if (!c) setError('Location permission denied — showing grounds by rating instead.');
      });
    }
  }, [nearMe, coords, locate]);

  useFocusEffect(
    useCallback(() => {
      let active = true;
      const path = `/grounds${qs({
        city: favoritesOnly ? undefined : city,
        sport: favoritesOnly ? undefined : sport,
        type: filter !== 'All' && filter !== 'Floodlight' ? filter : undefined,
        floodlights: filter === 'Floodlight' ? 1 : undefined,
        favorites: favoritesOnly ? 1 : undefined,
        q: debounced,
        lat: coords?.lat,
        lng: coords?.lng,
        sort: nearMe ? 'distance' : undefined,
      })}`;
      api<Ground[]>(path).then(
        (g) => active && (setGrounds(g), setError((e) => (e?.startsWith('Location') ? e : null))),
        (e) => active && setError(errorMessage(e)),
      );
      return () => {
        active = false;
      };
    }, [city, sport, filter, debounced, coords, nearMe, favoritesOnly]),
  );

  return (
    <FlatList
      data={grounds ?? []}
      keyExtractor={(g) => g.id}
      contentContainerStyle={{ padding: 16, gap: 12, paddingTop: 8 }}
      keyboardShouldPersistTaps="handled"
      ListHeaderComponent={
        <View style={{ gap: 12, marginBottom: 4 }}>
          <View style={styles.search}>
            <Ionicons name="search" size={18} color={colors.muted} />
            <TextInput
              style={styles.searchInput}
              value={query}
              onChangeText={setQuery}
              placeholder="Search by name or area..."
              placeholderTextColor={colors.muted}
              autoFocus={autoFocus}
              returnKeyType="search"
              clearButtonMode="while-editing"
            />
          </View>
          {showSports && (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
              {sports.map((s) => (
                <Chip key={s.id} label={`${s.icon} ${s.name}`} active={s.id === sport} onPress={() => setSport(s.id)} />
              ))}
            </ScrollView>
          )}
          {!favoritesOnly && (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
              <Chip label="Near Me" icon="navigate" active={nearMe} onPress={() => setNearMe((v) => !v)} />
              {FILTERS.map((f) => (
                <Chip key={f} label={f} active={f === filter} onPress={() => setFilter(f)} />
              ))}
            </ScrollView>
          )}
          <ErrorBanner message={error} />
          {!grounds && !error && <ActivityIndicator color={colors.primary} style={{ marginTop: 24 }} />}
        </View>
      }
      ListEmptyComponent={
        grounds ? (
          favoritesOnly ? (
            <Empty icon="heart-outline" title="No favorites yet" subtitle="Tap the heart on any ground to save it here." />
          ) : (
            <Empty icon="search" title="No grounds found" subtitle="Try another filter or search term." />
          )
        ) : undefined
      }
      renderItem={({ item }) => <GroundListItem ground={item} />}
    />
  );
}

const styles = StyleSheet.create({
  search: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: colors.disabled, borderRadius: 10, paddingHorizontal: 12 },
  searchInput: { flex: 1, paddingVertical: 11, fontSize: 14, color: colors.text },
});
