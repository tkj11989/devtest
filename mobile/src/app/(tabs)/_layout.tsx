import { Ionicons } from '@expo/vector-icons';
import { Tabs } from 'expo-router/js-tabs';
import type { ColorValue } from 'react-native';
import type { IconName } from '../../components/ui';
import { colors } from '../../lib/theme';

const icon =
  (outline: IconName, filled: IconName) =>
  ({ focused, color }: { focused: boolean; color: ColorValue }) => <Ionicons name={focused ? filled : outline} size={22} color={color as string} />;

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.muted,
        tabBarLabelStyle: { fontSize: 11, fontWeight: '600' },
        tabBarStyle: { borderTopColor: colors.border },
        headerTitleAlign: 'center',
        headerTitleStyle: { fontWeight: '700', fontSize: 17, color: colors.text },
        headerShadowVisible: false,
        sceneStyle: { backgroundColor: colors.bg },
      }}
    >
      <Tabs.Screen name="index" options={{ title: 'Home', headerShown: false, tabBarIcon: icon('home-outline', 'home') }} />
      <Tabs.Screen name="bookings" options={{ title: 'Bookings', headerTitle: 'My Bookings', tabBarIcon: icon('calendar-outline', 'calendar') }} />
      <Tabs.Screen name="explore" options={{ title: 'Explore', headerTitle: 'Explore Grounds', tabBarIcon: icon('search-outline', 'search') }} />
      <Tabs.Screen name="profile" options={{ title: 'Profile', headerTitle: 'Profile', tabBarIcon: icon('person-outline', 'person') }} />
    </Tabs>
  );
}
