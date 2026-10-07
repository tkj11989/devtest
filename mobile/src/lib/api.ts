import Constants from "expo-constants";

/**
 * Backend URL: EXPO_PUBLIC_API_URL (e.g. in mobile/.env) wins, then app.json "extra.apiUrl".
 * The mobile app talks to the same FastAPI server as the web UI, so it shares the
 * same Qwen/Ollama model, ChromaDB vector store and user accounts.
 */
export const API_URL = (
  process.env.EXPO_PUBLIC_API_URL ||
  (Constants.expoConfig?.extra?.apiUrl as string | undefined) ||
  "http://localhost:8000"
).replace(/\/+$/, "");

export type User = { id: number; email: string | null; phone: string | null };

export type SectionInfo = {
  id: string;
  title: string;
  page_start: number;
  page_end: number;
  char_count: number;
  word_count: number;
  preview: string;
};

export type DocumentSummary = {
  id: string;
  filename: string;
  created_at: string;
  pages: number;
  ocr_pages: number;
  section_count: number;
};

export type DocumentDetail = Omit<DocumentSummary, "section_count"> & {
  chunks: number;
  sections: SectionInfo[];
};

export type SummaryStyle = "brief" | "bullets" | "detailed";

export type SectionSummary = {
  section_id: string;
  title: string;
  page_start: number;
  page_end: number;
  summary: string;
};

export type Source = {
  n: number;
  doc_id: string;
  filename: string;
  section_id: string;
  section_title: string;
  page_start: number;
  page_end: number;
  score: number;
  text: string;
};

export type OtpSent = { channel: "email" | "phone"; identifier: string; expires_in: number; resend_after: number };

export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

let authToken: string | null = null;
let onUnauthorized: (() => void) | null = null;

export function setAuthToken(token: string | null) {
  authToken = token;
}

/** Called when the server rejects the session (expired / logged out elsewhere). */
export function setUnauthorizedHandler(handler: (() => void) | null) {
  onUnauthorized = handler;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json", ...(init.headers as Record<string, string>) };
  if (authToken) headers.Authorization = `Bearer ${authToken}`;

  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, { ...init, headers });
  } catch {
    throw new ApiError(`Cannot reach the server at ${API_URL}. Check your connection and the API URL.`, 0);
  }

  let body: any = null;
  try {
    body = await res.json();
  } catch {
    /* empty body */
  }
  if (res.status === 401 && !path.startsWith("/api/auth/")) onUnauthorized?.();
  if (!res.ok) {
    const detail = body?.detail;
    throw new ApiError(typeof detail === "string" ? detail : `Request failed (${res.status})`, res.status);
  }
  return body as T;
}

const json = (data: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(data),
});

export const api = {
  requestOtp: (identifier: string) => request<OtpSent>("/api/auth/request-otp", json({ identifier })),
  verifyOtp: (identifier: string, code: string) =>
    request<{ token: string; user: User }>("/api/auth/verify-otp", json({ identifier, code })),
  me: () => request<User>("/api/auth/me"),
  logout: () => request<{ ok: boolean }>("/api/auth/logout", { method: "POST" }),

  listDocuments: () => request<DocumentSummary[]>("/api/documents"),
  getDocument: (id: string) => request<DocumentDetail>(`/api/documents/${id}`),
  getSection: (id: string, sectionId: string) =>
    request<SectionInfo & { text: string }>(`/api/documents/${id}/sections/${sectionId}`),
  deleteDocument: (id: string) => request<{ deleted: string }>(`/api/documents/${id}`, { method: "DELETE" }),

  /** Upload a local file (from the document picker or camera). */
  uploadDocument: (file: { uri: string; name: string; mimeType?: string | null; webFile?: File }) => {
    const form = new FormData();
    if (file.webFile) {
      form.append("file", file.webFile, file.name);
    } else {
      // React Native's FormData accepts {uri, name, type} file descriptors.
      form.append("file", { uri: file.uri, name: file.name, type: file.mimeType || "application/octet-stream" } as any);
    }
    return request<DocumentDetail>("/api/documents", { method: "POST", body: form });
  },

  summarize: (id: string, sectionIds: string[], style: SummaryStyle, refresh = false) =>
    request<{ summaries: SectionSummary[] }>(
      `/api/documents/${id}/summarize`,
      json({ section_ids: sectionIds, style, refresh }),
    ),

  ask: (question: string, docId?: string) =>
    request<{ answer: string; sources: Source[] }>("/api/qa", json({ question, doc_id: docId ?? null })),
};

export const pagesLabel = (start: number, end: number) => (start === end ? `p. ${start}` : `pp. ${start}–${end}`);
