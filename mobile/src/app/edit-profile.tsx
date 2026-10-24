import { router } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { Button, ErrorBanner } from '../components/ui';
import { api, type User } from '../lib/api';
import { useAuth } from '../lib/auth';
import { errorMessage, maskPhone } from '../lib/format';
import { colors, radius } from '../lib/theme';

export default function EditProfile() {
  const { user, setUser } = useAuth();
  const [name, setName] = useState(user?.name ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      setUser(await api<User>('/me', { method: 'PATCH', body: { name } }));
      router.back();
    } catch (e) {
      setError(errorMessage(e));
      setSaving(false);
    }
  }

  return (
    <View style={{ padding: 16, gap: 8 }}>
      <Text style={styles.label}>Full name</Text>
      <TextInput style={styles.input} value={name} onChangeText={setName} autoCapitalize="words" autoComplete="name" />
      <Text style={styles.label}>Mobile number</Text>
      <TextInput style={[styles.input, { color: colors.muted }]} value={user ? maskPhone(user.phone) : ''} editable={false} />
      <Text style={styles.hint}>Your mobile number is verified by OTP and can't be changed.</Text>
      <ErrorBanner message={error} />
      <Button title="Save" onPress={save} loading={saving} disabled={name.trim().length < 2} style={{ marginTop: 8 }} />
    </View>
  );
}

const styles = StyleSheet.create({
  label: { fontWeight: '600', color: colors.text, marginTop: 8 },
  input: { backgroundColor: '#fff', borderWidth: 1.5, borderColor: colors.border, borderRadius: radius, padding: 14, fontSize: 16, color: colors.text },
  hint: { color: colors.muted, fontSize: 12 },
});
