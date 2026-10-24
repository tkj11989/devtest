import * as SecureStore from 'expo-secure-store';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Platform } from 'react-native';
import { setAuthToken, setUnauthorizedHandler } from './api';

const KEY = 'sports-space.session';

// SecureStore is native-only; use localStorage when running on web.
const storage = {
  get: () => (Platform.OS === 'web' ? Promise.resolve(globalThis.localStorage?.getItem(KEY) ?? null) : SecureStore.getItemAsync(KEY)),
  set: (v: string) => (Platform.OS === 'web' ? Promise.resolve(globalThis.localStorage?.setItem(KEY, v)) : SecureStore.setItemAsync(KEY, v)),
  clear: () => (Platform.OS === 'web' ? Promise.resolve(globalThis.localStorage?.removeItem(KEY)) : SecureStore.deleteItemAsync(KEY)),
};

type Session = { token: string; phone: string };
type AuthState = {
  session: Session | null;
  loading: boolean;
  signIn: (s: Session) => Promise<void>;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  const signOut = useCallback(async () => {
    setAuthToken(null);
    setSession(null);
    await storage.clear();
  }, []);

  const signIn = useCallback(async (s: Session) => {
    setAuthToken(s.token);
    setSession(s);
    await storage.set(JSON.stringify(s));
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(signOut);
    storage
      .get()
      .then((raw) => {
        if (!raw) return;
        const s = JSON.parse(raw) as Session;
        setAuthToken(s.token);
        setSession(s);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [signOut]);

  const value = useMemo(() => ({ session, loading, signIn, signOut }), [session, loading, signIn, signOut]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
