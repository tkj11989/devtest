import { Ionicons } from '@expo/vector-icons';
import { router, type Href } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Card, type IconName } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { confirm } from '../../lib/confirm';
import { initials, maskPhone } from '../../lib/format';
import { colors } from '../../lib/theme';

const MENU: { icon: IconName; label: string; href: Href }[] = [
  { icon: 'calendar-outline', label: 'My Bookings', href: '/bookings' },
  { icon: 'card-outline', label: 'My Payments', href: '/payments-history' },
  { icon: 'heart-outline', label: 'My Favorites', href: { pathname: '/grounds', params: { favorites: '1' } } },
  { icon: 'notifications-outline', label: 'Notifications', href: '/notifications' },
  { icon: 'help-circle-outline', label: 'Help & Support', href: '/help' },
];

export default function Profile() {
  const { user, signOut } = useAuth();

  function logout() {
    confirm('Log out?', 'You will need to verify your number again to log in.', 'Logout', signOut);
  }

  return (
    <>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 16 }}>
        <Card style={styles.user}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{initials(user?.name || 'U')}</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.name}>{user?.name || 'Player'}</Text>
            <Text style={styles.phone}>{user && maskPhone(user.phone)}</Text>
          </View>
          <Pressable onPress={() => router.push('/edit-profile')} hitSlop={10} accessibilityLabel="Edit profile">
            <Ionicons name="settings-outline" size={22} color={colors.text} />
          </Pressable>
        </Card>

        {user?.isOwner && (
          <Pressable style={styles.owner} onPress={() => router.push('/owner')}>
            <Ionicons name="stats-chart" size={22} color="#fff" />
            <View style={{ flex: 1 }}>
              <Text style={{ color: '#fff', fontWeight: '800', fontSize: 15 }}>Stadium Dashboard</Text>
              <Text style={{ color: '#D8EFE0', fontSize: 12 }}>Bookings, revenue & slot management</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color="#fff" />
          </Pressable>
        )}

        {user?.isAdmin && (
          <Pressable style={[styles.owner, { backgroundColor: colors.text }]} onPress={() => router.push('/admin')}>
            <Ionicons name="shield-checkmark" size={22} color="#fff" />
            <View style={{ flex: 1 }}>
              <Text style={{ color: '#fff', fontWeight: '800', fontSize: 15 }}>Platform Admin</Text>
              <Text style={{ color: '#C9D2CD', fontSize: 12 }}>Platform fees & owner payouts</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color="#fff" />
          </Pressable>
        )}

        <Card style={{ paddingVertical: 4 }}>
          {MENU.map((m) => (
            <Pressable key={m.label} style={styles.item} onPress={() => router.push(m.href)}>
              <Ionicons name={m.icon} size={21} color={colors.text} />
              <Text style={styles.itemText}>{m.label}</Text>
              <Ionicons name="chevron-forward" size={18} color={colors.muted} />
            </Pressable>
          ))}
          <Pressable style={[styles.item, { borderBottomWidth: 0 }]} onPress={logout}>
            <Ionicons name="log-out-outline" size={21} color={colors.danger} />
            <Text style={[styles.itemText, { color: colors.danger }]}>Logout</Text>
          </Pressable>
        </Card>
        <Text style={styles.version}>Sports Space v1.0.0</Text>
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  user: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  avatar: { width: 60, height: 60, borderRadius: 30, backgroundColor: colors.primarySoft, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: colors.primary, fontSize: 22, fontWeight: '800' },
  name: { fontSize: 18, fontWeight: '800', color: colors.text },
  phone: { color: colors.muted, marginTop: 3 },
  owner: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: colors.primary, borderRadius: 12, padding: 16 },
  item: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 15, borderBottomWidth: 1, borderBottomColor: colors.border },
  itemText: { flex: 1, fontSize: 15, color: colors.text },
  version: { textAlign: 'center', color: colors.muted, fontSize: 12 },
});
