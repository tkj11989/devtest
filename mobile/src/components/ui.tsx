import { Ionicons } from '@expo/vector-icons';
import type { ComponentProps, ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import { colors, radius, shadow } from '../lib/theme';

export type IconName = ComponentProps<typeof Ionicons>['name'];

export function Button({
  title,
  onPress,
  loading,
  disabled,
  variant = 'primary',
  icon,
  style,
}: {
  title: string;
  onPress: () => void;
  loading?: boolean;
  disabled?: boolean;
  variant?: 'primary' | 'outline' | 'danger';
  icon?: IconName;
  style?: StyleProp<ViewStyle>;
}) {
  const inactive = disabled || loading;
  const fg = variant === 'primary' ? '#fff' : variant === 'danger' ? colors.danger : colors.primary;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={inactive}
      style={({ pressed }) => [
        styles.btn,
        variant === 'outline' && styles.btnOutline,
        variant === 'danger' && styles.btnDanger,
        inactive && styles.btnDisabled,
        pressed && { opacity: 0.85 },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={fg} />
      ) : (
        <View style={styles.btnInner}>
          {icon && <Ionicons name={icon} size={18} color={fg} />}
          <Text style={[styles.btnText, { color: fg }]}>{title}</Text>
        </View>
      )}
    </Pressable>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function ErrorBanner({ message }: { message?: string | null }) {
  if (!message) return null;
  return (
    <View style={styles.error}>
      <Ionicons name="alert-circle" size={18} color={colors.danger} />
      <Text style={{ color: colors.danger, flex: 1 }}>{message}</Text>
    </View>
  );
}

export function Loading() {
  return (
    <View style={styles.centered}>
      <ActivityIndicator size="large" color={colors.primary} />
    </View>
  );
}

export function Empty({ icon, title, subtitle }: { icon: IconName; title: string; subtitle?: string }) {
  return (
    <View style={{ alignItems: 'center', paddingVertical: 48, paddingHorizontal: 24, gap: 8 }}>
      <View style={styles.emptyIcon}>
        <Ionicons name={icon} size={30} color={colors.primary} />
      </View>
      <Text style={{ fontSize: 16, fontWeight: '700', color: colors.text }}>{title}</Text>
      {subtitle && <Text style={{ color: colors.muted, textAlign: 'center' }}>{subtitle}</Text>}
    </View>
  );
}

export function Row({ label, value, valueStyle }: { label: string; value: ReactNode; valueStyle?: StyleProp<TextStyle> }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      {typeof value === 'string' ? <Text style={[styles.rowValue, valueStyle]}>{value}</Text> : value}
    </View>
  );
}

export type Tone = 'green' | 'amber' | 'red' | 'grey';
const TONES: Record<Tone, [string, string]> = {
  green: [colors.primary, colors.primarySoft],
  amber: [colors.warning, colors.warningSoft],
  red: [colors.danger, colors.dangerSoft],
  grey: [colors.muted, colors.disabled],
};

export function Badge({ label, tone = 'green' }: { label: string; tone?: Tone }) {
  const [fg, bg] = TONES[tone];
  return (
    <View style={[styles.badge, { backgroundColor: bg }]}>
      <Text style={[styles.badgeText, { color: fg }]}>{label}</Text>
    </View>
  );
}

export function Rating({ value, count, size = 13 }: { value: number; count?: number; size?: number }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
      <Ionicons name="star" size={size} color={colors.star} />
      <Text style={{ fontSize: size, fontWeight: '700', color: colors.text }}>{value.toFixed(1)}</Text>
      {count !== undefined && <Text style={{ fontSize: size - 1, color: colors.muted }}>({count})</Text>}
    </View>
  );
}

// onDark: for use on the green header band, where the active chip turns white.
export function Chip({ label, active, onPress, icon, onDark }: { label: string; active?: boolean; onPress: () => void; icon?: IconName; onDark?: boolean }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: !!active }}
      style={[styles.chip, active && styles.chipActive, onDark && styles.chipOnDark, onDark && active && styles.chipOnDarkActive]}
    >
      {icon && <Ionicons name={icon} size={14} color={active ? '#fff' : colors.text} />}
      <Text style={[styles.chipText, active && { color: '#fff' }, onDark && { color: '#fff' }, onDark && active && { color: colors.primary, fontWeight: '700' }]}>{label}</Text>
    </Pressable>
  );
}

export function Segmented<T extends string>({ options, value, onChange }: { options: { id: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <View style={styles.segment}>
      {options.map((o) => (
        <Pressable
          key={o.id}
          onPress={() => onChange(o.id)}
          accessibilityRole="tab"
          accessibilityState={{ selected: o.id === value }}
          style={[styles.segmentItem, o.id === value && styles.segmentActive]}
        >
          <Text style={[styles.segmentText, o.id === value && { color: '#fff' }]}>{o.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

export function IconCircle({ name, onPress, label, dark }: { name: IconName; onPress: () => void; label: string; dark?: boolean }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityLabel={label}
      hitSlop={6}
      style={[styles.iconCircle, dark && { backgroundColor: 'rgba(0,0,0,0.35)' }]}
    >
      <Ionicons name={name} size={20} color={dark ? '#fff' : colors.text} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  btn: {
    backgroundColor: colors.primary,
    borderRadius: 10,
    paddingVertical: 14,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 50,
  },
  btnInner: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  btnOutline: { backgroundColor: '#fff', borderWidth: 1.5, borderColor: colors.primary },
  btnDanger: { backgroundColor: '#fff', borderWidth: 1.5, borderColor: colors.danger },
  btnDisabled: { opacity: 0.5 },
  btnText: { fontSize: 16, fontWeight: '700' },
  card: { backgroundColor: colors.card, borderRadius: radius, padding: 16, ...shadow },
  error: { flexDirection: 'row', gap: 8, alignItems: 'center', backgroundColor: colors.dangerSoft, padding: 12, borderRadius: 10, marginVertical: 8 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, backgroundColor: colors.bg },
  emptyIcon: { width: 64, height: 64, borderRadius: 32, backgroundColor: colors.primarySoft, alignItems: 'center', justifyContent: 'center', marginBottom: 4 },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 7, gap: 12 },
  rowLabel: { color: colors.muted, fontSize: 14 },
  rowValue: { color: colors.text, fontSize: 14, fontWeight: '600', flexShrink: 1, textAlign: 'right' },
  badge: { paddingHorizontal: 10, paddingVertical: 3, borderRadius: 6, alignSelf: 'flex-start' },
  badgeText: { fontSize: 12, fontWeight: '600' },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 18,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
  },
  chipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipOnDark: { backgroundColor: 'rgba(255,255,255,0.12)', borderColor: 'rgba(255,255,255,0.35)' },
  chipOnDarkActive: { backgroundColor: '#fff', borderColor: '#fff' },
  chipText: { fontSize: 13, fontWeight: '500', color: colors.text },
  segment: { flexDirection: 'row', gap: 8 },
  segmentItem: { flex: 1, paddingVertical: 9, borderRadius: 8, alignItems: 'center', backgroundColor: colors.disabled },
  segmentActive: { backgroundColor: colors.primary },
  segmentText: { fontSize: 14, fontWeight: '600', color: colors.text },
  iconCircle: { width: 38, height: 38, borderRadius: 19, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center' },
});
