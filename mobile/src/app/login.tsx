import { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { GroundArt } from '../components/GroundArt';
import { OtpForm } from '../components/OtpForm';
import { Button, ErrorBanner } from '../components/ui';
import { api, ApiError, setAuthToken, type User } from '../lib/api';
import { useAuth } from '../lib/auth';
import { errorMessage } from '../lib/format';
import { colors, radius } from '../lib/theme';

type SendOtpResponse = { phone: string; resendInSeconds: number; devOtp?: string };
type Step =
  | { kind: 'phone' }
  | { kind: 'otp'; phone: string; resendIn: number; devOtp?: string }
  | { kind: 'name'; token: string; user: User };

export default function Login() {
  const { signIn } = useAuth();
  const insets = useSafeAreaInsets();
  const [step, setStep] = useState<Step>({ kind: 'phone' });
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const validPhone = /^[6-9]\d{9}$/.test(phone);

  async function sendOtp() {
    setLoading(true);
    setError(null);
    try {
      const res = await api<SendOtpResponse>('/auth/send-otp', { body: { phone } });
      setStep({ kind: 'otp', phone: res.phone, resendIn: res.resendInSeconds, devOtp: res.devOtp });
    } catch (e) {
      // A cooldown means an OTP was already sent; let the user enter it.
      if (e instanceof ApiError && e.code === 'OTP_COOLDOWN') {
        setStep({ kind: 'otp', phone, resendIn: Number(e.data.retryAfterSeconds) || 30 });
      } else {
        setError(errorMessage(e));
      }
    } finally {
      setLoading(false);
    }
  }

  // New users tell us their name before entering the app; it appears on
  // bookings for the venue owner.
  async function onVerified(token: string, user: User) {
    if (user.name) return signIn({ token, user });
    setStep({ kind: 'name', token, user });
  }

  async function saveName() {
    if (step.kind !== 'name') return;
    setLoading(true);
    setError(null);
    try {
      setAuthToken(step.token);
      const user = await api<User>('/me', { method: 'PATCH', body: { name } });
      await signIn({ token: step.token, user });
    } catch (e) {
      setError(errorMessage(e));
      setLoading(false);
    }
  }

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ flexGrow: 1 }}>
        <View style={styles.hero}>
          <GroundArt seed="login" sportId="cricket" style={StyleSheet.absoluteFill} />
          <View style={styles.heroShade} />
          <View style={[styles.heroText, { paddingTop: insets.top + 24 }]}>
            <Text style={styles.brand}>SPORTS SPACE</Text>
            <Text style={styles.heroTitle}>Play More.{'\n'}Book Your Ground.</Text>
            <Text style={styles.heroSub}>Find and book the best turfs, stadiums and courts in your city</Text>
          </View>
        </View>

        <View style={styles.sheet}>
          {step.kind === 'otp' ? (
            <OtpForm {...step} onChangeNumber={() => setStep({ kind: 'phone' })} onVerified={onVerified} />
          ) : step.kind === 'name' ? (
            <>
              <Text style={styles.title}>Welcome! What's your name?</Text>
              <Text style={styles.subtitle}>Venues will see this name on your bookings.</Text>
              <TextInput
                style={[styles.inputRow, styles.input, { paddingHorizontal: 14 }]}
                value={name}
                onChangeText={setName}
                placeholder="Full name"
                placeholderTextColor={colors.muted}
                autoComplete="name"
                textContentType="name"
                autoCapitalize="words"
                autoFocus
                onSubmitEditing={() => name.trim().length >= 2 && saveName()}
              />
              <ErrorBanner message={error} />
              <Button title="Continue" onPress={saveName} loading={loading} disabled={name.trim().length < 2} style={{ marginTop: 16 }} />
            </>
          ) : (
            <>
              <Text style={styles.title}>Login with mobile number</Text>
              <Text style={styles.subtitle}>We'll send a 6-digit OTP by SMS to verify it's you.</Text>
              <View style={styles.inputRow}>
                <Text style={styles.prefix}>🇮🇳 +91</Text>
                <TextInput
                  style={styles.input}
                  value={phone}
                  onChangeText={(t) => setPhone(t.replace(/\D/g, '').slice(0, 10))}
                  placeholder="10-digit mobile number"
                  placeholderTextColor={colors.muted}
                  keyboardType="number-pad"
                  textContentType="telephoneNumber"
                  autoComplete="tel"
                  maxLength={10}
                  onSubmitEditing={() => validPhone && sendOtp()}
                />
              </View>
              <ErrorBanner message={error} />
              <Button title="Get OTP" onPress={sendOtp} loading={loading} disabled={!validPhone} style={{ marginTop: 16 }} />
              <Text style={styles.terms}>By continuing you agree to our Terms of Service and Privacy Policy.</Text>
            </>
          )}
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  hero: { height: 320, justifyContent: 'flex-end' },
  heroShade: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(4,30,14,0.45)' },
  heroText: { padding: 24, paddingBottom: 48 },
  brand: { color: '#A8E6BC', fontWeight: '800', letterSpacing: 2, fontSize: 12, marginBottom: 8 },
  heroTitle: { color: '#fff', fontSize: 30, fontWeight: '800', lineHeight: 36 },
  heroSub: { color: '#E5F2EA', marginTop: 8, fontSize: 14 },
  sheet: { flex: 1, backgroundColor: colors.bg, marginTop: -24, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24 },
  title: { fontSize: 20, fontWeight: '800', color: colors.text },
  subtitle: { color: colors.muted, marginTop: 6, marginBottom: 20 },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.card,
    borderWidth: 1.5,
    borderColor: colors.border,
    borderRadius: radius,
    paddingHorizontal: 14,
  },
  prefix: { fontSize: 16, fontWeight: '600', color: colors.text, marginRight: 10 },
  input: { flex: 1, fontSize: 17, paddingVertical: 14, color: colors.text },
  terms: { textAlign: 'center', color: colors.muted, marginTop: 16, fontSize: 12 },
});
