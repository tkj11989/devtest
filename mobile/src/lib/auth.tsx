import * as SecureStore from 'expo-secure-store';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Platform } from 'react-native';
import { api, setAuthToken, setUnauthorizedHandler, type User } from './api';

const KEY = 'sports-space.session';

// SecureStore is native-only; use localStorage when running on web.
const storage = {
  get: () => (Platform.OS === 'web' ? Promise.resolve(globalThis.localStorage?.getItem(KEY) ?? null) : SecureStore.getItemAsync(KEY)),
  set: (v: string) => (Platform.OS === 'web' ? Promise.resolve(globalThis.localStorage?.setItem(KEY, v)) : SecureStore.setItemAsync(KEY, v)),
  clear: () => (Platform.OS === 'web' ? Promise.resolve(globalThis.localStorage?.removeItem(KEY)) : SecureStore.deleteItemAsync(KEY)),
};

type Session = { token: string; user: User };
type AuthState = {
  session: Session | null;
  user: User | null;
  loading: boolean;
  signIn: (s: Session) => Promise<void>;
  signOut: () => Promise<void>;
  setUser: (u: User) => void;
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

  const setUser = useCallback((user: User) => {
    setSession((s) => {
      if (!s) return s;
      const next = { ...s, user };
      storage.set(JSON.stringify(next)).catch(() => {});
      return next;
    });
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(signOut);
    storage
      .get()
      .then((raw) => {
        if (!raw) return;
        const s = JSON.parse(raw) as Session;
        if (!s.user) return; // session saved by an older app version
        setAuthToken(s.token);
        setSession(s);
        // Refresh profile in the background (name, favorites, owner flag).
        api<User>('/me').then(setUser, () => {});
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [signOut, setUser]);

  const value = useMemo(
    () => ({ session, user: session?.user ?? null, loading, signIn, signOut, setUser }),
    [session, loading, signIn, signOut, setUser],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
