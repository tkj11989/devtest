import { router, Stack, useLocalSearchParams } from "expo-router";
import { useRef, useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { Body, Button, Input, Loading, Muted, useTheme } from "../components/ui";
import { api, ApiError, pagesLabel, Source } from "../lib/api";

type Message =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; sources: Source[] }
  | { role: "error"; text: string };

export default function Ask() {
  const t = useTheme();
  const { docId, name } = useLocalSearchParams<{ docId?: string; name?: string }>();
  const [messages, setMessages] = useState<Message[]>([]);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const scroll = useRef<ScrollView>(null);

  const ask = async () => {
    const q = question.trim();
    if (!q || busy) return;
    setQuestion("");
    setMessages(m => [...m, { role: "user", text: q }]);
    setBusy(true);
    try {
      const res = await api.ask(q, docId);
      setMessages(m => [...m, { role: "assistant", text: res.answer, sources: res.sources }]);
    } catch (e) {
      setMessages(m => [...m, { role: "error", text: (e as ApiError).message }]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView edges={["bottom", "left", "right"]} style={{ flex: 1, backgroundColor: t.bg }}>
      <Stack.Screen options={{ title: docId ? "Ask this document" : "Ask all documents" }} />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={100}>
        <ScrollView
          ref={scroll}
          contentContainerStyle={{ padding: 16, gap: 10 }}
          onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: true })}
          keyboardShouldPersistTaps="handled"
        >
          <Muted>
            {docId ? `Searching only "${name ?? "this document"}".` : "Searching all your uploaded documents."} Answers come
            from your documents via the RAG database and cite their sources.
          </Muted>
          {messages.map((m, i) =>
            m.role === "user" ? (
              <View key={i} style={[styles.bubble, styles.user, { backgroundColor: t.accent }]}>
                <Body style={{ color: t.accentText }}>{m.text}</Body>
              </View>
            ) : (
              <View key={i} style={[styles.bubble, { backgroundColor: t.card, borderColor: t.border, borderWidth: 1 }]}>
                <Body selectable style={m.role === "error" ? { color: t.error } : undefined}>{m.text}</Body>
                {m.role === "assistant" && m.sources.length > 0 ? (
                  <View style={{ marginTop: 8, gap: 4 }}>
                    <Muted style={{ fontWeight: "700" }}>Sources</Muted>
                    {m.sources.map(s => {
                      const key = `${i}-${s.n}`;
                      return (
                        <View key={key}>
                          <Pressable onPress={() => setOpen(open === key ? null : key)}>
                            <Muted>
                              {open === key ? "▾" : "▸"} [{s.n}] {s.filename} — {s.section_title} ({pagesLabel(s.page_start, s.page_end)})
                            </Muted>
                          </Pressable>
                          {open === key ? (
                            <View style={[styles.excerpt, { borderColor: t.border }]}>
                              <Body selectable style={{ fontSize: 14 }}>{s.text}</Body>
                              <Button
                                small
                                variant="ghost"
                                label="Open document"
                                onPress={() => router.push({ pathname: "/doc/[id]", params: { id: s.doc_id } })}
                                style={{ alignSelf: "flex-start", marginTop: 6 }}
                              />
                            </View>
                          ) : null}
                        </View>
                      );
                    })}
                  </View>
                ) : null}
              </View>
            ),
          )}
          {busy ? <Loading label="Searching documents and asking the model…" /> : null}
        </ScrollView>
        <View style={[styles.composer, { borderColor: t.border, backgroundColor: t.card }]}>
          <Input
            value={question}
            onChangeText={setQuestion}
            placeholder="Ask about your documents…"
            returnKeyType="send"
            onSubmitEditing={ask}
            style={{ flex: 1 }}
          />
          <Button label="Ask" onPress={ask} disabled={!question.trim()} loading={busy} />
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  bubble: { borderRadius: 12, padding: 12, maxWidth: "92%" },
  user: { alignSelf: "flex-end" },
  excerpt: { borderLeftWidth: 3, paddingLeft: 10, marginVertical: 4 },
  composer: { flexDirection: "row", gap: 8, padding: 10, borderTopWidth: 1, alignItems: "center" },
});
