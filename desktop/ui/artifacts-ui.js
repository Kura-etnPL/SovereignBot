"use strict";

(() => {
  if (!window.sovereignbot?.artifacts || typeof renderMessage !== "function") return;

  const baseRenderMessage = renderMessage;
  const baseRenderDetails = typeof renderDetails === "function" ? renderDetails : undefined;
  const t = (key, params) => globalThis.SovereignI18n?.t(key, params) ?? (typeof params === "string" ? params : key);

  function formatBytes(value) {
    const bytes = Number(value || 0);
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
    return `${(bytes / 1024 ** 2).toFixed(bytes < 10 * 1024 ** 2 ? 1 : 0)} MB`;
  }

  function iconFor(mimeType, fileName) {
    const mime = String(mimeType || "");
    const name = String(fileName || "").toLowerCase();
    if (mime.startsWith("image/")) return "▧";
    if (mime === "application/pdf" || name.endsWith(".pdf")) return "PDF";
    if (mime.includes("spreadsheet") || name.endsWith(".xlsx") || name.endsWith(".csv")) return "▦";
    if (mime.includes("presentation") || name.endsWith(".pptx")) return "▤";
    if (mime.includes("wordprocessing") || name.endsWith(".docx")) return "W";
    if (name.endsWith(".patch") || name.endsWith(".diff")) return "±";
    if (mime.startsWith("text/") || mime === "application/json") return "≡";
    return "◇";
  }

  function friendlyType(artifact) {
    const mime = String(artifact?.mimeType || "");
    const name = String(artifact?.fileName || "");
    const ext = name.includes(".") ? name.split(".").pop().toUpperCase() : "FILE";
    if (mime.startsWith("text/")) return ext || "TEXT";
    if (mime === "application/json") return "JSON";
    if (mime.startsWith("image/")) return ext || "IMAGE";
    return ext || "FILE";
  }

  function setCardError(card, error) {
    const status = card.querySelector(".artifact-card-status");
    if (!status) return;
    status.textContent = String(error?.message || error || "Artifact unavailable").replace(/^.*Error: /, "").slice(0, 180);
    status.classList.add("error");
  }

  function renderArtifactCard(artifactId, { compact = false } = {}) {
    const card = document.createElement("article");
    card.className = `artifact-card${compact ? " compact" : ""}`;
    card.dataset.artifactId = artifactId;

    const icon = document.createElement("div");
    icon.className = "artifact-icon";
    icon.textContent = "…";

    const copy = document.createElement("div");
    copy.className = "artifact-copy";
    const title = document.createElement("strong");
    title.textContent = t("artifacts.loadingResult");
    const meta = document.createElement("span");
    meta.textContent = artifactId;
    copy.append(title, meta);

    const actions = document.createElement("div");
    actions.className = "artifact-actions";
    const previewButton = document.createElement("button");
    previewButton.type = "button";
    previewButton.className = "artifact-action hidden";
    previewButton.textContent = t("common.preview");
    const revealButton = document.createElement("button");
    revealButton.type = "button";
    revealButton.className = "artifact-action";
    revealButton.textContent = t("common.reveal");
    revealButton.disabled = true;
    actions.append(previewButton, revealButton);

    const status = document.createElement("div");
    status.className = "artifact-card-status";
    const preview = document.createElement("pre");
    preview.className = "artifact-preview hidden";

    card.append(icon, copy, actions, status, preview);

    let artifact;
    let previewLoaded = false;

    window.sovereignbot.artifacts.get({ artifactId }).then((result) => {
      artifact = result;
      icon.textContent = iconFor(result.mimeType, result.fileName);
      title.textContent = result.title || result.fileName || "Artifact";
      meta.textContent = `${friendlyType(result)} · ${formatBytes(result.size)} · ${result.fileName || "result"}`;
      revealButton.disabled = false;
      if (String(result.mimeType || "").startsWith("text/") || result.mimeType === "application/json") {
        previewButton.classList.remove("hidden");
      }
    }).catch((error) => setCardError(card, error));

    revealButton.addEventListener("click", async () => {
      revealButton.disabled = true;
      try {
        await window.sovereignbot.artifacts.reveal({ artifactId });
      } catch (error) {
        setCardError(card, error);
      } finally {
        revealButton.disabled = false;
      }
    });

    previewButton.addEventListener("click", async () => {
      if (!artifact) return;
      if (!preview.classList.contains("hidden")) {
        preview.classList.add("hidden");
        previewButton.textContent = t("common.preview");
        return;
      }
      if (!previewLoaded) {
        previewButton.disabled = true;
        previewButton.textContent = t("common.refreshing");
        try {
          const result = await window.sovereignbot.artifacts.preview({ artifactId });
          preview.textContent = result?.preview ?? "Preview is not available for this file type.";
          if (result?.truncated) preview.textContent += "\n\n… preview truncated";
          previewLoaded = true;
        } catch (error) {
          setCardError(card, error);
          return;
        } finally {
          previewButton.disabled = false;
        }
      }
      preview.classList.remove("hidden");
      previewButton.textContent = t("artifacts.hidePreview");
    });

    return card;
  }

  renderMessage = function renderMessageWithArtifacts(conversation, message) {
    const row = baseRenderMessage(conversation, message);
    if (!Array.isArray(message?.artifactIds) || message.artifactIds.length === 0) return row;
    const content = row.querySelector(".chat-content");
    if (!content) return row;
    const stack = document.createElement("div");
    stack.className = "artifact-stack";
    for (const artifactId of message.artifactIds.slice(0, 12)) {
      stack.append(renderArtifactCard(artifactId));
    }
    content.append(stack);
    return row;
  };

  function ensureDetailsArtifacts() {
    const panel = document.getElementById("details-panel");
    if (!panel) return undefined;
    let section = document.getElementById("details-artifacts-section");
    if (section) return section;
    section = document.createElement("section");
    section.id = "details-artifacts-section";
    section.className = "detail-section";
    const label = document.createElement("span");
    label.className = "detail-label";
    label.textContent = "Artifacts";
    const list = document.createElement("div");
    list.id = "details-artifacts";
    list.className = "artifact-rail-list";
    section.append(label, list);
    const targetContainer = document.getElementById("details-body") || panel;
    const future = targetContainer.querySelector(".future-section");
    const ref = (future && future.parentNode === targetContainer) ? future : null;
    targetContainer.insertBefore(section, ref);
    for (const chip of panel.querySelectorAll(".future-chip-row span")) {
      if (chip.textContent.trim() === "Artifacts") chip.remove();
    }
    return section;
  }

  async function renderDetailsArtifacts(conversation) {
    const section = ensureDetailsArtifacts();
    const list = document.getElementById("details-artifacts");
    if (!section || !list || !conversation?.id) return;
    list.textContent = "";
    const loading = document.createElement("span");
    loading.className = "artifact-rail-empty";
    loading.textContent = "Loading…";
    list.append(loading);
    try {
      const result = await window.sovereignbot.artifacts.list({ conversationId: conversation.id, limit: 6 });
      if (state?.selectedConversationId !== conversation.id) return;
      list.textContent = "";
      const artifacts = result?.artifacts ?? [];
      if (!artifacts.length) {
        section.classList.add("hidden");
        return;
      }
      section.classList.remove("hidden");
      for (const artifact of artifacts) list.append(renderArtifactCard(artifact.id, { compact: true }));
    } catch (error) {
      list.textContent = "";
      section.classList.add("hidden");
    }
  }

  if (baseRenderDetails) {
    renderDetails = function renderDetailsWithArtifacts(conversation) {
      baseRenderDetails(conversation);
      renderDetailsArtifacts(conversation);
    };
  } else {
    ensureDetailsArtifacts();
  }
})();
