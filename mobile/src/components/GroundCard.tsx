import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { Ground } from '../lib/api';
import { useFavorite } from '../lib/favorites';
import { rupees } from '../lib/format';
import { colors, radius, shadow } from '../lib/theme';
import { GroundArt } from './GroundArt';
import { Rating } from './ui';

const open = (g: Ground) => router.push({ pathname: '/ground/[id]', params: { id: g.id } });

export function HeartButton({ ground, size = 18, onImage }: { ground: Ground; size?: number; onImage?: boolean }) {
  const { isFavorite, toggle } = useFavorite(ground);
  return (
    <Pressable
      onPress={toggle}
      hitSlop={8}
      accessibilityLabel={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
      style={onImage ? styles.heartOnImage : undefined}
    >
      <Ionicons name={isFavorite ? 'heart' : 'heart-outline'} size={size} color={isFavorite ? '#E53950' : onImage ? '#fff' : colors.muted} />
    </Pressable>
  );
}

// Image on the left, details on the right (Ground Listing).
export function GroundListItem({ ground }: { ground: Ground }) {
  return (
    <Pressable style={({ pressed }) => [styles.item, pressed && { opacity: 0.9 }]} onPress={() => open(ground)}>
      <View>
        <GroundArt seed={ground.id} sportId={ground.sportId} indoor={ground.type === 'Indoor'} style={styles.itemImage} />
        <View style={styles.itemHeart}>
          <HeartButton ground={ground} size={16} onImage />
        </View>
      </View>
      <View style={{ flex: 1, gap: 4 }}>
        <Text style={styles.name} numberOfLines={1}>
          {ground.name}
        </Text>
        <Rating value={ground.rating} count={ground.reviewCount} size={12} />
        <View style={styles.loc}>
          <Ionicons name="location-outline" size={13} color={colors.muted} />
          <Text style={styles.locText} numberOfLines={1}>
            {ground.area}, {ground.cityName}
            {ground.distanceKm !== null ? ` · ${ground.distanceKm} km` : ''}
          </Text>
        </View>
        <Text style={styles.price}>
          {rupees(ground.pricePerHour)} <Text style={styles.per}>/hour</Text>
        </Text>
      </View>
    </Pressable>
  );
}

// Large card with the image on top (Popular Grounds on Home).
export function GroundFeatureCard({ ground, width }: { ground: Ground; width?: number }) {
  return (
    <Pressable style={({ pressed }) => [styles.feature, width ? { width } : null, pressed && { opacity: 0.9 }]} onPress={() => open(ground)}>
      <GroundArt seed={ground.id} sportId={ground.sportId} indoor={ground.type === 'Indoor'} variant={1} style={styles.featureImage} />
      <View style={styles.featureHeart}>
        <HeartButton ground={ground} size={18} onImage />
      </View>
      <View style={{ padding: 12, gap: 4 }}>
        <Text style={styles.name} numberOfLines={1}>
          {ground.name}
        </Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 }}>
            <Rating value={ground.rating} size={12} />
            <Text style={styles.locText} numberOfLines={1}>
              {ground.area}, {ground.cityName}
            </Text>
          </View>
          <Text style={styles.price}>
            {rupees(ground.pricePerHour)} <Text style={styles.per}>/hour</Text>
          </Text>
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  item: { flexDirection: 'row', gap: 12, backgroundColor: colors.card, borderRadius: radius, padding: 10, ...shadow },
  itemImage: { width: 112, height: 92, borderRadius: 10 },
  itemHeart: { position: 'absolute', top: 6, right: 6 },
  heartOnImage: { backgroundColor: 'rgba(0,0,0,0.3)', borderRadius: 14, padding: 4 },
  name: { fontSize: 15, fontWeight: '700', color: colors.text },
  loc: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  locText: { fontSize: 12, color: colors.muted, flexShrink: 1 },
  price: { fontSize: 16, fontWeight: '800', color: colors.text, marginTop: 2 },
  per: { fontSize: 12, fontWeight: '400', color: colors.muted },
  feature: { backgroundColor: colors.card, borderRadius: radius, overflow: 'hidden', ...shadow },
  featureImage: { width: '100%', height: 150 },
  featureHeart: { position: 'absolute', top: 10, right: 10 },
});
