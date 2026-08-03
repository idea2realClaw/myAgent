// context-compressor.js — 长上下文压缩（移植自 qai-appbuilder 的 context_compressor 设计）
// 当一轮对话的 wire 历史估算 token 超过阈值时，把"早期历史"用 LLM 压缩为摘要块，
// 仅保留 system + 最近若干轮 + 摘要，避免上下文溢出、降低延迟与成本。
//
// 估算策略：token ≈ 字符数 / 4（与 qai 的 estimate_wire_tokens 同量级近似）。

function estimateTokens(text) {
  return Math.ceil((text || '').length / 4);
}

export function estimateWireTokens(wire) {
  return (wire || []).reduce((s, m) => s + estimateTokens(m && m.content), 0);
}

/**
 * 若 wire 超过阈值则压缩，否则原样返回（不调用 LLM）。
 * @param {object} llm        LLMAdapter 实例（需提供 async chat(messages, opts)）
 * @param {Array}  wire       [{role, content}, ...]
 * @param {object} opts       { threshold=5000, keepRecent=6 }
 * @returns {Promise<Array>}  压缩后的 wire
 */
export async function compressWireIfNeeded(llm, wire, opts = {}) {
  const threshold = opts.threshold || 5000;
  const keepRecent = opts.keepRecent || 6;

  const total = estimateWireTokens(wire);
  if (total <= threshold) return wire;

  const sysIdx = (wire || []).findIndex((m) => m && m.role === 'system');
  const sysMsg = sysIdx >= 0 ? wire[sysIdx] : null;
  const rest = sysIdx >= 0 ? wire.slice(sysIdx + 1) : wire;

  // 不足可压缩量则不压缩（安全优先，避免把仅剩的上下文都吞掉）
  if (rest.length <= keepRecent + 2) return wire;

  const toCompress = rest.slice(0, rest.length - keepRecent);
  const keepTail = rest.slice(rest.length - keepRecent);

  const summaryPrompt =
    `请极其简洁地压缩下面这段对话历史为要点摘要（保留关键事实、决策、工具结果结论与待办，` +
    `省略寒暄与冗余），用与原文相同的语言：\n\n` +
    toCompress.map((m) => `[${m.role}] ${m.content}`).join('\n\n').slice(-8000);

  let summary = '';
  try {
    summary = (await llm.chat([{ role: 'user', content: summaryPrompt }], { temperature: 0.1, maxTokens: 800 })) || '';
    summary = String(summary).trim();
  } catch (e) {
    console.warn('[compress] failed, skip:', e.message);
    return wire;
  }
  if (!summary) return wire;

  const head = [];
  if (sysMsg) head.push(sysMsg);
  head.push({ role: 'system', content: `（以下为早期对话的压缩摘要，仅供参考）\n${summary}` });

  console.log(
    `[compress] wire ${total} tokens → 压缩早期 ${toCompress.length} 条，保留最近 ${keepTail.length} 条`
  );
  return [...head, ...keepTail];
}

export default compressWireIfNeeded;
