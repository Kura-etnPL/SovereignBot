"use strict";
(() => {
  const I18n = () => globalThis.SovereignI18n;
  const $ = (id) => document.getElementById(id);
  const show = (el) => el?.classList.remove("hidden");
  const hide = (el) => el?.classList.add("hidden");
  function t(key, fallback) { try { return I18n()?.t(key) ?? fallback ?? key; } catch { return fallback ?? key; } }

  let jobs = [];
  let currentJobId;
  let pollTimer;

  function statusClass(s) { return `job-status ${s}`; }
  function statusLabel(s) { return t(`work.status.${s}`, s); }

  function renderList() {
    const root = $("work-list");
    if (!root) return;
    root.textContent = "";
    if (!jobs.length) {
      const p = document.createElement("p");
      p.className = "setting-feedback";
      p.textContent = t("work.empty", "No jobs yet.");
      root.append(p);
      return;
    }
    for (const job of jobs) {
      const card = document.createElement("div");
      card.className = "job-card";
      const head = document.createElement("div");
      head.className = "job-card-head";
      const title = document.createElement("strong");
      title.textContent = job.title;
      title.style.cssText = "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:60%";
      const badge = document.createElement("span");
      badge.className = statusClass(job.status);
      badge.textContent = statusLabel(job.status);
      head.append(title, badge);
      const meta = document.createElement("div");
      meta.className = "setting-feedback";
      meta.style.margin = "0";
      meta.textContent = `${job.ownerCoworkerId} · ${job.priority}${job.nextActionAt ? ` · next ${new Date(job.nextActionAt).toLocaleString()}` : ""}${job.error ? ` · ${job.error.slice(0,80)}` : ""}`;
      const actions = document.createElement("div");
      actions.style.cssText = "display:flex;gap:6px;flex-wrap:wrap";
      const openBtn = document.createElement("button");
      openBtn.type = "button"; openBtn.className = "quiet-action"; openBtn.textContent = t("action.open", "Open");
      openBtn.addEventListener("click", () => openDetail(job.id));
      actions.append(openBtn);
      if (job.status === "needs_attention") {
        const ap = document.createElement("button"); ap.type = "button"; ap.className = "hero-action"; ap.textContent = t("action.approve", "Approve");
        ap.addEventListener("click", async () => { await window.sovereignbot.jobs.approve({ jobId: job.id }); await refresh(); });
        const dm = document.createElement("button"); dm.type = "button"; dm.className = "quiet-action"; dm.textContent = t("action.dismiss", "Dismiss");
        dm.addEventListener("click", async () => { await window.sovereignbot.jobs.dismiss({ jobId: job.id }); await refresh(); });
        actions.append(ap, dm);
      }
      card.append(head, meta, actions);
      root.append(card);
    }
  }

  function updateAttentionBadge() {
    const badge = $("attention-badge");
    if (!badge) return;
    const n = jobs.filter(j => j.status === "needs_attention").length;
    badge.textContent = String(n);
    badge.classList.toggle("hidden", n === 0);
    const nav = $("nav-attention");
    if (nav) nav.classList.toggle("active", n > 0 && document.getElementById("view-work")?.classList.contains("hidden") === false);
  }

  async function refresh() {
    try {
      const res = await window.sovereignbot.jobs.list({});
      jobs = res?.jobs ?? [];
      renderList();
      updateAttentionBadge();
    } catch {}
  }

  async function openDetail(jobId) {
    currentJobId = jobId;
    try {
      const job = await window.sovereignbot.jobs.getStatus({ jobId });
      const conv = await window.sovereignbot.jobs.getConversation({ jobId }).catch(() => ({ messages: [] }));
      $("job-detail-title").textContent = job.title;
      $("job-detail-meta").textContent = `${job.status} · ${job.ownerCoworkerId} · ${job.priority}${job.error ? ` · ${job.error}` : ""}${job.outcomeSummary ? ` · ${job.outcomeSummary.slice(0,200)}` : ""}`;
      const body = $("job-detail-body");
      const msgs = conv.messages ?? [];
      body.textContent = msgs.length ? msgs.map(m => `[${m.kind ?? m.role}] ${m.text}`).join("\n\n") : (job.outcomeSummary ?? job.error ?? "");
      const needs = job.status === "needs_attention";
      const waiting = job.status === "waiting";
      $("job-detail-approve")?.classList.toggle("hidden", !needs);
      $("job-detail-dismiss")?.classList.toggle("hidden", !needs);
      $("job-detail-pause")?.classList.toggle("hidden", waiting || needs || ["completed","failed","cancelled"].includes(job.status));
      $("job-detail-resume")?.classList.toggle("hidden", !(waiting || needs));
      const dlg = $("job-detail-dialog");
      if (dlg?.showModal) dlg.showModal();
    } catch (e) {
      const el = document.getElementById("provider-action-result");
      if (el) el.textContent = String(e?.message ?? e).slice(0, 300);
    }
  }

  function populateOwnerSelect(coworkers) {
    const sel = $("job-owner");
    if (!sel) return;
    sel.textContent = "";
    for (const c of (coworkers ?? [])) {
      if (c.state !== "active") continue;
      const opt = document.createElement("option");
      opt.value = c.id;
      opt.textContent = c.name;
      sel.append(opt);
    }
  }

  function bindEvents() {
    $("nav-work")?.addEventListener("click", async () => {
      for (const v of document.querySelectorAll(".main-view")) v.classList.add("hidden");
      $("view-work")?.classList.remove("hidden");
      await refresh();
      // switchView compat: update active class
      document.getElementById("nav-settings")?.classList.remove("active");
      $("nav-work")?.classList.add("active");
      clearTimeout(pollTimer);
      pollTimer = setTimeout(function poll(){ refresh().finally(()=>{ if(!document.getElementById("view-work")?.classList.contains("hidden")) pollTimer=setTimeout(poll, 2500); }); }, 2500);
    });
    $("nav-attention")?.addEventListener("click", async () => {
      for (const v of document.querySelectorAll(".main-view")) v.classList.add("hidden");
      $("view-work")?.classList.remove("hidden");
      await refresh();
      // filter visual: bring needs_attention to top (already sorted by backend? ensure)
      jobs.sort((a,b)=> (a.status==="needs_attention"? -1 : b.status==="needs_attention"? 1 : 0));
      renderList();
    });
    $("work-refresh")?.addEventListener("click", refresh);
    $("work-new")?.addEventListener("click", async () => {
      try {
        const cw = await window.sovereignbot.coworkers.list({});
        populateOwnerSelect(cw?.coworkers ?? []);
      } catch {}
      const dlg = $("job-dialog");
      if (dlg?.showModal) dlg.showModal();
    });
    $("job-form")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const errEl = $("job-form-error");
      errEl?.classList.add("hidden");
      try {
        await window.sovereignbot.jobs.submit({ title: $("job-title").value.trim(), objective: $("job-objective").value.trim(), ownerCoworkerId: $("job-owner").value });
        $("job-dialog")?.close();
        $("job-form")?.reset();
        await refresh();
      } catch (err) {
        if (errEl) { errEl.textContent = String(err?.message ?? err).replace(/^.*Error: /, "").slice(0, 400); errEl.classList.remove("hidden"); }
      }
    });
    $("job-detail-approve")?.addEventListener("click", async () => { if(!currentJobId) return; await window.sovereignbot.jobs.approve({ jobId: currentJobId }); $("job-detail-dialog")?.close(); await refresh(); });
    $("job-detail-dismiss")?.addEventListener("click", async () => { if(!currentJobId) return; await window.sovereignbot.jobs.dismiss({ jobId: currentJobId }); $("job-detail-dialog")?.close(); await refresh(); });
    $("job-detail-pause")?.addEventListener("click", async () => { if(!currentJobId) return; await window.sovereignbot.jobs.pause({ jobId: currentJobId }); $("job-detail-dialog")?.close(); await refresh(); });
    $("job-detail-resume")?.addEventListener("click", async () => { if(!currentJobId) return; await window.sovereignbot.jobs.resume({ jobId: currentJobId }); $("job-detail-dialog")?.close(); await refresh(); });
    for (const b of document.querySelectorAll("[data-close-dialog]")) b.addEventListener("click", () => document.getElementById(b.dataset.closeDialog)?.close());
  }

  // expose refresh for global poll
  globalThis.SovereignJobsUI = { refresh, renderList };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => { bindEvents(); refresh(); setInterval(refresh, 8000); });
  else { bindEvents(); refresh(); setInterval(refresh, 8000); }
})();
