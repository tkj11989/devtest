import * as SecureStore from "expo-secure-store";
import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { Platform } from "react-native";

import { api, setAuthToken, setUnauthorizedHandler, User } from "./api";

const TOKEN_KEY = "docsum_token";

// The session token lives in the iOS Keychain / Android Keystore via SecureStore.
// (Web has no SecureStore, so the Expo web build falls back to localStorage.)
const tokenStorage = {
  get: async () => (Platform.OS === "web" ? globalThis.localStorage?.getItem(TOKEN_KEY) ?? null : SecureStore.getItemAsync(TOKEN_KEY)),
  set: async (value: string) =>
    Platform.OS === "web" ? globalThis.localStorage?.setItem(TOKEN_KEY, value) : SecureStore.setItemAsync(TOKEN_KEY, value),
  clear: async () =>
    Platform.OS === "web" ? globalThis.localStorage?.removeItem(TOKEN_KEY) : SecureStore.deleteItemAsync(TOKEN_KEY),
};

type AuthState = {
  ready: boolean;
  user: User | null;
  signIn: (token: string, user: User) => Promise<void>;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [user, setUser] = useState<User | null>(null);

  const clearSession = useCallback(async () => {
    setAuthToken(null);
    setUser(null);
    await tokenStorage.clear().catch(() => {});
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => void clearSession());
    (async () => {
      try {
        const token = await tokenStorage.get();
        if (token) {
          setAuthToken(token);
          setUser(await api.me());
        }
      } catch {
        await clearSession();
      } finally {
        setReady(true);
      }
    })();
    return () => setUnauthorizedHandler(null);
  }, [clearSession]);

  const value = useMemo<AuthState>(
    () => ({
      ready,
      user,
      signIn: async (token, u) => {
        await tokenStorage.set(token);
        setAuthToken(token);
        setUser(u);
      },
      signOut: async () => {
        await api.logout().catch(() => {});
        await clearSession();
      },
    }),
    [ready, user, clearSession],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
