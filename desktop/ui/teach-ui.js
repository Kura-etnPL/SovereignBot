"use strict";

(() => {
  if (!window.sovereignbot?.teachOnce || typeof renderDetails !== "function") return;

  let session;
  let snapshot;

  const $ = (id) => document.getElementById(id);
  const participantList = () => typeof participantCoworkers === "function"
    ? participantCoworkers(state.selectedConversation)
    : [];
  const errorText = (error) => String(error?.message || error).replace(/^.*Error: /, "").slice(0, 400);

  function make(tag, className, value) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (value !== undefined) node.textContent = value;
    return node;
  }

  function ensureSection() {
    const panel = $("details-panel");
    if (!panel) return undefined;
    let section = $("details-teach-section");
    if (section) return section;
    section = make("section", "detail-section teach-section");
    section.id = "details-teach-section";
    const label = make("span", "detail-label", "Teach Once / 教它一次");
    const copy = make("p", "teach-section-copy", "Demonstrate a semantic Computer workflow and turn it into a reusable Skill.");
    const button = make("button", "computer-action primary", "Teach a task / 教它一个任务");
    button.type = "button";
    button.addEventListener("click", () => openDialog());
    section.append(label, copy, button);
    const computer = $("details-computer-section");
    panel.insertBefore(section, computer?.nextSibling || panel.querySelector(".future-section") || null);
    return section;
  }

  function ensureDialog() {
    let dialog = $("teach-dialog");
    if (dialog) return dialog;
    dialog = document.createElement("dialog");
    dialog.id = "teach-dialog";
    dialog.className = "modal teach-modal";
    dialog.innerHTML = `
      <div class="modal-card">
        <div class="modal-heading"><div><span class="eyebrow">TEACH ONCE / 教它一次</span><h2>Teach a task</h2></div><button id="teach-close" class="modal-x" type="button">×</button></div>
        <p class="teach-copy">Use the current Computer lane. Actions are governed, targets are semantic, and demo input is never saved.</p>
        <div id="teach-start-panel" class="teach-panel">
          <label>Name / 名称<input id="teach-name" maxlength="100" placeholder="e.g. Prepare a weekly report" required></label>
          <label>Description / 描述<input id="teach-description" maxlength="280" placeholder="What should this task accomplish?"></label>
          <label>Coworker / 同事<select id="teach-coworker"></select></label>
          <p id="teach-start-error" class="inline-error hidden"></p>
          <div class="modal-actions"><button id="teach-start" class="hero-action" type="button">Start demonstration / 开始演示</button></div>
        </div>
        <div id="teach-record-panel" class="teach-panel hidden">
          <div class="teach-session-head"><div><strong id="teach-session-title"></strong><span id="teach-session-state" class="job-status working">Recording</span></div><button id="teach-snapshot" class="quiet-action" type="button">Read current screen / 读取当前页面</button></div>
          <p id="teach-context" class="setting-feedback"></p>
          <div id="teach-elements" class="teach-elements"></div>
          <div class="teach-action-form">
            <label>Action / 动作<select id="teach-action-kind"><option value="click">Click semantic target / 点击语义目标</option><option value="type">Type input / 输入内容</option><option value="navigate">Navigate / 打开网站</option><option value="key">Press key / 按键</option><option value="scroll">Scroll / 滚动</option><option value="wait">Wait / 等待</option><option value="assert">Verify output / 验证结果</option></select></label>
            <label id="teach-ref-field">Target from current screen / 当前页面目标<select id="teach-ref"><option value="">Read the screen first / 先读取页面</option></select></label>
            <label id="teach-target-field">Semantic target / 语义目标<input id="teach-target" maxlength="240" placeholder="e.g. Submit button"></label>
            <label id="teach-app-field">App (optional) / 应用（可选）<input id="teach-app" maxlength="120" placeholder="e.g. GitHub"></label>
            <label id="teach-url-field" class="hidden">Site URL / 网站地址<input id="teach-url" maxlength="2000" placeholder="https://example.com"></label>
            <label id="teach-input-name-field" class="hidden">Reusable input name / 可复用输入名<input id="teach-input-name" maxlength="80" placeholder="report_period"></label>
            <label id="teach-demo-value-field" class="hidden">Demo value (not saved) / 演示值（不会保存）<input id="teach-demo-value" maxlength="4000" autocomplete="off"></label>
            <label id="teach-sensitive-field" class="hidden toggle-row"><span><strong>Sensitive demo input / 敏感演示输入</strong><small>The value is used once and never persisted.</small></span><input id="teach-sensitive" type="checkbox"></label>
            <label id="teach-key-field" class="hidden">Key / 按键<select id="teach-key"><option>Enter</option><option>Tab</option><option>Escape</option><option>Space</option><option>Backspace</option><option>Delete</option><option>ArrowUp</option><option>ArrowDown</option><option>ArrowLeft</option><option>ArrowRight</option></select></label>
            <label id="teach-scroll-field" class="hidden">Scroll / 滚动<select id="teach-direction"><option value="down">Down / 向下</option><option value="up">Up / 向上</option></select><input id="teach-amount" type="number" min="1" max="10" value="1"></label>
            <label id="teach-wait-field" class="hidden">Milliseconds / 毫秒<input id="teach-milliseconds" type="number" min="0" max="10000" value="500"></label>
            <label id="teach-validator-field" class="hidden">Validator / 验证方式<select id="teach-validator"><option value="exists">Exists / 存在</option><option value="contains">Contains / 包含</option><option value="equals">Equals / 等于</option><option value="manual">Manual check / 手动确认</option></select></label>
            <label id="teach-expected-field" class="hidden">Expected output / 预期结果<input id="teach-expected" maxlength="500" placeholder="e.g. Report is ready"></label>
            <p id="teach-action-error" class="inline-error hidden"></p>
            <div class="modal-actions"><button id="teach-record" class="hero-action" type="button">Perform & record / 执行并记录</button></div>
          </div>
          <div><span class="detail-label">Recorded semantic steps / 已记录语义步骤</span><ol id="teach-actions" class="teach-actions"></ol></div>
          <div class="modal-actions"><button id="teach-finish" class="quiet-action" type="button">Create Skill draft / 生成 Skill 草稿</button><button id="teach-cancel" class="quiet-action" type="button">Cancel / 取消</button></div>
        </div>
        <div id="teach-draft-panel" class="teach-panel hidden">
          <div class="teach-session-head"><div><strong id="teach-draft-title"></strong><span id="teach-draft-state" class="job-status">Draft</span></div></div>
          <p id="teach-draft-description" class="teach-copy"></p>
          <ol id="teach-draft-steps" class="teach-actions"></ol>
          <div id="teach-draft-meta" class="teach-draft-meta"></div>
          <p id="teach-draft-error" class="inline-error hidden"></p>
          <div class="modal-actions"><button id="teach-test" class="quiet-action" type="button">Test / 测试</button><button id="teach-save" class="hero-action" type="button" disabled>Save Skill / 保存 Skill</button><button id="teach-draft-close" class="quiet-action" type="button">Close / 关闭</button></div>
        </div>
        <p id="teach-result" class="setting-feedback"></p>
      </div>`;
    document.body.append(dialog);
    $("teach-close").addEventListener("click", () => dialog.close());
    $("teach-start").addEventListener("click", startTeaching);
    $("teach-snapshot").addEventListener("click", readScreen);
    $("teach-action-kind").addEventListener("change", renderActionFields);
    $("teach-ref").addEventListener("change", () => {
      const option = $("teach-ref").selectedOptions[0];
      if (option?.dataset?.name && !$("teach-target").value) $("teach-target").value = option.dataset.name;
    });
    $("teach-record").addEventListener("click", recordAction);
    $("teach-finish").addEventListener("click", finishTeaching);
    $("teach-cancel").addEventListener("click", cancelTeaching);
    $("teach-test").addEventListener("click", testDraft);
    $("teach-save").addEventListener("click", saveSkill);
    $("teach-draft-close").addEventListener("click", () => dialog.close());
    renderActionFields();
    return dialog;
  }

  function fillCoworkers() {
    const select = $("teach-coworker");
    if (!select) return;
    select.textContent = "";
    for (const coworker of participantList()) {
      const option = document.createElement("option");
      option.value = coworker.id;
      option.textContent = `${coworker.name} — ${coworker.role}`;
      select.append(option);
    }
    if (!select.options.length) {
      const option = document.createElement("option");
      option.textContent = "Open a Coworker conversation first / 请先打开同事会话";
      option.value = "";
      select.append(option);
    }
  }

  function setPanel(name) {
    for (const id of ["teach-start-panel", "teach-record-panel", "teach-draft-panel"]) $(id)?.classList.toggle("hidden", id !== `teach-${name}-panel`);
  }

  function openDialog() {
    const dialog = ensureDialog();
    if (!session || session.state === "saved" || session.state === "cancelled") {
      session = undefined;
      snapshot = undefined;
      fillCoworkers();
      $("teach-start-error")?.classList.add("hidden");
      setPanel("start");
    } else if (session.draft) {
      renderDraft(session);
      setPanel("draft");
    } else {
      renderSession(session);
      setPanel("record");
    }
    dialog.showModal();
  }

  async function startTeaching() {
    const error = $("teach-start-error");
    error?.classList.add("hidden");
    try {
      session = await window.sovereignbot.teachOnce.start({
        coworkerId: $("teach-coworker").value,
        name: $("teach-name").value.trim(),
        description: $("teach-description").value.trim(),
      });
      snapshot = undefined;
      renderSession(session);
      setPanel("record");
    } catch (reason) {
      if (error) { error.textContent = errorText(reason); error.classList.remove("hidden"); }
    }
  }

  async function readScreen() {
    if (!session) return;
    const button = $("teach-snapshot");
    button.disabled = true;
    try {
      snapshot = await window.sovereignbot.teachOnce.snapshot({ sessionId: session.id });
      $("teach-context").textContent = snapshot.site ? `Current site: ${snapshot.site} · semantic targets only / 当前网站：${snapshot.site} · 仅记录语义目标` : "Current screen read. Choose an accessible target below / 已读取当前页面，请选择语义目标";
      renderElements();
      $("teach-action-error")?.classList.add("hidden");
    } catch (reason) {
      const error = $("teach-action-error");
      if (error) { error.textContent = errorText(reason); error.classList.remove("hidden"); }
    } finally {
      button.disabled = false;
    }
  }

  function renderElements() {
    const list = $("teach-elements");
    const select = $("teach-ref");
    if (!list || !select) return;
    list.textContent = "";
    select.textContent = "";
    for (const element of snapshot?.elements ?? []) {
      const option = document.createElement("option");
      option.value = element.ref;
      option.dataset.name = element.name || `${element.role} target`;
      option.textContent = `${element.role}${element.name ? ` · ${element.name}` : ""}`;
      select.append(option);
      const button = make("button", "teach-element", `${element.role}${element.name ? ` · ${element.name}` : ""}`);
      button.type = "button";
      button.addEventListener("click", () => {
        select.value = element.ref;
        $("teach-target").value = element.name || `${element.role} target`;
      });
      list.append(button);
    }
    if (!select.options.length) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "Read the screen first / 先读取页面";
      select.append(option);
    }
  }

  function renderActionFields() {
    const kind = $("teach-action-kind")?.value;
    const show = (id, visible) => $(id)?.classList.toggle("hidden", !visible);
    const elementAction = ["click", "type"].includes(kind);
    show("teach-ref-field", elementAction);
    show("teach-target-field", ["click", "type", "key", "assert"].includes(kind));
    show("teach-app-field", ["click", "type"].includes(kind));
    show("teach-url-field", kind === "navigate");
    show("teach-input-name-field", kind === "type");
    show("teach-demo-value-field", kind === "type");
    show("teach-sensitive-field", kind === "type");
    show("teach-key-field", kind === "key");
    show("teach-scroll-field", kind === "scroll");
    show("teach-wait-field", kind === "wait");
    show("teach-validator-field", kind === "assert");
    show("teach-expected-field", kind === "assert");
  }

  function actionFromForm() {
    const kind = $("teach-action-kind").value;
    const action = { kind };
    if (["click", "type"].includes(kind)) {
      action.snapshotId = snapshot?.snapshotId;
      action.ref = $("teach-ref").value;
      action.target = $("teach-target").value.trim();
      action.app = $("teach-app").value.trim() || undefined;
    }
    if (kind === "type") {
      action.inputName = $("teach-input-name").value.trim();
      action.text = $("teach-demo-value").value;
      action.sensitive = $("teach-sensitive").checked;
    }
    if (kind === "navigate") action.url = $("teach-url").value.trim();
    if (kind === "key") {
      action.key = $("teach-key").value;
      action.target = $("teach-target").value.trim() || "current page";
    }
    if (kind === "scroll") {
      action.direction = $("teach-direction").value;
      action.amount = Number($("teach-amount").value);
    }
    if (kind === "wait") action.milliseconds = Number($("teach-milliseconds").value);
    if (kind === "assert") {
      action.validator = $("teach-validator").value;
      action.target = $("teach-target").value.trim();
      action.expectedOutput = $("teach-expected").value.trim();
    }
    return action;
  }

  async function recordAction() {
    if (!session) return;
    const error = $("teach-action-error");
    error?.classList.add("hidden");
    const button = $("teach-record");
    button.disabled = true;
    try {
      const result = await window.sovereignbot.teachOnce.recordAction({ sessionId: session.id, action: actionFromForm() });
      session = result.session;
      if (result.action.kind === "navigate") snapshot = undefined;
      renderSession(session);
      if (!snapshot) renderElements();
      $("teach-demo-value").value = "";
    } catch (reason) {
      if (error) { error.textContent = errorText(reason); error.classList.remove("hidden"); }
    } finally {
      button.disabled = false;
    }
  }

  function renderSession(value) {
    $("teach-session-title").textContent = `${value.name} · ${value.actions.length} action${value.actions.length === 1 ? "" : "s"}`;
    $("teach-session-state").textContent = value.state === "recording" ? "Recording / 录制中" : value.state;
    const list = $("teach-actions");
    if (!list) return;
    list.textContent = "";
    for (const action of value.actions) {
      const line = make("li", "teach-action-row");
      const label = action.kind === "type" ? `Type {{input:${action.inputName}}} into ${action.target}` : action.kind === "navigate" ? `Open ${action.site}` : action.kind === "assert" ? `Verify ${action.expectedOutput || action.target}` : `${action.kind}: ${action.target || action.direction || action.key || "step"}`;
      line.textContent = label;
      list.append(line);
    }
  }

  async function finishTeaching() {
    const error = $("teach-action-error");
    error?.classList.add("hidden");
    try {
      const result = await window.sovereignbot.teachOnce.finish({ sessionId: session.id });
      session = result.session;
      renderDraft(session);
      setPanel("draft");
    } catch (reason) {
      if (error) { error.textContent = errorText(reason); error.classList.remove("hidden"); }
    }
  }

  function renderDraft(value) {
    const draft = value.draft;
    if (!draft) return;
    $("teach-draft-title").textContent = draft.name;
    $("teach-draft-description").textContent = draft.description;
    $("teach-draft-state").textContent = value.state === "tested" ? "Tested / 已测试" : "Draft / 草稿";
    const steps = $("teach-draft-steps");
    steps.textContent = "";
    for (const step of draft.steps) steps.append(make("li", "teach-action-row", step));
    $("teach-draft-meta").textContent = `${draft.inputs.length} reusable input(s) · capability request: ${draft.requestedCapabilities.join(", ") || "none"} · ${draft.validators.length} validator(s)`;
    $("teach-save").disabled = value.state !== "tested";
  }

  async function testDraft() {
    const error = $("teach-draft-error");
    error?.classList.add("hidden");
    try {
      const result = await window.sovereignbot.teachOnce.test({ sessionId: session.id });
      session = result.session;
      renderDraft(session);
      $("teach-result").textContent = "Semantic replay preview passed. Review the draft, then save it as a Skill. / 语义回放预览通过，请确认草稿后保存。";
    } catch (reason) {
      if (error) { error.textContent = errorText(reason); error.classList.remove("hidden"); }
    }
  }

  async function saveSkill() {
    const error = $("teach-draft-error");
    error?.classList.add("hidden");
    const button = $("teach-save");
    button.disabled = true;
    try {
      const result = await window.sovereignbot.teachOnce.save({ sessionId: session.id });
      session = result.session;
      $("teach-result").textContent = `Saved “${result.skill.name}”. It is now available in Skills and can be selected by a Routine or Event Trigger. / 已保存，可在 Skills 中使用，也可由 Routine/Event Trigger 调用。`;
      renderDraft(session);
    } catch (reason) {
      if (error) { error.textContent = errorText(reason); error.classList.remove("hidden"); }
      button.disabled = false;
    }
  }

  async function cancelTeaching() {
    if (session && session.state === "recording") {
      try { session = await window.sovereignbot.teachOnce.cancel({ sessionId: session.id }); } catch {}
    }
    $("teach-dialog")?.close();
  }

  const baseRenderDetails = renderDetails;
  renderDetails = function renderDetailsWithTeachOnce(conversation) {
    baseRenderDetails(conversation);
    ensureSection();
  };
  ensureSection();
})();
