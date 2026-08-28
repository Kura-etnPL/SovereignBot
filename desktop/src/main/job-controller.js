import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadJsonState, saveJsonState } from "./lib/desktop-state.js";
import { coworkerAgentId, coworkerCapability } from "./provider-roster.js";

export const JOBS_SCHEMA = "sovereignbot.desktop.jobs.v1";
export const MAX_OBJECTIVE = 8000;
export const MAX_TITLE = 120;
const MAX_MESSAGES = 100;
const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const ACTIVE = new Set(["queued", "working", "waiting", "needs_attention"]);
const VALID_STATUSES = new Set(["queued", "working", "waiting", "needs_attention", "completed", "failed", "cancelled"]);
const CAPS = Object.freeze({ maxDepth: 6, maxAttempts: 3, maxChildren: 10, fingerprintWindowMs: 180_000 });

export function makeJobId() { return `job_${randomBytes(8).toString("hex")}`; }
function slice(v, n) { const s = String(v ?? "").replace(/\s+/g, " ").trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; }
function depthOf(jobs, id) { let d = 0, cur = jobs.find(j => j.id === id); while (cur?.parentJobId && d < 100) { d += 1; cur = jobs.find(j => j.id === cur.parentJobId); } return d; }

export function createJobController({ dataDir, runtime, roster, coworkerStore, services, persistPath, supervisorAgentId, readiness, now = () => new Date().toISOString(), makeId = makeJobId } = {}) {
  if (!dataDir || !runtime?.orchestrator) throw new Error("job controller requires dataDir and runtime");
  if (typeof roster !== "function") throw new Error("job controller requires roster reader");
  if (!coworkerStore?.get) throw new Error("job controller requires coworkerStore");
  if (!services?.workspacePath) throw new Error("job controller requires workspace services");
  if (!supervisorAgentId) throw new Error("job controller requires supervisorAgentId");
  persistPath = persistPath ?? join(dataDir, "desktop-state", "jobs.json");

  const loaded = loadJsonState(persistPath, null);
  const jobs = loaded?.schema === JOBS_SCHEMA && Array.isArray(loaded.jobs) ? loaded.jobs.filter(j => j && typeof j.id === "string" && VALID_STATUSES.has(j.status)) : [];
  for (const j of jobs) if (ACTIVE.has(j.status)) { j.status = "failed"; j.error = j.error ?? "interrupted by application shutdown"; j.updatedAt = now(); }

  function save() { saveJsonState(persistPath, { schema: JOBS_SCHEMA, jobs }); }
  function rosterSnapshot() {
    const s = roster();
    if (!s?.ready || s.mode === "demo") throw new Error(s?.mode === "demo" ? "demo roster" : "no ready AI provider roster");
    return s;
  }
  function requireCoworkerBinding(coworkerId) {
    const snap = rosterSnapshot();
    const b = snap.coworkerBindings?.[coworkerId];
    if (!b?.ready || !b.agentId) throw new Error(b?.reason ?? `coworker ${coworkerId} has no ready provider binding`);
    if (b.agentId !== coworkerAgentId(coworkerId)) throw new Error(`coworker binding mismatch for ${coworkerId}`);
    return { snap, binding: b };
  }
  function workspaceContext(coworker) {
    const configured = coworker.workspaceIds ?? [];
    if (configured.length) { for (const wid of configured) { const p = services.workspacePath(wid); if (p) return { workspaceId: wid, cwd: p }; } throw new Error(`${coworker.name} has configured workspaces, but none are currently available`); }
    const cwd = join(dataDir, "desktop-state", "coworker-workspaces", coworker.id);
    mkdirSync(cwd, { recursive: true });
    return { workspaceId: `coworker:${coworker.id}`, cwd };
  }
  function getJob(id) { const j = jobs.find(x => x.id === String(id)); if (!j) throw new Error(`unknown job id: ${id}`); return j; }
  function publicJob(j) { return { id: j.id, title: j.title, objective: j.objective, status: j.status, priority: j.priority, ownerCoworkerId: j.ownerCoworkerId, parentJobId: j.parentJobId ?? null, workspaceId: j.workspaceId, nextActionAt: j.nextActionAt ?? null, attempt: j.attempt, depth: depthOf(jobs, j.id), childJobIds: [...(j.childJobIds ?? [])], attentionState: j.attentionState ? structuredClone(j.attentionState) : undefined, outcomeSummary: j.outcomeSummary ?? undefined, error: j.error ?? undefined, createdAt: j.createdAt, updatedAt: j.updatedAt, conversationId: j.conversationId ?? undefined, taskIds: [...(j.taskIds ?? [])] }; }
  function appendMessage(job, kind, text, role = "system") {
    job.conversation = job.conversation ?? { messages: [] };
    job.conversation.messages.push({ at: now(), role, kind, text: String(text).slice(0, 4000) });
    if (job.conversation.messages.length > MAX_MESSAGES) job.conversation.messages.splice(0, job.conversation.messages.length - MAX_MESSAGES);
  }
  function setStatus(job, status) { job.status = status; job.updatedAt = now(); appendMessage(job, "status", `job status: ${status}`); }

  let pumpChain = Promise.resolve();
  function schedule(jobId) { const run = pumpChain.then(() => runPump(jobId)); pumpChain = run.catch(() => {}); return run; }

  async function runPump(jobId) {
    const job = jobs.find(j => j.id === jobId);
    if (!job || TERMINAL.has(job.status)) return;
    if (job.status === "cancelled") return;
    let fingerprint = job._fingerprint;
    try {
      const coworker = coworkerStore.get(job.ownerCoworkerId);
      const { snap, binding } = requireCoworkerBinding(job.ownerCoworkerId);
      const ctx = workspaceContext(coworker);
      const supervisorId = snap.roles?.planner ?? supervisorAgentId;
      job.workspaceId = ctx.workspaceId;
      if (job.status === "queued") { setStatus(job, "working"); save(); }
      // due check: not before nextActionAt
      if (job.nextActionAt && Date.now() < Date.parse(job.nextActionAt)) return;

      // runaway guard: fingerprint within window triggers needs_attention on
      // rapid re-queue without human interval. Normal wait->resume cycles are
      // driven by nextActionAt timing (or explicit resume/approve) and must
      // not be mistaken for a loop. resume() sets _skipFingerprintOnce for the
      // waiting->queued transition.
      const nowMs = Date.now();
      const fp = `${job.ownerCoworkerId}:${slice(job.objective, 80)}`;
      if (job._skipFingerprintOnce) {
        job._repeatCount = 0;
        delete job._skipFingerprintOnce;
      } else {
        const isRequeueWithoutWait = !job.nextActionAt || Date.parse(job.nextActionAt) > nowMs;
        if (isRequeueWithoutWait && fingerprint && fingerprint.key === fp && nowMs - Date.parse(fingerprint.at) < CAPS.fingerprintWindowMs) {
          job._repeatCount = (job._repeatCount ?? 0) + 1;
        } else if (isRequeueWithoutWait) { job._repeatCount = 0; }
      }
      job._fingerprint = { key: fp, at: now() };
      if (job._repeatCount >= 2) {
        setStatus(job, "needs_attention");
        job.attentionState = { reason: "repeated objective fingerprint", fingerprint: fp, at: now() };
        job.outcomeSummary = "Needs attention: repeated objective detected.";
        save(); return;
      }

      const plan = await runtime.orchestrator.createPlan({ title: `job: ${slice(job.title, 80)}`, ownerAgentId: supervisorId, input: { jobId: job.id, objective: job.objective } });
      job.planId = plan.id;
      const task = await runtime.orchestrator.delegateTrusted(plan.id, {
        title: job.title,
        requiredCapabilities: [coworkerCapability(job.ownerCoworkerId)],
        preferredAgentId: binding.agentId,
        input: { instruction: job.objective, jobId: job.id, objective: job.objective, attempt: job.attempt ?? 0 },
      }, ctx, supervisorId);
      job.taskIds = [...(job.taskIds ?? []), task.id];
      if (!job.conversationId) job.conversationId = `job-conv-${job.id}`;
      save();
      await runtime.orchestrator.runUntilIdle();
      const finished = (await runtime.orchestrator.listTasks()).find(t => t.id === task.id);
      const status = finished?.status ?? "unknown";
      if (status === "completed") {
        const text = typeof finished.result?.text === "string" ? finished.result.text.trim().slice(0, 8000) : "";
        job.outcomeSummary = text || "Completed.";
        appendMessage(job, "answer", job.outcomeSummary);
        setStatus(job, "completed");
        try { await runtime.orchestrator.aggregatePlan(plan.id, supervisorId); } catch {}
        save(); return;
      }
      // failure path — bounded retry once with exponential backoff
      const attempt = (job.attempt ?? 0) + 1;
      job.attempt = attempt;
      job.error = String(finished?.error ?? `job task ended as ${status}`).slice(0, 500);
      appendMessage(job, "answer", `Job attempt ${attempt} did not complete: ${job.error}`);
      if (attempt < CAPS.maxAttempts) {
        const delayMs = Math.min(60_000, 1000 * Math.pow(2, attempt));
        job.nextActionAt = new Date(nowMs + delayMs).toISOString();
        setStatus(job, "waiting");
        save(); return;
      }
      setStatus(job, "needs_attention");
      job.attentionState = { reason: job.error, attempt, at: now() };
      save();
    } catch (error) {
      const msg = String(error?.message ?? error).slice(0, 500);
      const j = jobs.find(x => x.id === jobId);
      if (!j) return;
      j.error = msg;
      appendMessage(j, "answer", `Job failed: ${msg}`);
      const attempt = (j.attempt ?? 0);
      if (attempt + 1 < CAPS.maxAttempts && !/no ready AI provider|demo roster/i.test(msg)) {
        j.attempt = attempt + 1;
        j.nextActionAt = new Date(Date.now() + 1000 * Math.pow(2, j.attempt)).toISOString();
        setStatus(j, "waiting");
      } else {
        setStatus(j, "needs_attention");
        j.attentionState = { reason: msg, attempt: j.attempt ?? 0, at: now() };
      }
      save();
    }
  }

  return {
    CAPS,
    submitJob({ title, objective, ownerCoworkerId, parentJobId, priority, nextActionAt }) {
      const t = typeof title === "string" ? title.trim() : "";
      const obj = typeof objective === "string" ? objective.trim() : "";
      if (!t) throw new Error("job title is required");
      if (t.length > MAX_TITLE) throw new Error(`job title exceeds ${MAX_TITLE} characters`);
      if (!obj) throw new Error("job objective is required");
      if (obj.length > MAX_OBJECTIVE) throw new Error(`job objective exceeds ${MAX_OBJECTIVE} characters`);
      if (!ownerCoworkerId) throw new Error("ownerCoworkerId is required");
      coworkerStore.get(ownerCoworkerId); // validates existence
      if (readiness) { const s = readiness(); if (!s?.allowed) throw new Error(s?.reason ?? "Connect at least one AI provider to run jobs."); }
      if (parentJobId) {
        const parent = getJob(parentJobId);
        if (depthOf(jobs, parent.id) + 1 > CAPS.maxDepth) throw new Error(`job depth exceeds ${CAPS.maxDepth}`);
        if ((parent.childJobIds?.length ?? 0) >= CAPS.maxChildren) throw new Error(`parent job has too many children (${CAPS.maxChildren})`);
      }
      let resolvedNextActionAt;
      if (nextActionAt !== undefined) { const d = new Date(nextActionAt); if (Number.isNaN(d.getTime())) throw new Error("nextActionAt must be a valid date"); resolvedNextActionAt = d.toISOString(); }
      const job = { id: makeId(), title: t, objective: obj, ownerCoworkerId: String(ownerCoworkerId), status: "queued", priority: priority ?? "normal", workspaceId: undefined, conversationId: undefined, planId: undefined, taskIds: [], parentJobId: parentJobId ? String(parentJobId) : undefined, childJobIds: [], attempt: 0, nextActionAt: resolvedNextActionAt, attentionState: undefined, outcomeSummary: undefined, error: undefined, createdAt: now(), updatedAt: now(), conversation: { messages: [] } };
      appendMessage(job, "goal", obj, "user");
      jobs.push(job);
      if (parentJobId) { const p = getJob(parentJobId); p.childJobIds = [...(p.childJobIds ?? []), job.id]; p.updatedAt = now(); }
      save();
      schedule(job.id);
      return publicJob(job);
    },
    spawnChildJob(parentJobId, { title, objective, ownerCoworkerId, priority }) {
      const parent = getJob(parentJobId);
      const child = this.submitJob({ title, objective, ownerCoworkerId: ownerCoworkerId ?? parent.ownerCoworkerId, parentJobId: parent.id, priority });
      return child;
    },
    getJob(jobId) { return publicJob(getJob(jobId)); },
    listJobs() { return { schema: JOBS_SCHEMA, jobs: jobs.map(publicJob) }; },
    attentionJobs() { return { schema: JOBS_SCHEMA, jobs: jobs.filter(j => j.status === "needs_attention").map(publicJob) }; },
    getConversation(jobId) {
      const j = getJob(jobId);
      return { jobId: j.id, conversationId: j.conversationId ?? `job-conv-${j.id}`, messages: structuredClone((j.conversation?.messages ?? []).slice(-MAX_MESSAGES)) };
    },
    async cancel(jobId) {
      const j = getJob(jobId);
      if (TERMINAL.has(j.status)) return publicJob(j);
      for (const tid of j.taskIds ?? []) { try { await runtime.orchestrator.cancel(tid, { reason: `job ${j.id} cancelled` }); } catch {} }
      appendMessage(j, "answer", "Job cancelled by operator.");
      setStatus(j, "cancelled"); save(); return publicJob(j);
    },
    async pause(jobId) { const j = getJob(jobId); if (TERMINAL.has(j.status)) throw new Error(`cannot pause terminal job ${j.status}`); setStatus(j, "waiting"); j.nextActionAt = new Date(Date.now() + 24 * 3600 * 1000).toISOString(); save(); return publicJob(j); },
    async resume(jobId) {
      const j = getJob(jobId);
      if (j.status !== "waiting" && j.status !== "needs_attention") throw new Error(`only waiting/needs_attention jobs can be resumed (current: ${j.status})`);
      const fromWaiting = j.status === "waiting";
      const fromNeedsAttention = j.status === "needs_attention";
      if (fromNeedsAttention) { j.attempt = 0; j._fingerprint = undefined; j._repeatCount = 0; }
      j.error = undefined; j.attentionState = undefined; j.nextActionAt = undefined;
      if (fromWaiting) j._skipFingerprintOnce = true;
      if (fromNeedsAttention) { j._fingerprint = undefined; j._repeatCount = 0; delete j._skipFingerprintOnce; }
      setStatus(j, "queued"); save(); schedule(j.id); return publicJob(j);
    },
    async approve(jobId) {
      const j = getJob(jobId);
      if (j.status !== "needs_attention") throw new Error(`only needs_attention jobs can be approved`);
      j.attempt = 0; j.error = undefined; j.attentionState = undefined; j.nextActionAt = undefined;
      j._fingerprint = undefined; j._repeatCount = 0; delete j._skipFingerprintOnce;
      setStatus(j, "queued"); save(); schedule(j.id); return publicJob(j);
    },
    async dismiss(jobId) { // dismiss needs_attention -> failed (explicit)
      const j = getJob(jobId);
      if (j.status !== "needs_attention") throw new Error(`only needs_attention jobs can be dismissed`);
      setStatus(j, "failed"); j.attentionState = { ...(j.attentionState ?? {}), dismissedAt: now() }; save(); return publicJob(j);
    },
    jobsBusy() { return jobs.some(j => !TERMINAL.has(j.status) && j.status !== "waiting"); },
    dueJobs() { const n = Date.now(); return jobs.filter(j => (j.status === "queued" || j.status === "waiting") && (!j.nextActionAt || Date.parse(j.nextActionAt) <= n)); },
    flush() { return pumpChain; },
  };
}
