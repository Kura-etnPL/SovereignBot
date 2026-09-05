import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

let firebaseConfig = null;
try {
  const configPath = join(process.cwd(), "firebase-applet-config.json");
  if (existsSync(configPath)) {
    firebaseConfig = JSON.parse(readFileSync(configPath, "utf8"));
  }
} catch (e) {
  console.warn("Could not read firebase-applet-config.json:", e);
}

export function createGoogleDriveService() {
  return {
    getConfig() {
      return {
        configured: Boolean(firebaseConfig?.apiKey),
        projectId: firebaseConfig?.projectId || "",
        appId: firebaseConfig?.appId || "",
        apiKey: firebaseConfig?.apiKey || "",
        authDomain: firebaseConfig?.authDomain || "",
        scopes: [
          "https://www.googleapis.com/auth/drive",
          "https://www.googleapis.com/auth/drive.file",
          "https://www.googleapis.com/auth/drive.readonly",
          "https://www.googleapis.com/auth/drive.metadata.readonly",
        ],
      };
    },

    async listFiles({ accessToken, query = "", pageSize = 30 } = {}) {
      if (!accessToken) {
        throw new Error("Access token required for Google Drive API calls");
      }
      const qParams = new URLSearchParams({
        pageSize: String(pageSize),
        fields: "nextPageToken, files(id, name, mimeType, size, modifiedTime, webViewLink, iconLink, thumbnailLink)",
        orderBy: "modifiedTime desc",
      });
      if (query) {
        qParams.append("q", `name contains '${query.replace(/'/g, "\\'")}' and trashed = false`);
      } else {
        qParams.append("q", "trashed = false");
      }

      const res = await fetch(`https://www.googleapis.com/drive/v3/files?${qParams.toString()}`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
        },
      });

      if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`Google Drive API error (${res.status}): ${errorText}`);
      }
      return await res.json();
    },

    async uploadFile({ accessToken, name, mimeType = "text/plain", content, description = "Exported from SovereignBot" }) {
      if (!accessToken) {
        throw new Error("Access token required for Google Drive upload");
      }

      const metadata = {
        name: name || `sovereignbot-export-${Date.now()}.txt`,
        mimeType: mimeType,
        description: description,
      };

      const boundary = `-------SovereignBotBoundary${Date.now()}`;
      const delimiter = `\r\n--${boundary}\r\n`;
      const closeDelimiter = `\r\n--${boundary}--`;

      const multipartBody =
        delimiter +
        "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
        JSON.stringify(metadata) +
        delimiter +
        `Content-Type: ${mimeType}\r\n\r\n` +
        (typeof content === "string" ? content : Buffer.from(content).toString("utf8")) +
        closeDelimiter;

      const res = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": `multipart/related; boundary=${boundary}`,
        },
        body: multipartBody,
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Google Drive upload failed (${res.status}): ${errText}`);
      }
      return await res.json();
    },

    async deleteFile({ accessToken, fileId }) {
      if (!accessToken || !fileId) {
        throw new Error("Access token and fileId required");
      }
      const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });
      if (!res.ok && res.status !== 204) {
        const errText = await res.text();
        throw new Error(`Google Drive delete failed (${res.status}): ${errText}`);
      }
      return { ok: true, fileId };
    },
  };
}
