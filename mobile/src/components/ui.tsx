import { ReactNode, Ref } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TextInputProps,
  TextStyle,
  useColorScheme,
  View,
  ViewStyle,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

const light = {
  bg: "#f5f6f8", card: "#ffffff", text: "#1d2330", muted: "#6b7280", border: "#e3e6eb",
  accent: "#2f6fde", accentText: "#ffffff", error: "#c53030", ok: "#1a8f4c", code: "#f0f2f5",
};
const dark: typeof light = {
  bg: "#12151b", card: "#1b1f27", text: "#e6e9ef", muted: "#9aa3b2", border: "#2b313c",
  accent: "#5b8ef0", accentText: "#ffffff", error: "#f56565", ok: "#48bb78", code: "#232833",
};
export type Theme = typeof light;

export function useTheme(): Theme {
  return useColorScheme() === "dark" ? dark : light;
}

export function Screen({ children, scroll = true }: { children: ReactNode; scroll?: boolean }) {
  const t = useTheme();
  const body = scroll ? (
    <ScrollView contentContainerStyle={styles.screen} keyboardShouldPersistTaps="handled">
      {children}
    </ScrollView>
  ) : (
    <View style={[styles.screen, { flex: 1 }]}>{children}</View>
  );
  return (
    <SafeAreaView edges={["bottom", "left", "right"]} style={{ flex: 1, backgroundColor: t.bg }}>
      {body}
    </SafeAreaView>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  const t = useTheme();
  return <View style={[styles.card, { backgroundColor: t.card, borderColor: t.border }, style]}>{children}</View>;
}

type TextProps = { children: ReactNode; style?: TextStyle | TextStyle[]; numberOfLines?: number; selectable?: boolean };

export function Title({ children, style }: TextProps) {
  const t = useTheme();
  return <Text style={[styles.title, { color: t.text }, style as TextStyle]}>{children}</Text>;
}

export function Body({ children, style, numberOfLines, selectable }: TextProps) {
  const t = useTheme();
  return (
    <Text style={[styles.body, { color: t.text }, style as TextStyle]} numberOfLines={numberOfLines} selectable={selectable}>
      {children}
    </Text>
  );
}

export function Muted({ children, style, numberOfLines }: TextProps) {
  const t = useTheme();
  return (
    <Text style={[styles.small, { color: t.muted }, style as TextStyle]} numberOfLines={numberOfLines}>
      {children}
    </Text>
  );
}

export function ErrorText({ children }: { children: ReactNode }) {
  const t = useTheme();
  if (!children) return null;
  return <Text style={[styles.body, { color: t.error, marginTop: 8 }]}>{children}</Text>;
}

type ButtonProps = {
  label: string;
  onPress: () => void;
  variant?: "primary" | "ghost" | "danger";
  disabled?: boolean;
  loading?: boolean;
  small?: boolean;
  style?: ViewStyle;
};

export function Button({ label, onPress, variant = "primary", disabled, loading, small, style }: ButtonProps) {
  const t = useTheme();
  const color = variant === "danger" ? t.error : t.accent;
  const filled = variant === "primary";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: disabled || loading }}
      onPress={onPress}
      disabled={disabled || loading}
      style={({ pressed }) => [
        styles.button,
        small && styles.buttonSmall,
        { borderColor: color, backgroundColor: filled ? color : "transparent" },
        (disabled || loading) && { opacity: 0.5 },
        pressed && { opacity: 0.75 },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={filled ? t.accentText : color} />
      ) : (
        <Text style={[styles.buttonText, small && { fontSize: 14 }, { color: filled ? t.accentText : color }]}>{label}</Text>
      )}
    </Pressable>
  );
}

export function Input(props: TextInputProps & { ref?: Ref<TextInput> }) {
  const t = useTheme();
  return (
    <TextInput
      placeholderTextColor={t.muted}
      {...props}
      style={[styles.input, { color: t.text, borderColor: t.border, backgroundColor: t.card }, props.style]}
    />
  );
}

export function Row({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  return <View style={[styles.row, style]}>{children}</View>;
}

export function Loading({ label }: { label?: string }) {
  const t = useTheme();
  return (
    <View style={styles.loading}>
      <ActivityIndicator color={t.accent} />
      {label ? <Muted style={{ marginLeft: 8 }}>{label}</Muted> : null}
    </View>
  );
}

/** Tiny markdown renderer for model output: paragraphs, "- " / "1." lists and **bold**. */
export function Markdown({ text }: { text: string }) {
  const t = useTheme();
  const inline = (line: string, key: string) =>
    line.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
      part.startsWith("**") && part.endsWith("**") ? (
        <Text key={`${key}-${i}`} style={{ fontWeight: "700" }}>{part.slice(2, -2)}</Text>
      ) : (
        part
      ),
    );
  return (
    <View>
      {text.split("\n").map((raw, i) => {
        const line = raw.trim();
        if (!line) return null;
        const bullet = line.match(/^(?:[-*•]|\d+[.)])\s+(.*)$/);
        if (bullet) {
          return (
            <View key={i} style={styles.bulletRow}>
              <Text style={[styles.body, { color: t.text, width: 16 }]}>•</Text>
              <Text style={[styles.body, { color: t.text, flex: 1 }]} selectable>{inline(bullet[1], String(i))}</Text>
            </View>
          );
        }
        return (
          <Text key={i} style={[styles.body, { color: t.text, marginBottom: 6 }]} selectable>
            {inline(line.replace(/^#+\s*/, ""), String(i))}
          </Text>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { padding: 16, paddingBottom: 32, gap: 12 },
  card: { borderWidth: 1, borderRadius: 12, padding: 14, gap: 8 },
  title: { fontSize: 19, fontWeight: "700" },
  body: { fontSize: 15, lineHeight: 22 },
  small: { fontSize: 13, lineHeight: 18 },
  button: { borderWidth: 1, borderRadius: 9, paddingVertical: 11, paddingHorizontal: 16, alignItems: "center", justifyContent: "center", minHeight: 44 },
  buttonSmall: { paddingVertical: 6, paddingHorizontal: 12, minHeight: 34 },
  buttonText: { fontSize: 15, fontWeight: "600" },
  input: { borderWidth: 1, borderRadius: 9, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16 },
  row: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" },
  loading: { flexDirection: "row", alignItems: "center", padding: 12 },
  bulletRow: { flexDirection: "row", marginBottom: 4 },
});
