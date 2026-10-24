import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, Share, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { amenity } from '../../components/amenities';
import { GroundArt } from '../../components/GroundArt';
import { HeartButton } from '../../components/GroundCard';
import { Button, ErrorBanner, IconCircle, Loading, Rating } from '../../components/ui';
import { api, qs, type GroundDetails } from '../../lib/api';
import { useBookingDraft } from '../../lib/booking';
import { errorMessage, rupees, shortDate } from '../../lib/format';
import { usePreferences } from '../../lib/preferences';
import { colors, radius, shadow } from '../../lib/theme';

type Tab = 'overview' | 'photos' | 'reviews';
const PHOTOS = 4;

export default function GroundDetailsScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const { coords } = usePreferences();
  const { update } = useBookingDraft();
  const [ground, setGround] = useState<GroundDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [photo, setPhoto] = useState(0);
  const [tab, setTab] = useState<Tab>('overview');

  useEffect(() => {
    api<GroundDetails>(`/grounds/${id}${qs({ lat: coords?.lat, lng: coords?.lng })}`).then(setGround, (e) => setError(errorMessage(e)));
  }, [id, coords]);

  if (error) {
    return (
      <View style={{ padding: 16, paddingTop: insets.top + 16 }}>
        <ErrorBanner message={error} />
        <Button title="Go back" variant="outline" onPress={() => router.back()} />
      </View>
    );
  }
  if (!ground) return <Loading />;
  const indoor = ground.type === 'Indoor';

  return (
    <View style={{ flex: 1, backgroundColor: '#fff' }}>
      <ScrollView contentContainerStyle={{ paddingBottom: 24 }}>
        <View>
          <ScrollView
            horizontal
            pagingEnabled
            showsHorizontalScrollIndicator={false}
            onScroll={(e) => setPhoto(Math.round(e.nativeEvent.contentOffset.x / width))}
            scrollEventThrottle={64}
          >
            {Array.from({ length: PHOTOS }, (_, i) => (
              <GroundArt key={i} seed={ground.id} sportId={ground.sportId} indoor={indoor} variant={i} style={{ width, height: 260 }} />
            ))}
          </ScrollView>
          <View style={[styles.topBar, { top: insets.top + 8 }]}>
            <IconCircle name="chevron-back" label="Back" dark onPress={() => router.back()} />
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <View style={styles.heartCircle}>
                <HeartButton ground={ground} size={20} />
              </View>
              <IconCircle
                name="share-social-outline"
                label="Share"
                dark
                onPress={() =>
                  Share.share({ message: `${ground.name}, ${ground.area}, ${ground.cityName} — ${rupees(ground.pricePerHour)}/hour on Sports Space` })
                }
              />
            </View>
          </View>
          <View style={styles.photoDots}>
            {Array.from({ length: PHOTOS }, (_, i) => (
              <View key={i} style={[styles.photoDot, i === photo && { backgroundColor: '#fff', width: 16 }]} />
            ))}
          </View>
        </View>

        <View style={styles.body}>
          <Text style={styles.name}>{ground.name}</Text>
          <View style={styles.metaRow}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
              <Rating value={ground.rating} size={14} />
              <Text style={styles.muted}>({ground.reviewCount} reviews)</Text>
            </View>
            {ground.distanceKm !== null && (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
                <Ionicons name="navigate-outline" size={13} color={colors.muted} />
                <Text style={styles.muted}>{ground.distanceKm} km</Text>
              </View>
            )}
          </View>
          <View style={[styles.metaRow, { justifyContent: 'flex-start', gap: 4 }]}>
            <Ionicons name="location-outline" size={15} color={colors.muted} />
            <Text style={styles.muted}>
              {ground.area}, {ground.cityName}, {ground.state}
            </Text>
          </View>

          <View style={styles.quick}>
            {ground.amenities.slice(0, 4).map((a) => (
              <View key={a} style={styles.quickItem}>
                <MaterialCommunityIcons name={amenity(a).icon} size={22} color={colors.primary} />
                <Text style={styles.quickText} numberOfLines={1}>
                  {amenity(a).label}
                </Text>
              </View>
            ))}
          </View>

          <View style={styles.tabs}>
            {(['overview', 'photos', 'reviews'] as Tab[]).map((t) => (
              <Pressable key={t} style={[styles.tab, tab === t && styles.tabActive]} onPress={() => setTab(t)} accessibilityRole="tab">
                <Text style={[styles.tabText, tab === t && { color: colors.primary, fontWeight: '700' }]}>
                  {t === 'overview' ? 'Overview' : t === 'photos' ? 'Photos' : `Reviews (${ground.reviews.length})`}
                </Text>
              </Pressable>
            ))}
          </View>

          {tab === 'overview' && (
            <View>
              <Text style={styles.h2}>About</Text>
              <Text style={styles.about}>{ground.about}</Text>
              <Text style={styles.h2}>Facilities</Text>
              <View style={styles.facilities}>
                {ground.amenities.map((a) => (
                  <View key={a} style={styles.facility}>
                    <View style={styles.facilityIcon}>
                      <MaterialCommunityIcons name={amenity(a).icon} size={22} color={colors.text} />
                    </View>
                    <Text style={styles.facilityText}>{amenity(a).label}</Text>
                  </View>
                ))}
              </View>
              <Text style={styles.h2}>Pricing</Text>
              <Text style={styles.about}>
                Starts at <Text style={{ fontWeight: '800', color: colors.text }}>{rupees(ground.pricePerHour)}</Text> per hour · {ground.type}
                {ground.floodlights ? ' · Floodlit' : ''}
              </Text>
            </View>
          )}
          {tab === 'photos' && (
            <View style={styles.photoGrid}>
              {Array.from({ length: PHOTOS }, (_, i) => (
                <GroundArt key={i} seed={ground.id} sportId={ground.sportId} indoor={indoor} variant={i} style={styles.photoTile} />
              ))}
            </View>
          )}
          {tab === 'reviews' && (
            <View style={{ gap: 12, marginTop: 12 }}>
              {ground.reviews.map((r) => (
                <View key={r.id} style={styles.review}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                    <Text style={{ fontWeight: '700', color: colors.text }}>{r.name}</Text>
                    <Text style={styles.muted}>{shortDate(r.date)}</Text>
                  </View>
                  <View style={{ flexDirection: 'row', marginVertical: 4 }}>
                    {Array.from({ length: 5 }, (_, i) => (
                      <Ionicons key={i} name={i < r.rating ? 'star' : 'star-outline'} size={13} color={colors.star} />
                    ))}
                  </View>
                  <Text style={styles.about}>{r.comment}</Text>
                </View>
              ))}
            </View>
          )}
        </View>
      </ScrollView>

      <View style={[styles.footer, { paddingBottom: 12 + insets.bottom }]}>
        <Button
          title="Book Now"
          onPress={() => {
            update({ ground, date: undefined, slot: undefined, couponCode: undefined, quote: undefined, channel: undefined });
            router.push('/select-slot');
          }}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  topBar: { position: 'absolute', left: 16, right: 16, flexDirection: 'row', justifyContent: 'space-between' },
  heartCircle: { width: 38, height: 38, borderRadius: 19, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center' },
  photoDots: { position: 'absolute', bottom: 12, alignSelf: 'center', flexDirection: 'row', gap: 6 },
  photoDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.55)' },
  body: { padding: 16 },
  name: { fontSize: 22, fontWeight: '800', color: colors.text },
  metaRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 },
  muted: { color: colors.muted, fontSize: 13 },
  quick: { flexDirection: 'row', gap: 8, marginTop: 16 },
  quickItem: { flex: 1, alignItems: 'center', gap: 6, paddingVertical: 12, borderRadius: radius, backgroundColor: colors.primarySoft },
  quickText: { fontSize: 11, color: colors.text, fontWeight: '600' },
  tabs: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: colors.border, marginTop: 18 },
  tab: { flex: 1, alignItems: 'center', paddingVertical: 12, borderBottomWidth: 2, borderBottomColor: 'transparent', marginBottom: -1 },
  tabActive: { borderBottomColor: colors.primary },
  tabText: { color: colors.muted, fontWeight: '500' },
  h2: { fontSize: 16, fontWeight: '800', color: colors.text, marginTop: 18, marginBottom: 8 },
  about: { color: colors.muted, lineHeight: 20 },
  facilities: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  facility: { width: '18%', minWidth: 60, alignItems: 'center', gap: 6 },
  facilityIcon: { width: 48, height: 48, borderRadius: 12, borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center' },
  facilityText: { fontSize: 11, color: colors.text, textAlign: 'center' },
  photoGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 14 },
  photoTile: { width: '48%', height: 110, borderRadius: radius },
  review: { backgroundColor: '#fff', borderRadius: radius, padding: 14, ...shadow },
  footer: { paddingHorizontal: 16, paddingTop: 12, backgroundColor: '#fff', borderTopWidth: 1, borderColor: colors.border },
});
