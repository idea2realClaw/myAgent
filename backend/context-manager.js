// ============================================================
// Context Manager — 移植自 qaimodelbuilder 的上下文压缩 + 工具结果截断
//
// 设计原则（与 qaimodelbuilder 对齐）：
//  - 上下文管理放在 agentic 回合循环的「回合之间」(inter-round) 阶段。
//  - 超阈值时压缩 *旧* 的 tool 结果，保留尾部 (preserve_tail) 最近的结果完整，
//    因为尾部对当前决策最相关（与 _agentic_kernel.maybe_compress_wire 一致）。
//  - 工具结果在写回 wire 之前必须截断，避免单个巨大结果撑爆上下文。
//
//  注：qaimodelbuilder 的压缩器是 LLM 摘要式的；MyAgent 这里用轻量、确定性的
//  启发式（截断旧 tool 内容），不引入额外 LLM 调用，保证零额外延迟与可预测性。
// ============================================================

// 模型上下文 token 预算（默认按 ~128k 估算；可按模型覆盖）
export const DEFAULT_MODEL_TOKEN_BUDGET = 128000;
// 触发压缩的占用比例（超过预算的该比例即压缩）
export const INTER_ROUND_COMPRESS_THRESHOLD_RATIO = 0.8;
// 尾部保留的完整 tool 消息条数（与 qaimodelbuilder COMPRESS_PRESERVE_TAIL 对齐）
export const COMPRESS_PRESERVE_TAIL = 4;
// 旧 tool 结果压缩后保留的字符上限
export const COMPRESSED_TOOL_MAX_CHARS = 600;
// 单个工具结果写回 wire 前的最大字符数（截断保护）
export const TOOL_RESULT_MAX_CHARS = 30000;

// 粗略 token 估算：中文约 1.6 字符/token，英文约 4 字符/token。
// 这里取保守均值（字符数 / 3.2），对混合中英文本足够近似。
export function estimateTokens(text) {
  if (!text) return 0;
  const s = typeof text === 'string' ? text : JSON.stringify(text);
  return Math.ceil(s.length / 3.2);
}

// 估算整条 wire（OpenAI messages 数组）的 token 数
export function estimateWireTokens(wire) {
  if (!Array.isArray(wire)) return 0;
  let total = 0;
  for (const m of wire) {
    if (!m || typeof m !== 'object') continue;
    if (typeof m.content === 'string') {
      total += estimateTokens(m.content);
    } else if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (part && typeof part.text === 'string') total += estimateTokens(part.text);
      }
    }
    if (Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        total += estimateTokens(tc?.function?.name || '') + estimateTokens(tc?.function?.arguments || '');
      }
    }
  }
  return total;
}

/**
 * 截断单个工具结果文本（与 qaimodelbuilder truncate_tool_result 对齐）。
 * 超过上限则在尾部追加标记，模型只看到被截断的片段。
 */
export function truncateToolResult(text, maxChars = TOOL_RESULT_MAX_CHARS) {
  if (text == null) return '';
  let s = typeof text === 'string' ? text : JSON.stringify(text);
  if (s.length <= maxChars) return s;
  const head = s.slice(0, maxChars);
  return `${head}\n\n[…工具结果已截断，原始长度 ${s.length} 字符，仅展示前 ${maxChars} 字符…]`;
}

/**
 * 回合间上下文压缩（移植自 maybe_compress_wire）。
 *
 * 当 wire 估算 token 超过 budget*thresholdRatio 时，从最旧的 tool 消息开始，
 * 保留尾部 COMPRESS_PRESERVE_TAIL 条完整，其余截断到 COMPRESSED_TOOL_MAX_CHARS。
 * 返回新的 wire 数组（不修改入参）。未超阈值则原样返回。
 *
 * @param {Array} wireMessages  - 增长的 OpenAI wire 历史
 * @param {object} opts
 *   - modelHint?: string         （保留接口，未来按模型调整预算）
 *   - thresholdRatio?: number
 *   - preserveTail?: number
 *   - tokenBudget?: number
 *   - logContext?: object
 * @returns {Promise<Array>} 压缩后的 wire（新数组）
 */
export async function maybeCompressWire(
  wireMessages,
  {
    modelHint = null,
    thresholdRatio = INTER_ROUND_COMPRESS_THRESHOLD_RATIO,
    preserveTail = COMPRESS_PRESERVE_TAIL,
    tokenBudget = DEFAULT_MODEL_TOKEN_BUDGET,
    logContext = null,
  } = {}
) {
  if (!Array.isArray(wireMessages) || wireMessages.length === 0) return wireMessages;

  const threshold = Math.max(1, Math.floor(tokenBudget * Math.min(Math.max(thresholdRatio, 0.1), 1.0)));
  const totalTokens = estimateWireTokens(wireMessages);

  if (totalTokens <= threshold) {
    return wireMessages; // 未超阈值，原样返回
  }

  // 找出所有 role:tool 消息的索引（从旧到新）
  const toolIdx = [];
  wireMessages.forEach((m, i) => {
    if (m && typeof m === 'object' && m.role === 'tool') toolIdx.push(i);
  });

  // 尾部 preserveTail 条保留完整
  const keepFull = new Set(toolIdx.slice(-preserveTail));

  const newWire = wireMessages.map((m, i) => {
    if (m && typeof m === 'object' && m.role === 'tool' && !keepFull.has(i)) {
      const original = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
      if (original.length <= COMPRESSED_TOOL_MAX_CHARS) return m;
      const compressed = original.slice(0, COMPRESSED_TOOL_MAX_CHARS);
      return {
        ...m,
        content: `${compressed}\n\n[…上下文压缩：该工具结果已截断，原始 ${original.length} 字符，仅保留前 ${COMPRESSED_TOOL_MAX_CHARS} 字符…]`,
      };
    }
    return m;
  });

  if (logContext && logContext.debug) {
    console.log(
      `[ContextManager] compressed wire: ${totalTokens} tokens > threshold ${threshold}; ` +
      `compressed ${toolIdx.length - keepFull.size} old tool message(s)`
    );
  }
  return newWire;
}

// 暴露内部常量供 agent-kernel 复用
export const TOOL_CALLS_CONTENT_SENTINEL = '[tool_calls]';
