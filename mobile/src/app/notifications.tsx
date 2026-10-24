import { Ionicons } from '@expo/vector-icons';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { Empty, ErrorBanner, Loading } from '../components/ui';
import { api, type AppNotification } from '../lib/api';
import { errorMessage } from '../lib/format';
import { colors, radius, shadow } from '../lib/theme';

const ago = (iso: string) => {
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins} min ago`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)} h ago`;
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
};

// In-app copy of every booking SMS the user was sent.
export default function Notifications() {
  const [items, setItems] = useState<AppNotification[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      api<AppNotification[]>('/notifications').then(
        (n) => {
          setItems(n);
          if (n.some((x) => !x.read)) api('/notifications/read', { body: {} }).catch(() => {});
        },
        (e) => setError(errorMessage(e)),
      );
    }, []),
  );

  if (!items && !error) return <Loading />;
  return (
    <FlatList
      data={items ?? []}
      keyExtractor={(n) => n.id}
      contentContainerStyle={{ padding: 16, gap: 10 }}
      ListHeaderComponent={<ErrorBanner message={error} />}
      ListEmptyComponent={<Empty icon="notifications-outline" title="No notifications yet" subtitle="Booking confirmations and updates will show up here." />}
      renderItem={({ item }) => {
        const cancelled = item.title.toLowerCase().includes('cancel');
        return (
          <Pressable
            style={[styles.item, !item.read && styles.unread]}
            onPress={() => item.bookingId && router.push({ pathname: '/ticket/[id]', params: { id: item.bookingId } })}
          >
            <View style={[styles.icon, cancelled && { backgroundColor: colors.dangerSoft }]}>
              <Ionicons name={cancelled ? 'close-circle-outline' : 'checkmark-circle-outline'} size={22} color={cancelled ? colors.danger : colors.primary} />
            </View>
            <View style={{ flex: 1, gap: 3 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <Text style={styles.title}>{item.title}</Text>
                <Text style={styles.time}>{ago(item.createdAt)}</Text>
              </View>
              <Text style={styles.message}>{item.message}</Text>
            </View>
          </Pressable>
        );
      }}
    />
  );
}

const styles = StyleSheet.create({
  item: { flexDirection: 'row', gap: 12, backgroundColor: '#fff', padding: 14, borderRadius: radius, ...shadow },
  unread: { borderLeftWidth: 3, borderLeftColor: colors.primary },
  icon: { width: 40, height: 40, borderRadius: 20, backgroundColor: colors.primarySoft, alignItems: 'center', justifyContent: 'center' },
  title: { fontWeight: '700', color: colors.text },
  time: { color: colors.muted, fontSize: 12 },
  message: { color: colors.muted, fontSize: 13, lineHeight: 18 },
});
