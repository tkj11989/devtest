import * as Location from 'expo-location';
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

type Coords = { lat: number; lng: number };
type Prefs = {
  city: string;
  sport: string;
  coords: Coords | null;
  setCity: (id: string) => void;
  setSport: (id: string) => void;
  // Asks for location permission if needed; resolves null when denied.
  locate: () => Promise<Coords | null>;
};

const PrefsContext = createContext<Prefs | null>(null);

export function PreferencesProvider({ children }: { children: ReactNode }) {
  const [city, setCity] = useState('jaipur');
  const [sport, setSport] = useState('cricket');
  const [coords, setCoords] = useState<Coords | null>(null);

  const locate = useCallback(async () => {
    if (coords) return coords;
    try {
      const { granted } = await Location.requestForegroundPermissionsAsync();
      if (!granted) return null;
      const pos = (await Location.getLastKnownPositionAsync()) ?? (await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }));
      const c = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      setCoords(c);
      return c;
    } catch {
      return null;
    }
  }, [coords]);

  const value = useMemo(() => ({ city, sport, coords, setCity, setSport, locate }), [city, sport, coords, locate]);
  return <PrefsContext.Provider value={value}>{children}</PrefsContext.Provider>;
}

export function usePreferences() {
  const ctx = useContext(PrefsContext);
  if (!ctx) throw new Error('usePreferences must be used inside PreferencesProvider');
  return ctx;
}
