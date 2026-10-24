import { useState } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { OtpForm } from '../components/OtpForm';
import { Button, ErrorBanner } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { colors, radius } from '../lib/theme';

type SendOtpResponse = { phone: string; resendInSeconds: number; devOtp?: string };

export default function Login() {
  const [phone, setPhone] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [otpStep, setOtpStep] = useState<{ phone: string; resendIn: number; devOtp?: string } | null>(null);
  const valid = /^[6-9]\d{9}$/.test(phone);

  async function sendOtp() {
    setLoading(true);
    setError(null);
    try {
      const res = await api<SendOtpResponse>('/auth/send-otp', { body: { phone } });
      setOtpStep({ phone: res.phone, resendIn: res.resendInSeconds, devOtp: res.devOtp });
    } catch (e) {
      // A cooldown means an OTP was already sent; let the user enter it.
      if (e instanceof ApiError && e.code === 'OTP_COOLDOWN') {
        setOtpStep({ phone, resendIn: Number(e.data.retryAfterSeconds) || 30 });
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.container}>
        <View style={styles.hero}>
          <Text style={styles.logo}>🏏⚽🏸</Text>
          <Text style={styles.title}>Sports Space</Text>
          <Text style={styles.subtitle}>Book turfs, courts and nets in seconds</Text>
        </View>

        {otpStep ? (
          <OtpForm {...otpStep} onChangeNumber={() => setOtpStep(null)} />
        ) : (
          <>
            <Text style={styles.label}>Mobile number</Text>
            <View style={styles.inputRow}>
              <Text style={styles.prefix}>+91</Text>
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
                autoFocus
                onSubmitEditing={() => valid && sendOtp()}
              />
            </View>
            <ErrorBanner message={error} />
            <Button title="Get OTP" onPress={sendOtp} loading={loading} disabled={!valid} style={{ marginTop: 16 }} />
            <Text style={styles.hint}>We'll send a 6-digit code by SMS to verify your number.</Text>
          </>
        )}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  container: { flex: 1, padding: 24, justifyContent: 'center' },
  hero: { alignItems: 'center', marginBottom: 40 },
  logo: { fontSize: 40 },
  title: { fontSize: 32, fontWeight: '800', color: colors.primary, marginTop: 8 },
  subtitle: { color: colors.muted, marginTop: 6, fontSize: 15 },
  label: { fontWeight: '600', color: colors.text, marginBottom: 8 },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.card,
    borderWidth: 1.5,
    borderColor: colors.border,
    borderRadius: radius,
    paddingHorizontal: 14,
  },
  prefix: { fontSize: 18, fontWeight: '600', color: colors.text, marginRight: 10 },
  input: { flex: 1, fontSize: 18, paddingVertical: 14, color: colors.text, letterSpacing: 1 },
  hint: { textAlign: 'center', color: colors.muted, marginTop: 16, fontSize: 13 },
});
