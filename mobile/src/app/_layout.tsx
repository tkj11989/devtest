import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { Loading, Screen, useTheme } from "../components/ui";
import { AuthProvider, useAuth } from "../lib/auth";

function RootStack() {
  const { ready, user } = useAuth();
  const t = useTheme();

  if (!ready) {
    return (
      <Screen scroll={false}>
        <Loading label="Loading…" />
      </Screen>
    );
  }

  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: t.card },
        headerTintColor: t.accent,
        headerTitleStyle: { color: t.text },
        contentStyle: { backgroundColor: t.bg },
      }}
    >
      {/* Everything except login requires a session; expo-router redirects automatically. */}
      <Stack.Protected guard={!user}>
        <Stack.Screen name="login" options={{ title: "Log in", headerShown: false }} />
      </Stack.Protected>
      <Stack.Protected guard={!!user}>
        <Stack.Screen name="index" options={{ title: "Documents" }} />
        <Stack.Screen name="doc/[id]/index" options={{ title: "Sections" }} />
        <Stack.Screen name="doc/[id]/summary" options={{ title: "Summary" }} />
        <Stack.Screen name="ask" options={{ title: "Ask questions" }} />
      </Stack.Protected>
    </Stack>
  );
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <AuthProvider>
        <StatusBar style="auto" />
        <RootStack />
      </AuthProvider>
    </SafeAreaProvider>
  );
}
