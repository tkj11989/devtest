import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { Loading } from '../components/ui';
import { AuthProvider, useAuth } from '../lib/auth';
import { BookingDraftProvider } from '../lib/booking';
import { PreferencesProvider } from '../lib/preferences';
import { colors } from '../lib/theme';

function RootStack() {
  const { session, loading } = useAuth();
  if (loading) return <Loading />;
  const loggedIn = !!session;

  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: '#fff' },
        headerTintColor: colors.text,
        headerTitleAlign: 'center',
        headerTitleStyle: { fontWeight: '700', fontSize: 17 },
        headerShadowVisible: false,
        headerBackButtonDisplayMode: 'minimal',
        contentStyle: { backgroundColor: colors.bg },
      }}
    >
      <Stack.Protected guard={!loggedIn}>
        <Stack.Screen name="login" options={{ headerShown: false }} />
      </Stack.Protected>
      <Stack.Protected guard={loggedIn}>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="grounds" options={{ title: 'Grounds' }} />
        <Stack.Screen name="ground/[id]" options={{ headerShown: false }} />
        <Stack.Screen name="select-slot" options={{ title: 'Select Date' }} />
        <Stack.Screen name="summary" options={{ title: 'Booking Summary' }} />
        <Stack.Screen name="payment" options={{ title: 'Payment' }} />
        <Stack.Screen name="checkout" options={{ title: 'Secure Checkout', presentation: 'modal', gestureEnabled: false }} />
        <Stack.Screen name="confirmation" options={{ headerShown: false, gestureEnabled: false }} />
        <Stack.Screen name="ticket/[id]" options={{ title: 'Booking Ticket' }} />
        <Stack.Screen name="notifications" options={{ title: 'Notifications' }} />
        <Stack.Screen name="payments-history" options={{ title: 'My Payments' }} />
        <Stack.Screen name="edit-profile" options={{ title: 'Edit Profile' }} />
        <Stack.Screen name="help" options={{ title: 'Help & Support' }} />
        <Stack.Screen
          name="owner/index"
          options={{
            title: 'Stadium Dashboard',
            headerStyle: { backgroundColor: colors.primary },
            headerTintColor: '#fff',
          }}
        />
        <Stack.Screen name="owner/slots" options={{ title: 'Manage Slots' }} />
      </Stack.Protected>
    </Stack>
  );
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <AuthProvider>
        <PreferencesProvider>
          <BookingDraftProvider>
            <StatusBar style="dark" />
            <RootStack />
          </BookingDraftProvider>
        </PreferencesProvider>
      </AuthProvider>
    </SafeAreaProvider>
  );
}
