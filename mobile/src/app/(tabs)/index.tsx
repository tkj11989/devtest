import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { GroundFeatureCard } from '../../components/GroundCard';
import { GroundArt } from '../../components/GroundArt';
import { Sheet } from '../../components/Sheet';
import { ErrorBanner } from '../../components/ui';
import { api, qs, type AppNotification, type City, type Ground, type Sport } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { errorMessage, initials } from '../../lib/format';
import { usePreferences } from '../../lib/preferences';
import { colors, shadow } from '../../lib/theme';

const CATEGORIES = [
  { label: 'Near Me', icon: 'map-marker-radius-outline', params: { near: '1' } },
  { label: 'Turf', icon: 'grass', params: { type: 'Turf' } },
  { label: 'Stadium', icon: 'stadium-variant', params: { type: 'Stadium' } },
  { label: 'Indoor', icon: 'home-roof', params: { type: 'Indoor' } },
] as const;

const SLIDES = [
  { title: (s: string) => `Play ${s}\nBook Your Ground`, sub: 'Find and book the best grounds in your city' },
  { title: () => 'Floodlit Night\nMatches', sub: 'Grounds open till 11 PM with pro floodlights' },
  { title: () => '₹100 Off Your\nFirst Booking', sub: 'Use code FIRST100 at checkout' },
];

