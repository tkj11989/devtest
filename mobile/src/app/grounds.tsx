import { Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { GroundList } from '../components/GroundList';
import { api, type Sport } from '../lib/api';
import { usePreferences } from '../lib/preferences';

export default function Grounds() {
  const params = useLocalSearchParams<{ type?: string; near?: string; focus?: string; favorites?: string }>();
  const { sport } = usePreferences();
  const [sportName, setSportName] = useState('');
  const favorites = params.favorites === '1';

  useEffect(() => {
    api<Sport[]>('/sports').then((s) => setSportName(s.find((x) => x.id === sport)?.name ?? ''), () => {});
  }, [sport]);

  return (
    <>
      <Stack.Screen options={{ title: favorites ? 'My Favorites' : `${sportName} Grounds` }} />
      <GroundList initialType={params.type} nearMe={params.near === '1'} autoFocus={params.focus === '1'} favoritesOnly={favorites} />
    </>
  );
}
