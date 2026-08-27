"use strict";

(() => {
  if (!window.sovereignbot?.skills || !window.sovereignbot?.conversations) return;

  let skills = [];
  const selected = new Set();

  function el(tag, className, textValue) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (textValue !== undefined) node.textContent = textValue;
    return node;
  }

  async function refreshSkills() {
    const result = await window.sovereignbot.skills.list({});
    skills = result?.skills ?? [];
    for (const id of [...selected]) {
      if (!skills.some((skill) => skill.id === id)) selected.delete(id);
    }
    renderSelected();
    renderSkillList();
  }

  function selectedSkills() {
    return skills.filter((skill) => selected.has(skill.id));
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

    const composerBox = document.querySelector(".composer-box");
    if (composerBox && !document.getElementById("selected-skills")) {
      const row = el("div", "selected-skills hidden");
      row.id = "selected-skills";
      composerBox.parentElement?.insertBefore(row, composerBox);
    }
  }

  function renderSelected() {
    ensureComposerSurface();
    const row = document.getElementById("selected-skills");
    if (!row) return;
    row.textContent = "";
    const chosen = selectedSkills();
    row.classList.toggle("hidden", chosen.length === 0);
    for (const skill of chosen) {
      const chip = el("button", "selected-skill", `✦ ${skill.name} ×`);
      chip.type = "button";
      chip.title = "Remove skill from next message";
      chip.addEventListener("click", () => {
        selected.delete(skill.id);
        renderSelected();
        renderSkillList();
      });
      row.append(chip);
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
          skill: {
            name: name.value.trim(),
            description: desc.value.trim(),
            instructions: instructions.value.trim(),
          },
        });
        selected.add(created.id);
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
      const row = el("label", `skill-option${selected.has(skill.id) ? " selected" : ""}`);
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = selected.has(skill.id);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) selected.add(skill.id);
        else selected.delete(skill.id);
        renderSelected();
        renderSkillList();
      });
      const icon = el("span", "skill-option-icon", "✦");
      const body = document.createElement("div");
      body.className = "skill-option-copy";
      body.append(el("strong", "", skill.name), el("span", "", skill.description || "Reusable coworker workflow"));
      row.append(checkbox, icon, body);
      list.append(row);
    }
  }

  async function openSkillDialog() {
    const dialog = ensureDialog();
    try { await refreshSkills(); } catch {}
    dialog.showModal();
  }

  async function sendWithSkills(event) {
    event?.preventDefault();
    const conversation = state.selectedConversation;
    if (!conversation) return;
    const area = $("composer-input");
    const value = area.value.trim();
    if (!value) return;
    hide($("composer-error"));
    $("composer-send").disabled = true;
    try {
      await window.sovereignbot.conversations.send({
        conversationId: conversation.id,
        text: value,
        ...(state.mentionIds.size ? { mentions: [...state.mentionIds] } : {}),
        skillIds: [...selected],
        clientMessageId: `ui-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      });
      area.value = "";
      autoSizeComposer();
      state.mentionIds.clear();
      selected.clear();
      renderSelected();
      await refreshConversation(true);
    } catch (error) {
      $("composer-error").textContent = text(error?.message || error).replace(/^.*Error: /, "");
      show($("composer-error"));
    } finally {
      $("composer-send").disabled = false;
    }
  }

  function interceptSelectedSkillSend() {
    const form = document.getElementById("composer-form");
    const area = document.getElementById("composer-input");
    if (!form || !area) return;
    form.addEventListener("submit", (event) => {
      if (!selected.size) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void sendWithSkills(event);
    }, true);
    area.addEventListener("keydown", (event) => {
      if (!selected.size || event.key !== "Enter" || event.shiftKey) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void sendWithSkills(event);
    }, true);
  }

  ensureComposerSurface();
  ensureDialog();
  interceptSelectedSkillSend();
  refreshSkills().catch(() => {});
})();
