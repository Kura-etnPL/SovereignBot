export function createChiefLoop({ jobController, goalController, roster } = {}) {
  if (!jobController) throw new Error("chief loop requires jobController");
  let timer;
  let stopped = false;
  let tickChain = Promise.resolve();

  function jitterMs() { return 5000 + Math.floor(Math.random() * 10000); }

  function shouldSkip() {
    try {
      const snap = roster?.();
      if (!snap?.ready || snap.mode === "demo") return true;
    } catch { return true; }
    const goalsBusy = (() => { try { const g = goalController?.listGoals?.(); return (g?.goals ?? []).some(x => !["completed","failed","cancelled"].includes(x.status)); } catch { return false; } })();
    if (goalsBusy) return true;
    if (jobController.jobsBusy?.()) return true;
    return (jobController.dueJobs?.() ?? []).length === 0;
  }

  async function tickOnce() {
    if (stopped || shouldSkip()) return [];
    return await jobController.wakeDueJobs();
  }

  function scheduleNext() {
    if (stopped) return;
    timer = setTimeout(() => {
      const run = tickChain.then(() => tickOnce()).catch(() => {});
      tickChain = run;
      run.finally(() => scheduleNext());
    }, jitterMs());
    if (timer.unref) timer.unref();
  }

  return {
    start() { if (stopped || timer) return; scheduleNext(); },
    stop() { stopped = true; if (timer) clearTimeout(timer); timer = undefined; },
    async tickNow() { return await tickOnce(); },
  };
}
