import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { Loading } from '../components/ui';
import { AuthProvider, useAuth } from '../lib/auth';
import { BookingDraftProvider } from '../lib/booking';
import { colors } from '../lib/theme';

function RootStack() {
  const { session, loading } = useAuth();
  if (loading) return <Loading />;
  const loggedIn = !!session;

  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: colors.primary },
        headerTintColor: '#fff',
        headerTitleStyle: { fontWeight: '700' },
        contentStyle: { backgroundColor: colors.bg },
      }}
    >
      <Stack.Protected guard={!loggedIn}>
        <Stack.Screen name="login" options={{ headerShown: false }} />
      </Stack.Protected>
      <Stack.Protected guard={loggedIn}>
        <Stack.Screen name="index" options={{ title: 'Choose a Sport' }} />
        <Stack.Screen name="spaces" options={{ title: 'Choose a Space' }} />
        <Stack.Screen name="slots" options={{ title: 'Date & Slot' }} />
        <Stack.Screen name="payment" options={{ title: 'Payment' }} />
        <Stack.Screen name="checkout" options={{ title: 'Pay Online', presentation: 'modal', gestureEnabled: false }} />
        <Stack.Screen name="confirmation" options={{ title: 'Booking Status', headerBackVisible: false, headerLeft: () => null, gestureEnabled: false }} />
        <Stack.Screen name="bookings" options={{ title: 'My Bookings' }} />
      </Stack.Protected>
    </Stack>
  );
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <AuthProvider>
        <BookingDraftProvider>
          <StatusBar style="light" />
          <RootStack />
        </BookingDraftProvider>
      </AuthProvider>
    </SafeAreaProvider>
  );
}
