import { google } from "googleapis";

/** Adds/removes members of the single platform Google Group via the Workspace Admin SDK (Directory API). */
export interface GroupClient {
  add(groupEmail: string, email: string): Promise<void>;
  remove(groupEmail: string, email: string): Promise<void>;
}

export function directoryClient(adminUserToImpersonate: string): GroupClient {
  const auth = new google.auth.GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/admin.directory.group.member"],
    clientOptions: { subject: adminUserToImpersonate },
  });
  const dir = google.admin({ version: "directory_v1", auth });
  const code = (e: unknown) => (e as { code?: number }).code;
  return {
    async add(groupKey, email) {
      try { await dir.members.insert({ groupKey, requestBody: { email, role: "MEMBER" } }); }
      catch (e) { if (code(e) !== 409) throw e; } // already a member: idempotent
    },
    async remove(groupKey, email) {
      try { await dir.members.delete({ groupKey, memberKey: email }); }
      catch (e) { if (code(e) !== 404) throw e; }
    },
  };
}
