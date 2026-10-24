import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, View, type TextInputProps } from 'react-native';
import { Badge, Button, Card, ErrorBanner, Loading, Segmented } from '../../components/ui';
import { api, type Payout } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { errorMessage } from '../../lib/format';
import { colors, radius } from '../../lib/theme';

type Method = 'UPI' | 'BANK';

// Where the venue's share of every online payment is credited.
export default function PayoutAccount() {
  const { user } = useAuth();
  const [payout, setPayout] = useState<Payout | null | undefined>(undefined);
  const [method, setMethod] = useState<Method>('UPI');
  const [holder, setHolder] = useState('');
  const [upiId, setUpiId] = useState('');
  const [account, setAccount] = useState('');
  const [confirmAccount, setConfirmAccount] = useState('');
  const [ifsc, setIfsc] = useState('');
  const [contact, setContact] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api<Payout | null>('/owner/payout').then(
      (p) => {
        setPayout(p);
        setMethod(p?.method ?? 'UPI');
        setHolder(p?.accountHolder ?? user?.name ?? '');
        setUpiId(p?.upiId ?? '');
        setIfsc(p?.ifsc ?? '');
        setContact(p?.contactPhone ?? user?.phone ?? '');
      },
      (e) => setError(errorMessage(e)),
    );
  }, [user]);

  if (payout === undefined && !error) return <Loading />;

  // An existing bank account doesn't need re-entering unless it changes.
  const keepAccount = method === 'BANK' && payout?.method === 'BANK' && !account;
  const accountOk = keepAccount || (/^\d{9,18}$/.test(account) && account === confirmAccount);
  const valid =
    holder.trim().length >= 2 &&
    /^[6-9]\d{9}$/.test(contact) &&
    (method === 'UPI' ? /^[\w.-]{2,}@[a-zA-Z][\w.-]+$/.test(upiId.trim()) : accountOk && /^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc));

  async function save() {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const body =
        method === 'UPI'
          ? { method, accountHolder: holder, upiId: upiId.trim(), contactPhone: contact }
          : { method, accountHolder: holder, ifsc, contactPhone: contact, ...(account && { accountNumber: account }) };
      const p = await api<Payout>('/owner/payout', { method: 'PUT', body });
      setPayout(p);
      setAccount('');
      setConfirmAccount('');
      setSaved(true);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 14 }} keyboardShouldPersistTaps="handled">
        <View style={styles.info}>
          <Ionicons name="information-circle-outline" size={20} color={colors.primary} />
          <Text style={{ flex: 1, color: colors.text, fontSize: 13, lineHeight: 19 }}>
            For online bookings, the slot price is credited directly to this account. The platform fee goes to Sports Space.
          </Text>
        </View>

        {payout && (
          <Card style={{ gap: 6 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <Text style={styles.cardTitle}>Current payout account</Text>
              <Badge label={payout.status === 'ACTIVE' ? 'Active' : 'Pending verification'} tone={payout.status === 'ACTIVE' ? 'green' : 'amber'} />
            </View>
            <Text style={styles.dest}>{payout.destination}</Text>
            <Text style={styles.muted}>
              {payout.accountHolder} · Contact +91 {payout.contactPhone}
            </Text>
            {payout.status === 'PENDING_LINK' && (
              <Text style={[styles.muted, { color: colors.warning }]}>
                Sports Space will verify this account. Online payments for your grounds start once it's verified; pay-at-venue bookings work meanwhile.
              </Text>
            )}
          </Card>
        )}

        <Text style={styles.label}>Receive payments in</Text>
        <Segmented
          options={[
            { id: 'UPI', label: 'UPI ID' },
            { id: 'BANK', label: 'Bank Account' },
          ]}
          value={method}
          onChange={setMethod}
        />

        <Field label="Account holder name" value={holder} onChangeText={setHolder} autoCapitalize="words" />
        {method === 'UPI' ? (
          <Field
            label="UPI ID"
            value={upiId}
            onChangeText={setUpiId}
            placeholder="yourname@okaxis"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
          />
        ) : (
          <>
            <Field
              label="Account number"
              value={account}
              onChangeText={(t) => setAccount(t.replace(/\D/g, '').slice(0, 18))}
              placeholder={payout?.accountNumberMasked ? `${payout.accountNumberMasked} (leave blank to keep)` : '9-18 digits'}
              keyboardType="number-pad"
            />
            {!!account && (
              <Field
                label="Re-enter account number"
                value={confirmAccount}
                onChangeText={(t) => setConfirmAccount(t.replace(/\D/g, '').slice(0, 18))}
                keyboardType="number-pad"
                error={confirmAccount.length >= account.length && confirmAccount !== account ? 'Account numbers do not match' : undefined}
              />
            )}
            <Field
              label="IFSC code"
              value={ifsc}
              onChangeText={(t) => setIfsc(t.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 11))}
              placeholder="HDFC0001234"
              autoCapitalize="characters"
              autoCorrect={false}
            />
          </>
        )}
        <Field
          label="Payment contact number"
          value={contact}
          onChangeText={(t) => setContact(t.replace(/\D/g, '').slice(0, 10))}
          keyboardType="number-pad"
          prefix="+91"
          hint="Payout alerts and payment queries are sent to this number."
        />

        <ErrorBanner message={error} />
        {saved && (
          <View style={styles.saved}>
            <Ionicons name="checkmark-circle" size={18} color={colors.primary} />
            <Text style={{ color: colors.primary, fontWeight: '600' }}>Payout account saved</Text>
          </View>
        )}
        <Button title="Save Payout Account" onPress={save} loading={saving} disabled={!valid} />
        {saved && <Button title="Back to Dashboard" variant="outline" onPress={() => router.back()} />}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function Field({ label, hint, prefix, error, ...input }: TextInputProps & { label: string; hint?: string; prefix?: string; error?: string }) {
  return (
    <View style={{ gap: 6 }}>
      <Text style={styles.label}>{label}</Text>
      <View style={[styles.inputRow, !!error && { borderColor: colors.danger }]}>
        {prefix && <Text style={styles.prefix}>{prefix}</Text>}
        <TextInput style={styles.input} placeholderTextColor={colors.muted} accessibilityLabel={label} {...input} />
      </View>
      {!!error && <Text style={{ color: colors.danger, fontSize: 12 }}>{error}</Text>}
      {!!hint && <Text style={styles.muted}>{hint}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  info: { flexDirection: 'row', gap: 10, backgroundColor: colors.primarySoft, padding: 12, borderRadius: radius },
  cardTitle: { fontWeight: '700', color: colors.text },
  dest: { fontSize: 16, fontWeight: '800', color: colors.text },
  muted: { color: colors.muted, fontSize: 12 },
  label: { fontWeight: '600', color: colors.text, fontSize: 13 },
  inputRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#fff', borderWidth: 1.5, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 12 },
  prefix: { fontWeight: '600', color: colors.text, marginRight: 8 },
  input: { flex: 1, paddingVertical: 12, fontSize: 15, color: colors.text },
  saved: { flexDirection: 'row', alignItems: 'center', gap: 6, justifyContent: 'center' },
});
