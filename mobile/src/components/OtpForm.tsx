import { useEffect, useRef, useState, type ComponentRef } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Button, ErrorBanner } from './ui';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { maskPhone } from '../lib/format';
import { colors } from '../lib/theme';

const LENGTH = 6;

type Props = { phone: string; resendIn: number; devOtp?: string; onChangeNumber: () => void };

export function OtpForm({ phone, resendIn, onChangeNumber, ...props }: Props) {
  const { signIn } = useAuth();
  const inputRef = useRef<ComponentRef<typeof TextInput>>(null);
  const [code, setCode] = useState('');
  const [devOtp, setDevOtp] = useState(props.devOtp || '');
  const [secondsLeft, setSecondsLeft] = useState(resendIn);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  useEffect(() => {
    if (secondsLeft <= 0) return;
    const t = setTimeout(() => setSecondsLeft((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [secondsLeft]);

  async function verify(value = code) {
    if (value.length !== LENGTH || loading) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api<{ token: string; user: { phone: string } }>('/auth/verify-otp', { body: { phone, otp: value } });
      // Signing in flips the auth guard in _layout, which navigates to home.
      await signIn({ token: res.token, phone: res.user.phone });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setCode('');
      setLoading(false);
    }
  }

  async function resend() {
    setError(null);
    setInfo(null);
    try {
      const res = await api<{ resendInSeconds: number; devOtp?: string }>('/auth/send-otp', { body: { phone } });
      setSecondsLeft(res.resendInSeconds);
      setDevOtp(res.devOtp || '');
      setCode('');
      setInfo('A new OTP has been sent.');
    } catch (e) {
      if (e instanceof ApiError && e.code === 'OTP_COOLDOWN') setSecondsLeft(Number(e.data.retryAfterSeconds) || 30);
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <View>
      <Text style={styles.title}>Enter verification code</Text>
      <Text style={styles.subtitle}>
        Sent by SMS to {maskPhone(phone)} ·{' '}
        <Text style={styles.link} onPress={onChangeNumber}>
          Change
        </Text>
      </Text>

      <Pressable onPress={() => inputRef.current?.focus()} style={styles.boxes}>
        {Array.from({ length: LENGTH }, (_, i) => (
          <View key={i} style={[styles.box, i === code.length && styles.boxActive, !!code[i] && styles.boxFilled]}>
            <Text style={styles.digit}>{code[i] ?? ''}</Text>
          </View>
        ))}
      </Pressable>
      {/* One hidden input drives the boxes so paste and SMS autofill work. */}
      <TextInput
        ref={inputRef}
        value={code}
        onChangeText={(t) => {
          const v = t.replace(/\D/g, '').slice(0, LENGTH);
          setCode(v);
          if (v.length === LENGTH) verify(v);
        }}
        keyboardType="number-pad"
        textContentType="oneTimeCode"
        autoComplete="sms-otp"
        maxLength={LENGTH}
        autoFocus
        style={styles.hiddenInput}
      />

      {!!devOtp && <Text style={styles.dev}>Dev mode — your OTP is {devOtp}</Text>}
      <ErrorBanner message={error} />
      {!!info && <Text style={styles.info}>{info}</Text>}

      <Button title="Verify & Continue" onPress={() => verify()} loading={loading} disabled={code.length !== LENGTH} style={{ marginTop: 16 }} />

      <View style={styles.resendRow}>
        {secondsLeft > 0 ? (
          <Text style={styles.muted}>Resend OTP in {secondsLeft}s</Text>
        ) : (
          <Pressable onPress={resend}>
            <Text style={styles.link}>Resend OTP</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: 22, fontWeight: '800', color: colors.text },
  subtitle: { color: colors.muted, marginTop: 6, marginBottom: 28 },
  boxes: { flexDirection: 'row', justifyContent: 'space-between' },
  box: {
    width: 48,
    height: 56,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: colors.card,
    alignItems: 'center',
    justifyContent: 'center',
  },
  boxActive: { borderColor: colors.primary, borderWidth: 2 },
  boxFilled: { borderColor: colors.primaryDark },
  digit: { fontSize: 22, fontWeight: '700', color: colors.text },
  hiddenInput: { position: 'absolute', opacity: 0, height: 1, width: 1 },
  dev: { marginTop: 16, color: colors.warning, backgroundColor: colors.warningSoft, padding: 10, borderRadius: 8, textAlign: 'center' },
  info: { color: colors.primary, marginTop: 8 },
  resendRow: { alignItems: 'center', marginTop: 20 },
  muted: { color: colors.muted },
  link: { color: colors.primary, fontWeight: '700' },
});
