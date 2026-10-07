import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import { router, Stack, useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { Alert, Platform, Pressable, RefreshControl, ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { Body, Button, Card, ErrorText, Loading, Muted, Row, Title, useTheme } from "../components/ui";
import { api, ApiError, DocumentSummary } from "../lib/api";
import { useAuth } from "../lib/auth";

const ACCEPTED_TYPES = [
  "application/pdf",
  "image/*",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain",
  "text/markdown",
];

type Picked = { uri: string; name: string; mimeType?: string | null; webFile?: File };

export default function Home() {
  const t = useTheme();
  const { user, signOut } = useAuth();
  const [docs, setDocs] = useState<DocumentSummary[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [uploading, setUploading] = useState<string | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setDocs(await api.listDocuments());
      setError("");
    } catch (e) {
      setError((e as ApiError).message);
    }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const upload = async (file: Picked) => {
    setError("");
    setUploading(file.name);
    try {
      const doc = await api.uploadDocument(file);
      router.push({ pathname: "/doc/[id]", params: { id: doc.id } });
    } catch (e) {
      setError(`Upload failed: ${(e as ApiError).message}`);
    } finally {
      setUploading(null);
    }
  };

  const pickFile = async () => {
    const res = await DocumentPicker.getDocumentAsync({ type: ACCEPTED_TYPES, copyToCacheDirectory: true });
    if (res.canceled || !res.assets?.length) return;
    const a = res.assets[0];
    upload({ uri: a.uri, name: a.name, mimeType: a.mimeType, webFile: a.file });
  };

  const fromImage = async (source: "camera" | "library") => {
    if (source === "camera") {
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (!perm.granted) {
        Alert.alert("Camera permission needed", "Allow camera access in Settings to scan documents.");
        return;
      }
    }
    const options: ImagePicker.ImagePickerOptions = { mediaTypes: ["images"], quality: 0.9 };
    const res = source === "camera"
      ? await ImagePicker.launchCameraAsync(options)
      : await ImagePicker.launchImageLibraryAsync(options);
    if (res.canceled || !res.assets?.length) return;
    const a = res.assets[0];
    const ext = a.mimeType === "image/png" ? "png" : "jpg";
    upload({
      uri: a.uri,
      name: a.fileName || `scan-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.${ext}`,
      mimeType: a.mimeType || "image/jpeg",
      webFile: a.file ?? undefined,
    });
  };

  const confirmDelete = (doc: DocumentSummary) => {
    const run = async () => {
      try {
        await api.deleteDocument(doc.id);
        load();
      } catch (e) {
        setError((e as ApiError).message);
      }
    };
    if (Platform.OS === "web") {
      if (globalThis.confirm?.(`Delete ${doc.filename}?`)) run();
      return;
    }
    Alert.alert("Delete document", `Delete "${doc.filename}" and its Q&A data?`, [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: run },
    ]);
  };

  return (
    <SafeAreaView edges={["bottom", "left", "right"]} style={{ flex: 1, backgroundColor: t.bg }}>
      <Stack.Screen
        options={{
          headerRight: () => <Button small variant="ghost" label="Log out" onPress={signOut} />,
        }}
      />
      <ScrollView
        contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: 32 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} />}
      >
        <Muted>Signed in as {user?.email || user?.phone}</Muted>

        <Card>
          <Title>Upload a document</Title>
          <Muted>PDF (text or scanned), photo, DOCX or TXT. It is OCR’d, split into sections and indexed for Q&A.</Muted>
          {uploading ? (
            <Loading label={`Processing ${uploading}: OCR, sections, indexing…`} />
          ) : (
            <View style={{ gap: 8 }}>
              <Button label="📁  Choose file" onPress={pickFile} />
              <Row>
                <Button variant="ghost" label="📷  Scan with camera" onPress={() => fromImage("camera")} style={{ flex: 1 }} />
                <Button variant="ghost" label="🖼  Photo library" onPress={() => fromImage("library")} style={{ flex: 1 }} />
              </Row>
            </View>
          )}
          <ErrorText>{error}</ErrorText>
        </Card>

        <Card>
          <Title>Ask questions</Title>
          <Muted>Ask anything across all your uploaded documents.</Muted>
          <Button variant="ghost" label="💬  Ask across all documents" onPress={() => router.push("/ask")} />
        </Card>

        <Title style={{ marginTop: 4 }}>Your documents</Title>
        {docs === null ? (
          <Loading />
        ) : docs.length === 0 ? (
          <Muted>No documents yet. Upload one above.</Muted>
        ) : (
          docs.map(d => (
            <Pressable key={d.id} onPress={() => router.push({ pathname: "/doc/[id]", params: { id: d.id } })}>
              <Card>
                <Body style={{ fontWeight: "700" }} numberOfLines={2}>{d.filename}</Body>
                <Muted>
                  {d.section_count} sections · {d.pages} page(s){d.ocr_pages ? ` · ${d.ocr_pages} OCR'd` : ""} ·{" "}
                  {new Date(d.created_at).toLocaleDateString()}
                </Muted>
                <Row style={{ justifyContent: "flex-end" }}>
                  <Button small variant="danger" label="Delete" onPress={() => confirmDelete(d)} />
                  <Button small label="Open" onPress={() => router.push({ pathname: "/doc/[id]", params: { id: d.id } })} />
                </Row>
              </Card>
            </Pressable>
          ))
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
