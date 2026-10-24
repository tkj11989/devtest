import { router, Stack, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { ErrorBanner, Loading } from '../components/ui';
import { api, type Sport } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useBookingDraft } from '../lib/booking';
import { maskPhone } from '../lib/format';
import { colors, radius } from '../lib/theme';

export default function SportSelect() {
  const { session, signOut } = useAuth();
  const { update, reset } = useBookingDraft();
  const [sports, setSports] = useState<Sport[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      reset();
      api<Sport[]>('/sports').then(setSports, (e) => setError(e.message));
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []),
  );

  const confirmLogout = () =>
    Alert.alert('Log out?', undefined, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Log out', style: 'destructive', onPress: signOut },
    ]);

  return (
    <>
      <Stack.Screen
        options={{
          headerRight: () => (
            <Pressable onPress={() => router.push('/bookings')} hitSlop={10}>
              <Text style={styles.headerLink}>My Bookings</Text>
            </Pressable>
          ),
        }}
      />
      {!sports && !error ? (
        <Loading />
      ) : (
        <FlatList
          data={sports ?? []}
          keyExtractor={(s) => s.id}
          numColumns={2}
          columnWrapperStyle={{ gap: 12 }}
          contentContainerStyle={{ padding: 16, gap: 12 }}
          ListHeaderComponent={
            <View style={{ marginBottom: 4 }}>
              <Text style={styles.greet}>Hi {session && maskPhone(session.phone)} 👋</Text>
              <Text style={styles.heading}>What would you like to play?</Text>
              <ErrorBanner message={error} />
            </View>
          }
          renderItem={({ item }) => (
            <Pressable
              style={({ pressed }) => [styles.tile, pressed && { opacity: 0.8 }]}
              onPress={() => {
                update({ sport: item });
                router.push('/spaces');
              }}
            >
              <Text style={styles.icon}>{item.icon}</Text>
              <Text style={styles.name}>{item.name}</Text>
              <Text style={styles.count}>
                {item.spaceCount} {item.spaceCount === 1 ? 'venue' : 'venues'}
              </Text>
            </Pressable>
          )}
          ListFooterComponent={
            <Pressable onPress={confirmLogout} style={{ alignItems: 'center', padding: 24 }}>
              <Text style={{ color: colors.muted }}>Log out</Text>
            </Pressable>
          }
        />
      )}
    </>
  );
}

const styles = StyleSheet.create({
  headerLink: { color: '#fff', fontWeight: '700' },
  greet: { color: colors.muted, fontSize: 14 },
  heading: { fontSize: 22, fontWeight: '800', color: colors.text, marginTop: 4 },
  tile: {
    flex: 1,
    backgroundColor: colors.card,
    borderRadius: radius,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: 24,
    alignItems: 'center',
  },
  icon: { fontSize: 44 },
  name: { fontSize: 17, fontWeight: '700', color: colors.text, marginTop: 10 },
  count: { color: colors.muted, marginTop: 4, fontSize: 13 },
});
