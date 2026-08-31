"use strict";

(() => {
  if (!window.sovereignbot?.skills || !window.sovereignbot?.conversations || !window.sovereignbot?.artifacts?.attachViaDialog) return;

  let skills = [];
  const selectedSkills = new Set();
  let attachments = [];

  function el(tag, className, textValue) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (textValue !== undefined) node.textContent = textValue;
    return node;
  }

  async function refreshSkills() {
    const result = await window.sovereignbot.skills.list({});
    skills = result?.skills ?? [];
    for (const id of [...selectedSkills]) {
      if (!skills.some((skill) => skill.id === id)) selectedSkills.delete(id);
    }
    renderDraftExtensions();
    renderSkillList();
  }

  function chosenSkills() {
    return skills.filter((skill) => selectedSkills.has(skill.id));
  }

  function ensureComposerSurface() {
    const tools = document.querySelector(".composer-tools");
    const hint = document.getElementById("composer-hint");
    if (tools && hint && !document.getElementById("composer-skills")) {
      const button = el("button", "composer-tool skill-trigger", "✦");
      button.id = "composer-skills";
      button.type = "button";
      button.title = "Use a skill";
      button.setAttribute("aria-label", "Use a skill");
      button.addEventListener("click", openSkillDialog);
      tools.insertBefore(button, hint);
    }

    const add = document.getElementById("composer-add");
    if (add) {
      add.title = "Attach files";
      add.setAttribute("aria-label", "Attach files");
      add.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopImmediatePropagation();
        void pickAttachments();
      }, true);
    }

    const composerBox = document.querySelector(".composer-box");
    if (composerBox && !document.getElementById("draft-extensions")) {
      const row = el("div", "selected-skills hidden");
      row.id = "draft-extensions";
      composerBox.parentElement?.insertBefore(row, composerBox);
    }
  }

  function renderDraftExtensions() {
    ensureComposerSurface();
    const row = document.getElementById("draft-extensions");
    if (!row) return;
    row.textContent = "";
    const skillRows = chosenSkills();
    row.classList.toggle("hidden", skillRows.length === 0 && attachments.length === 0);

    for (const artifact of attachments) {
      const chip = el("button", "selected-skill attachment-chip", `＋ ${artifact.fileName || artifact.title} ×`);
      chip.type = "button";
      chip.title = "Remove attachment from next message";
      chip.addEventListener("click", () => {
        attachments = attachments.filter((entry) => entry.id !== artifact.id);
        renderDraftExtensions();
      });
      row.append(chip);
    }

    for (const skill of skillRows) {
      const chip = el("button", "selected-skill", `✦ ${skill.name} ×`);
      chip.type = "button";
      chip.title = "Remove skill from next message";
      chip.addEventListener("click", () => {
        selectedSkills.delete(skill.id);
        renderDraftExtensions();
        renderSkillList();
      });
      row.append(chip);
    }
  }

  async function pickAttachments() {
    const conversation = state.selectedConversation;
    if (!conversation) return;
    const add = document.getElementById("composer-add");
    if (add) add.disabled = true;
    try {
      const result = await window.sovereignbot.artifacts.attachViaDialog({ conversationId: conversation.id });
      if (result?.canceled) return;
      for (const artifact of result?.artifacts ?? []) {
        if (!attachments.some((entry) => entry.id === artifact.id)) attachments.push(artifact);
      }
      if (attachments.length > 12) attachments = attachments.slice(-12);
      renderDraftExtensions();
      if (result?.errors?.length) {
        $("composer-error").textContent = `${result.errors.length} file(s) could not be attached.`;
        show($("composer-error"));
      }
    } catch (error) {
      $("composer-error").textContent = text(error?.message || error).replace(/^.*Error: /, "");
      show($("composer-error"));
    } finally {
      if (add) add.disabled = false;
    }
  }

  function ensureDialog() {
    let dialog = document.getElementById("skills-dialog");
    if (dialog) return dialog;
    dialog = el("dialog", "modal skill-modal");
    dialog.id = "skills-dialog";
    const shell = el("div", "modal-card skill-modal-card");
    const head = el("div", "modal-heading");
    const copy = document.createElement("div");
    copy.append(el("span", "eyebrow", "SKILLS"), el("h2", "", "Reusable ways of working"));
    const close = el("button", "modal-x", "×");
    close.type = "button";
    close.addEventListener("click", () => dialog.close());
    head.append(copy, close);
    const description = el("p", "skill-modal-copy", "Select one or more skills for your next message. Skills guide how the coworker works; they do not grant extra permissions.");
    const list = el("div", "skill-list");
    list.id = "skill-list";
    const createToggle = el("button", "quiet-action skill-new-toggle", "+ New skill");
    createToggle.type = "button";
    const form = el("form", "skill-create-form hidden");
    form.id = "skill-create-form";
    const nameLabel = document.createElement("label");
    nameLabel.textContent = "Name";
    const name = document.createElement("input");
    name.id = "skill-name";
    name.maxLength = 100;
    name.placeholder = "e.g. Release a GitHub build";
    name.required = true;
    nameLabel.append(name);
    const descLabel = document.createElement("label");
    descLabel.textContent = "What it does";
    const desc = document.createElement("input");
    desc.id = "skill-description";
    desc.maxLength = 280;
    desc.placeholder = "Short description";
    descLabel.append(desc);
    const instructionsLabel = document.createElement("label");
    instructionsLabel.textContent = "Instructions";
    const instructions = document.createElement("textarea");
    instructions.id = "skill-instructions";
    instructions.rows = 6;
    instructions.maxLength = 16000;
    instructions.placeholder = "Describe the repeatable workflow, quality bar, and expected result…";
    instructions.required = true;
    instructionsLabel.append(instructions);
    const error = el("p", "inline-error hidden");
    error.id = "skill-form-error";
    const actions = el("div", "skill-form-actions");
    const cancel = el("button", "quiet-action", "Cancel");
    cancel.type = "button";
    cancel.addEventListener("click", () => form.classList.add("hidden"));
    const save = el("button", "hero-action", "Create skill");
    save.type = "submit";
    actions.append(cancel, save);
    form.append(nameLabel, descLabel, instructionsLabel, error, actions);

    createToggle.addEventListener("click", () => form.classList.toggle("hidden"));
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      error.classList.add("hidden");
      save.disabled = true;
      try {
        const created = await window.sovereignbot.skills.create({
          skill: { name: name.value.trim(), description: desc.value.trim(), instructions: instructions.value.trim() },
        });
        selectedSkills.add(created.id);
        form.reset();
        form.classList.add("hidden");
        await refreshSkills();
      } catch (reason) {
        error.textContent = String(reason?.message || reason).replace(/^.*Error: /, "");
        error.classList.remove("hidden");
      } finally {
        save.disabled = false;
      }
    });

    shell.append(head, description, list, createToggle, form);
    dialog.append(shell);
    document.body.append(dialog);
    return dialog;
  }

  function renderSkillList() {
    const list = document.getElementById("skill-list");
    if (!list) return;
    list.textContent = "";
    if (!skills.length) {
      list.append(el("div", "skill-empty", "No skills yet. Create one from a workflow you want to reuse."));
      return;
    }
    for (const skill of skills) {
      const row = el("label", `skill-option${selectedSkills.has(skill.id) ? " selected" : ""}`);
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = selectedSkills.has(skill.id);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) selectedSkills.add(skill.id);
        else selectedSkills.delete(skill.id);
        renderDraftExtensions();
        renderSkillList();
      });
      const icon = el("span", "skill-option-icon", "✦");
      const body = document.createElement("div");
      body.className = "skill-option-copy";
      body.append(el("strong", "", skill.name), el("span", "", skill.description || "Reusable coworker workflow"));
      const assignment = el("div", "skill-assignment");
      assignment.append(el("span", "skill-assignment-label", "Usable by / 可用对象"));
      const assigned = [
        ...(skill.assignedCoworkerIds ?? []).map((id) => ({ kind: "coworker", id, label: state.coworkers.find((entry) => entry.id === id)?.name })),
        ...(skill.assignedTeamIds ?? []).map((id) => ({ kind: "team", id, label: state.teams.find((entry) => entry.id === id)?.name })),
      ].filter((entry) => entry.label);
      for (const target of assigned) {
        const chip = el("button", "skill-assignment-chip", target.label + " ×");
        chip.type = "button";
        chip.title = "Remove assignment / 移除分配";
        chip.addEventListener("click", async (event) => {
          event.preventDefault();
          event.stopPropagation();
          await window.sovereignbot.skills.assign({ skillId: skill.id, targetKind: target.kind, targetId: target.id, enabled: false });
          await refreshSkills();
        });
        assignment.append(chip);
      }
      const select = document.createElement("select");
      select.className = "skill-assignment-select";
      select.title = "Assign this skill to a coworker or team";
      select.append(el("option", "", "Assign… / 分配…"));
      for (const coworker of state.coworkers ?? []) {
        const option = el("option", "", "Coworker · " + coworker.name);
        option.value = "coworker:" + coworker.id;
        select.append(option);
      }
      for (const team of state.teams ?? []) {
        const option = el("option", "", "Team · " + team.name);
        option.value = "team:" + team.id;
        select.append(option);
      }
      select.addEventListener("click", (event) => event.stopPropagation());
      select.addEventListener("change", async () => {
        const [targetKind, targetId] = select.value.split(":");
        select.value = "";
        if (!targetKind || !targetId) return;
        try {
          await window.sovereignbot.skills.assign({ skillId: skill.id, targetKind, targetId, enabled: true });
          await refreshSkills();
        } catch (error) {
          select.title = String(error?.message || error).replace(/^.*Error: /, "").slice(0, 180);
        }
      });
      assignment.append(select);
      body.append(assignment);
      row.append(checkbox, icon, body);
      list.append(row);
    }
  }

  async function openSkillDialog() {
    const dialog = ensureDialog();
    try { await refreshSkills(); } catch {}
    dialog.showModal();
  }

  async function sendWithExtensions(event) {
    event?.preventDefault();
    const conversation = state.selectedConversation;
    if (!conversation) return;
    const area = $("composer-input");
    const typed = area.value.trim();
    if (!typed && attachments.length === 0) return;
    const value = typed || (attachments.length === 1 ? "Review the attached file." : "Review the attached files.");
    hide($("composer-error"));
    $("composer-send").disabled = true;
    try {
      const pending = pendingUserRecipients(conversation);
      const redirecting = state.redirectMode && pending.size && selectedSkills.size === 0 && attachments.length === 0;
      const payload = {
        conversationId: conversation.id,
        text: value,
        ...(state.mentionIds.size ? { mentions: [...state.mentionIds] } : {}),
        ...(state.replyTo ? { replyTo: state.replyTo } : {}),
        ...(selectedSkills.size ? { skillIds: [...selectedSkills] } : {}),
        ...(attachments.length ? { artifactIds: attachments.map((entry) => entry.id) } : {}),
        clientMessageId: `ui-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      };
      await (redirecting ? window.sovereignbot.conversations.redirect : window.sovereignbot.conversations.send)(payload);
      area.value = "";
      autoSizeComposer();
      state.mentionIds.clear();
      state.replyTo = undefined;
      state.redirectMode = false;
      selectedSkills.clear();
      attachments = [];
      renderDraftExtensions();
      await refreshConversation(true);
    } catch (error) {
      $("composer-error").textContent = text(error?.message || error).replace(/^.*Error: /, "");
      show($("composer-error"));
    } finally {
      $("composer-send").disabled = false;
    }
  }

  function interceptExtendedSend() {
    const form = document.getElementById("composer-form");
    const area = document.getElementById("composer-input");
    if (!form || !area) return;
    form.addEventListener("submit", (event) => {
      if (!selectedSkills.size && !attachments.length) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void sendWithExtensions(event);
    }, true);
    area.addEventListener("keydown", (event) => {
      if ((!selectedSkills.size && !attachments.length) || event.key !== "Enter" || event.shiftKey) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void sendWithExtensions(event);
    }, true);
  }

  ensureComposerSurface();
  ensureDialog();
  interceptExtendedSend();
  refreshSkills().catch(() => {});
})();