export default function Home() {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const { user } = useAuth();
  const { city, sport, setCity, setSport } = usePreferences();
  const [cities, setCities] = useState<City[]>([]);
  const [sports, setSports] = useState<Sport[]>([]);
  const [grounds, setGrounds] = useState<Ground[] | null>(null);
  const [unread, setUnread] = useState(0);
  const [slide, setSlide] = useState(0);
  const [cityPicker, setCityPicker] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      let active = true;
      Promise.all([
        api<City[]>('/cities'),
        api<Sport[]>(`/sports${qs({ city })}`),
        api<Ground[]>(`/grounds${qs({ city, sport })}`),
        api<AppNotification[]>('/notifications'),
      ]).then(
        ([c, s, g, n]) => {
          if (!active) return;
          setCities(c);
          setSports(s);
          setGrounds(g);
          setUnread(n.filter((x) => !x.read).length);
          setError(null);
        },
        (e) => active && setError(errorMessage(e)),
      );
      return () => {
        active = false;
      };
    }, [city, sport]),
  );

  const cityName = cities.find((c) => c.id === city)?.name ?? 'Jaipur';
  const sportName = sports.find((s) => s.id === sport)?.name ?? 'Cricket';
  const bannerWidth = width - 32;

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.bg }} contentContainerStyle={{ paddingBottom: 24 }}>
      <View style={[styles.header, { paddingTop: insets.top + 10 }]}>
        <View style={styles.headerRow}>
          <Pressable style={styles.city} onPress={() => setCityPicker(true)} accessibilityLabel="Change city">
            <Ionicons name="location-sharp" size={18} color="#fff" />
            <Text style={styles.cityText}>{cityName}</Text>
            <Ionicons name="chevron-down" size={16} color="#fff" />
          </Pressable>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 16 }}>
            <Pressable onPress={() => router.push('/notifications')} accessibilityLabel="Notifications" hitSlop={8}>
              <Ionicons name="notifications-outline" size={23} color="#fff" />
              {unread > 0 && <View style={styles.dot} />}
            </Pressable>
            <Pressable onPress={() => router.navigate('/profile')} accessibilityLabel="Profile" style={styles.avatar}>
              <Text style={styles.avatarText}>{initials(user?.name || 'U')}</Text>
            </Pressable>
          </View>
        </View>
        <Pressable style={styles.search} onPress={() => router.push({ pathname: '/grounds', params: { focus: '1' } })}>
          <Ionicons name="search" size={18} color={colors.muted} />
          <Text style={styles.searchText}>Search stadiums, locations...</Text>
        </Pressable>
      </View>

      <View style={{ paddingHorizontal: 16, marginTop: 16 }}>
        <ErrorBanner message={error} />
        <ScrollView
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          onMomentumScrollEnd={(e) => setSlide(Math.round(e.nativeEvent.contentOffset.x / bannerWidth))}
          onScroll={(e) => setSlide(Math.round(e.nativeEvent.contentOffset.x / bannerWidth))}
          scrollEventThrottle={64}
          style={{ borderRadius: 14 }}
        >
          {SLIDES.map((s, i) => (
            <Pressable key={i} style={{ width: bannerWidth, height: 180 }} onPress={() => router.push('/grounds')}>
              <GroundArt seed={`banner${i}`} sportId={sport} variant={i} style={StyleSheet.absoluteFill} />
              <View style={styles.bannerShade} />
              <View style={styles.bannerText}>
                <Text style={styles.bannerTitle}>{s.title(sportName)}</Text>
                <Text style={styles.bannerSub}>{s.sub}</Text>
              </View>
            </Pressable>
          ))}
        </ScrollView>
        <View style={styles.dots}>
          {SLIDES.map((_, i) => (
            <View key={i} style={[styles.pageDot, i === slide && styles.pageDotActive]} />
          ))}
        </View>
      </View>

      <Text style={styles.section}>Choose Sport</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 16, gap: 10 }}>
        {sports.map((s) => {
          const active = s.id === sport;
          return (
            <Pressable
              key={s.id}
              onPress={() => setSport(s.id)}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              style={[styles.sport, active && styles.sportActive]}
            >
              <Text style={{ fontSize: 22 }}>{s.icon}</Text>
              <Text style={[styles.sportText, active && { color: colors.primary }]}>{s.name}</Text>
            </Pressable>
          );
        })}
      </ScrollView>

      <View style={styles.categories}>
        {CATEGORIES.map((c) => (
          <Pressable key={c.label} style={styles.category} onPress={() => router.push({ pathname: '/grounds', params: c.params })}>
            <View style={styles.categoryIcon}>
              <MaterialCommunityIcons name={c.icon} size={26} color={colors.primary} />
            </View>
            <Text style={styles.categoryText}>{c.label}</Text>
          </Pressable>
        ))}
      </View>

      <View style={styles.sectionRow}>
        <Text style={[styles.section, { marginTop: 0, marginBottom: 0 }]}>Popular Grounds</Text>
        <Pressable onPress={() => router.push('/grounds')} hitSlop={8}>
          <Text style={styles.viewAll}>View All</Text>
        </Pressable>
      </View>
      <View style={{ paddingHorizontal: 16, gap: 14 }}>
        {grounds?.length === 0 && <Text style={{ color: colors.muted }}>No {sportName.toLowerCase()} grounds in {cityName} yet.</Text>}
        {grounds?.slice(0, 3).map((g) => <GroundFeatureCard key={g.id} ground={g} />)}
      </View>

      <Sheet visible={cityPicker} onClose={() => setCityPicker(false)} title="Select City">
        {cities.map((c) => (
          <Pressable
            key={c.id}
            style={styles.cityOption}
            onPress={() => {
              setCity(c.id);
              setCityPicker(false);
            }}
          >
            <Ionicons name="location-outline" size={20} color={colors.primary} />
            <Text style={{ flex: 1, fontSize: 16, color: colors.text }}>
              {c.name}, <Text style={{ color: colors.muted }}>{c.state}</Text>
            </Text>
            {c.id === city && <Ionicons name="checkmark-circle" size={22} color={colors.primary} />}
          </Pressable>
        ))}
      </Sheet>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  header: { backgroundColor: colors.primary, paddingHorizontal: 16, paddingBottom: 16, borderBottomLeftRadius: 20, borderBottomRightRadius: 20 },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 },
  city: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  cityText: { color: '#fff', fontSize: 17, fontWeight: '700' },
  dot: { position: 'absolute', top: 1, right: 2, width: 9, height: 9, borderRadius: 5, backgroundColor: '#FFB020', borderWidth: 1.5, borderColor: colors.primary },
  avatar: { width: 34, height: 34, borderRadius: 17, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: colors.primary, fontWeight: '800', fontSize: 13 },
  search: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#fff', borderRadius: 10, paddingHorizontal: 14, paddingVertical: 12 },
  searchText: { color: colors.muted, fontSize: 14 },
  bannerShade: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(0,0,0,0.25)' },
  bannerText: { position: 'absolute', left: 18, bottom: 18, right: 18 },
  bannerTitle: { color: '#fff', fontSize: 24, fontWeight: '800', lineHeight: 30 },
  bannerSub: { color: '#E8F3EC', marginTop: 6, fontSize: 13 },
  dots: { flexDirection: 'row', justifyContent: 'center', gap: 6, marginTop: 10 },
  pageDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#C8D2CC' },
  pageDotActive: { width: 18, backgroundColor: colors.primary },
  section: { fontSize: 17, fontWeight: '800', color: colors.text, marginHorizontal: 16, marginTop: 18, marginBottom: 10 },
  sectionRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginHorizontal: 16, marginTop: 22, marginBottom: 12 },
  viewAll: { color: colors.primary, fontWeight: '700' },
  sport: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 22, backgroundColor: '#fff', borderWidth: 1.5, borderColor: colors.border },
  sportActive: { borderColor: colors.primary, backgroundColor: colors.primarySoft },
  sportText: { fontWeight: '700', color: colors.text },
  categories: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 16, marginTop: 18 },
  category: { alignItems: 'center', gap: 6, width: '23%' },
  categoryIcon: { width: 60, height: 60, borderRadius: 14, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', ...shadow },
  categoryText: { fontSize: 12, fontWeight: '600', color: colors.text },
  cityOption: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.border },
});
