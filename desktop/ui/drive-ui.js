"use strict";

(() => {
  let currentUser = null;
  let cachedToken = null;
  let driveConfig = null;

  async function getDriveConfig() {
    if (!driveConfig) {
      const res = await window.sovereignbot.drive.config();
      driveConfig = res;
    }
    return driveConfig;
  }

  // Load Google Identity Services or Firebase Auth if needed
  async function initDriveAuth() {
    try {
      const config = await getDriveConfig();
      const token = sessionStorage.getItem("gdrive_token");
      const userStr = sessionStorage.getItem("gdrive_user");
      if (token && userStr) {
        cachedToken = token;
        currentUser = JSON.parse(userStr);
        renderDriveUI();
      }
    } catch (e) {
      console.warn("Drive auth init error:", e);
    }
  }

  async function signInWithGoogle() {
    const config = await getDriveConfig();
    if (!config.apiKey && !config.projectId) {
      alert("Google Drive 未配置 OAuth Client ID");
      return;
    }

    // Use OAuth popup with token client
    const clientId = config.oAuthClientId || "427842127369-rtdt4pi6ch6f1tl3ja2u22prn18qjrjr.apps.googleusercontent.com";
    const redirectUri = window.location.origin;
    const scope = encodeURIComponent("https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.metadata.readonly");

    // Open popup for Google OAuth2 Implicit Flow
    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=token&scope=${scope}&include_granted_scopes=true&prompt=consent`;

    const popup = window.open(authUrl, "google_oauth_popup", "width=600,height=700");

    // Polling popup URL for token or message listener
    const pollTimer = setInterval(() => {
      try {
        if (!popup || popup.closed) {
          clearInterval(pollTimer);
          return;
        }
        const popupUrl = popup.location.href;
        if (popupUrl && popupUrl.includes("access_token=")) {
          const hash = popup.location.hash.substring(1);
          const params = new URLSearchParams(hash);
          const token = params.get("access_token");
          if (token) {
            cachedToken = token;
            sessionStorage.setItem("gdrive_token", token);
            popup.close();
            clearInterval(pollTimer);
            fetchUserInfo(token);
          }
        }
      } catch (e) {
        // Cross-origin access might throw until redirect, which is normal
      }
    }, 500);
  }

  async function fetchUserInfo(token) {
    try {
      const res = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const user = await res.json();
        currentUser = user;
        sessionStorage.setItem("gdrive_user", JSON.stringify(user));
      } else {
        currentUser = { email: "Google User", name: "Authenticated" };
      }
    } catch (e) {
      currentUser = { email: "Google User", name: "Authenticated" };
    }
    renderDriveUI();
    loadDriveFiles();
  }

  function signOutGoogle() {
    cachedToken = null;
    currentUser = null;
    sessionStorage.removeItem("gdrive_token");
    sessionStorage.removeItem("gdrive_user");
    renderDriveUI();
  }

  async function loadDriveFiles(query = "") {
    const listEl = document.getElementById("gdrive-file-list");
    const statusEl = document.getElementById("gdrive-status");
    if (!listEl) return;

    if (!cachedToken) {
      listEl.innerHTML = `<div class="drive-empty-notice">请先点击下方“Sign in with Google”完成授权，即可在此直接管理与同步 Google Drive 网盘文件。</div>`;
      return;
    }

    if (statusEl) statusEl.textContent = "正在从 Google Drive 获取文件列表…";
    listEl.innerHTML = `<div class="drive-loading">加载中…</div>`;

    try {
      const res = await window.sovereignbot.drive.list({ accessToken: cachedToken, query });
      const files = res.files || [];
      if (statusEl) statusEl.textContent = `已连接 Google Drive · 共找到 ${files.length} 个文件`;

      if (files.length === 0) {
        listEl.innerHTML = `<div class="drive-empty-notice">Google Drive 中暂无文件或未检索到匹配项。</div>`;
        return;
      }

      listEl.innerHTML = files
        .map(
          (f) => `
        <div class="drive-file-card" id="drive-file-${f.id}">
          <div class="drive-file-info">
            <div class="drive-file-icon">📄</div>
            <div class="drive-file-meta">
              <div class="drive-file-name" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</div>
              <div class="drive-file-sub">
                <span>${f.size ? formatBytes(f.size) : "Google 文档"}</span>
                <span>·</span>
                <span>${f.modifiedTime ? new Date(f.modifiedTime).toLocaleString() : ""}</span>
              </div>
            </div>
          </div>
          <div class="drive-file-actions">
            ${f.webViewLink ? `<a href="${f.webViewLink}" target="_blank" rel="noopener noreferrer" class="quiet-action drive-open-btn">在 Drive 打开 ↗</a>` : ""}
            <button type="button" class="quiet-action drive-delete-btn" data-id="${f.id}" data-name="${escapeHtml(f.name)}">删除</button>
          </div>
        </div>
      `
        )
        .join("");

      // Bind delete handlers with explicit confirmation
      listEl.querySelectorAll(".drive-delete-btn").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const fileId = btn.getAttribute("data-id");
          const fileName = btn.getAttribute("data-name");
          const confirmed = confirm(`确定要从 Google Drive 中删除文件 “${fileName}” 吗？此操作不可撤销。`);
          if (!confirmed) return;

          try {
            btn.disabled = true;
            btn.textContent = "删除中…";
            await window.sovereignbot.drive.delete({ accessToken: cachedToken, fileId });
            loadDriveFiles(query);
          } catch (err) {
            alert(`删除失败: ${err.message}`);
            btn.disabled = false;
            btn.textContent = "删除";
          }
        });
      });
    } catch (err) {
      if (statusEl) statusEl.textContent = `获取失败: ${err.message}`;
      listEl.innerHTML = `<div class="inline-error">获取 Google Drive 文件失败: ${err.message}。可能是授权凭证已过期，请重新登录。</div>`;
    }
  }

  async function uploadToDrive(name, content, mimeType) {
    if (!cachedToken) {
      alert("请先登录 Google 账号");
      return;
    }
    const statusEl = document.getElementById("gdrive-status");
    if (statusEl) statusEl.textContent = "正在上传文件到 Google Drive…";
    try {
      const res = await window.sovereignbot.drive.upload({
        accessToken: cachedToken,
        name,
        content,
        mimeType,
      });
      if (statusEl) statusEl.textContent = `上传成功！文件已存入 Google Drive: ${res.name}`;
      loadDriveFiles();
      return res;
    } catch (err) {
      if (statusEl) statusEl.textContent = `上传失败: ${err.message}`;
      alert(`上传至 Google Drive 失败: ${err.message}`);
      throw err;
    }
  }

  function renderDriveUI() {
    const authContainer = document.getElementById("gdrive-auth-container");
    const userContainer = document.getElementById("gdrive-user-container");
    const emailEl = document.getElementById("gdrive-user-email");
    const nameEl = document.getElementById("gdrive-user-name");

    if (currentUser && cachedToken) {
      if (authContainer) authContainer.classList.add("hidden");
      if (userContainer) userContainer.classList.remove("hidden");
      if (emailEl) emailEl.textContent = currentUser.email || "";
      if (nameEl) nameEl.textContent = currentUser.name || "Google User";
    } else {
      if (authContainer) authContainer.classList.remove("hidden");
      if (userContainer) userContainer.classList.add("hidden");
    }
  }

  function formatBytes(bytes) {
    const num = Number(bytes);
    if (!num || isNaN(num)) return "0 B";
    if (num < 1024) return `${num} B`;
    if (num < 1024 * 1024) return `${(num / 1024).toFixed(1)} KB`;
    return `${(num / (1024 * 1024)).toFixed(1)} MB`;
  }

  function escapeHtml(str) {
    if (!str) return "";
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  window.driveUi = {
    init: initDriveAuth,
    signIn: signInWithGoogle,
    signOut: signOutGoogle,
    loadFiles: loadDriveFiles,
    uploadFile: uploadToDrive,
    getToken: () => cachedToken,
    getUser: () => currentUser,
  };

  document.addEventListener("DOMContentLoaded", () => {
    initDriveAuth();

    const signinBtn = document.getElementById("gdrive-signin-btn");
    if (signinBtn) {
      signinBtn.addEventListener("click", signInWithGoogle);
    }

    const signoutBtn = document.getElementById("gdrive-signout-btn");
    if (signoutBtn) {
      signoutBtn.addEventListener("click", signOutGoogle);
    }

    const refreshBtn = document.getElementById("gdrive-refresh-btn");
    if (refreshBtn) {
      refreshBtn.addEventListener("click", () => loadDriveFiles());
    }

    const searchInput = document.getElementById("gdrive-search-input");
    if (searchInput) {
      let timeout;
      searchInput.addEventListener("input", (e) => {
        clearTimeout(timeout);
        timeout = setTimeout(() => {
          loadDriveFiles(e.target.value.trim());
        }, 300);
      });
    }

    const uploadBtn = document.getElementById("gdrive-new-upload-btn");
    if (uploadBtn) {
      uploadBtn.addEventListener("click", () => {
        const fileName = prompt("请输入要备份/上传到 Google Drive 的文件名:", `sovereign-note-${new Date().toISOString().slice(0, 10)}.txt`);
        if (!fileName) return;
        const fileContent = prompt("请输入文件内容:", `SovereignBot Workspace Backup - Generated on ${new Date().toLocaleString()}`);
        if (fileContent === null) return;
        uploadToDrive(fileName, fileContent, "text/plain");
      });
    }
  });
})();
