const INTENTS = [
  ["software", "code implement build bug fix debug test electron ipc api software 代码 开发 实现 修复 测试 调试 软件"],
  ["research", "research investigate evidence source cite compare study web 研究 调查 证据 来源 引用 比较 搜索"],
  ["content", "write draft article copy content translate edit 文案 写作 文章 内容 翻译 润色 编辑"],
  ["operations", "operate operations runbook monitor workflow execute 运营 运维 运行 监控 流程 执行"],
  ["review", "review audit verify check quality security risk approve 审查 审核 复核 验证 质量 安全 风险"],
];

const clean = (value, max) => String(value ?? "").replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, max).toLocaleLowerCase();

export function selectSpecialist({ objective, currentCoworkerId, candidates = [] } = {}) {
  const task = clean(objective, 2_000);
  const eligible = candidates.filter((candidate) => candidate?.id && candidate.id !== currentCoworkerId && candidate.state === "active");
  if (!task || !eligible.length) return undefined;
  const intent = INTENTS.map(([id, terms], index) => ({ id, terms: terms.split(" "), score: terms.split(" ").filter((term) => task.includes(term)).length, index })).sort((a, b) => b.score - a.score || a.index - b.index)[0];
  if (!intent?.score) return undefined;
  const ranked = eligible.map((candidate, index) => {
    const capabilities = clean([candidate.name, candidate.role, candidate.instructions, candidate.modelProfile].join(" "), 2_000);
    const matched = intent.terms.filter((term) => capabilities.includes(term));
    const workloadPenalty = Math.min(1.5, Math.max(0, Number(candidate.pendingCount) || 0) * 0.25);
    return { candidate, index, matched, score: intent.score * 3 + matched.length - workloadPenalty };
  }).sort((a, b) => b.score - a.score || (a.candidate.pendingCount ?? 0) - (b.candidate.pendingCount ?? 0) || a.index - b.index);
  const winner = ranked[0];
  if (!winner || winner.score < 1) return undefined;
  const name = String(winner.candidate.name || winner.candidate.id).slice(0, 100);
  return { targetCoworkerId: winner.candidate.id, reason: `Matched ${intent.id} objective to ${name}.`.slice(0, 240), handoffType: "delegate", boundedTask: String(objective).trim().slice(0, 1_000) };
}
