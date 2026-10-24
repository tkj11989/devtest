import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, Text, View } from 'react-native';
import { colors } from '../lib/theme';
import { GroundArt } from './GroundArt';

// Thumbnail + name + location, used at the top of booking cards.
export function GroundHeader({
  id,
  sportId,
  indoor,
  name,
  location,
  size = 72,
}: {
  id: string;
  sportId: string;
  indoor?: boolean;
  name: string;
  location: string;
  size?: number;
}) {
  return (
    <View style={styles.row}>
      <GroundArt seed={id} sportId={sportId} indoor={indoor} style={{ width: size * 1.25, height: size, borderRadius: 10 }} />
      <View style={{ flex: 1, gap: 4 }}>
        <Text style={styles.name}>{name}</Text>
        <View style={styles.loc}>
          <Ionicons name="location-outline" size={13} color={colors.muted} />
          <Text style={styles.locText}>{location}</Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  name: { fontSize: 16, fontWeight: '800', color: colors.text },
  loc: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  locText: { color: colors.muted, fontSize: 13, flexShrink: 1 },
});
