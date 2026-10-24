import type { ComponentProps } from 'react';
import type { MaterialCommunityIcons } from '@expo/vector-icons';

type MciName = ComponentProps<typeof MaterialCommunityIcons>['name'];

export const AMENITIES: Record<string, { label: string; icon: MciName }> = {
  turf: { label: 'Turf Pitch', icon: 'grass' },
  floodlights: { label: 'Floodlights', icon: 'lightbulb-on-outline' },
  parking: { label: 'Parking', icon: 'parking' },
  washroom: { label: 'Washroom', icon: 'human-male-female' },
  seating: { label: 'Seating', icon: 'seat-outline' },
  ac: { label: 'Air Conditioned', icon: 'air-conditioner' },
  'wooden court': { label: 'Wooden Court', icon: 'view-grid-outline' },
};

export const amenity = (id: string) => AMENITIES[id] ?? { label: id, icon: 'check-circle-outline' as MciName };
