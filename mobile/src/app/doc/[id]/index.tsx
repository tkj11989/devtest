import { router, Stack, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { Body, Button, Card, ErrorText, Loading, Muted, Row, Screen, Title, useTheme } from "../../../components/ui";
import { api, ApiError, DocumentDetail, pagesLabel, SummaryStyle } from "../../../lib/api";

const STYLES: { value: SummaryStyle; label: string }[] = [
  { value: "brief", label: "Brief" },
  { value: "bullets", label: "Bullets" },
  { value: "detailed", label: "Detailed" },
];

// Remember selections per document while the app is open, so "Back to sections" keeps them.
const selections = new Map<string, Set<string>>();

export default function Sections() {
  const t = useTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [doc, setDoc] = useState<DocumentDetail | null>(null);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<Set<string>>(() => new Set(selections.get(id) ?? []));
  const [style, setStyle] = useState<SummaryStyle>("brief");
  const [expanded, setExpanded] = useState<Record<string, string | null>>({});

  useEffect(() => {
    api.getDocument(id).then(setDoc).catch(e => setError((e as ApiError).message));
  }, [id]);

  useEffect(() => {
    selections.set(id, selected);
  }, [id, selected]);

  const toggle = (sid: string) =>
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(sid)) next.delete(sid);
      else next.add(sid);
      return next;
    });

  const toggleText = async (sid: string) => {
    if (sid in expanded) {
      setExpanded(({ [sid]: _, ...rest }) => rest);
      return;
    }
    setExpanded(e => ({ ...e, [sid]: null }));
    try {
      const sec = await api.getSection(id, sid);
      setExpanded(e => ({ ...e, [sid]: sec.text }));
    } catch (e) {
      setExpanded(x => ({ ...x, [sid]: `Could not load text: ${(e as ApiError).message}` }));
    }
  };

  if (error) return <Screen><ErrorText>{error}</ErrorText><Button label="⌂ Home" onPress={() => router.dismissTo("/")} /></Screen>;
  if (!doc) return <Screen><Loading label="Loading sections…" /></Screen>;

  const ordered = doc.sections.map(s => s.id).filter(sid => selected.has(sid));

  return (
    <>
      <Stack.Screen options={{ title: doc.filename }} />
      <Screen>
        <Muted>
          {doc.sections.length} sections · {doc.pages} page(s){doc.ocr_pages ? ` · ${doc.ocr_pages} OCR'd` : ""} · {doc.chunks} chunks indexed
        </Muted>

        <Card>
          <Title>Summarize</Title>
          <Muted>Select sections below, choose a style, then summarize with the local Qwen model.</Muted>
          <Row>
            {STYLES.map(s => (
              <Button
                key={s.value}
                small
                variant={style === s.value ? "primary" : "ghost"}
                label={s.label}
                onPress={() => setStyle(s.value)}
              />
            ))}
          </Row>
          <Row>
            <Button small variant="ghost" label="Select all" onPress={() => setSelected(new Set(doc.sections.map(s => s.id)))} />
            <Button small variant="ghost" label="Clear" onPress={() => setSelected(new Set())} />
          </Row>
          <Button
            label={`Summarize selected (${ordered.length})`}
            disabled={ordered.length === 0}
            onPress={() => router.push({ pathname: "/doc/[id]/summary", params: { id, ids: ordered.join(","), style } })}
          />
          <Button variant="ghost" label="💬  Ask about this document" onPress={() => router.push({ pathname: "/ask", params: { docId: id, name: doc.filename } })} />
        </Card>

        {doc.sections.map(s => {
          const on = selected.has(s.id);
          return (
            <Card key={s.id} style={on ? { borderColor: t.accent, borderWidth: 2 } : undefined}>
              <Pressable
                onPress={() => toggle(s.id)}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: on }}
                style={styles.sectionRow}
              >
                <View style={[styles.checkbox, { borderColor: on ? t.accent : t.muted, backgroundColor: on ? t.accent : "transparent" }]}>
                  {on ? <Body style={{ color: t.accentText, fontSize: 13, lineHeight: 16 }}>✓</Body> : null}
                </View>
                <View style={{ flex: 1, gap: 2 }}>
                  <Body style={{ fontWeight: "700" }}>{s.title}</Body>
                  <Muted>{pagesLabel(s.page_start, s.page_end)} · {s.word_count} words</Muted>
                  <Body numberOfLines={3} style={{ fontSize: 14 }}>{s.preview}</Body>
                </View>
              </Pressable>
              <Button small variant="ghost" label={s.id in expanded ? "Hide text" : "View full text"} onPress={() => toggleText(s.id)} style={{ alignSelf: "flex-start" }} />
              {s.id in expanded ? (
                expanded[s.id] === null ? (
                  <Loading />
                ) : (
                  <View style={[styles.textBox, { backgroundColor: t.code }]}>
                    <Body selectable style={{ fontSize: 14 }}>{expanded[s.id]}</Body>
                  </View>
                )
              ) : null}
            </Card>
          );
        })}
      </Screen>
    </>
  );
}

const styles = StyleSheet.create({
  sectionRow: { flexDirection: "row", gap: 12, alignItems: "flex-start" },
  checkbox: { width: 24, height: 24, borderRadius: 6, borderWidth: 2, alignItems: "center", justifyContent: "center", marginTop: 2 },
  textBox: { borderRadius: 8, padding: 10 },
});
