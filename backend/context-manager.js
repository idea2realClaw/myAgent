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
// 会话历史注入预算占比：system+history 超过模型窗口的该比例时，
// 从最早的一轮对话（user+assistant 一对）开始丢弃（用户指定 70%）
export const CONTEXT_USAGE_TARGET_RATIO = 0.7;
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

// ============================================================
// 模型上下文窗口解析（参考 qai-appbuilder context_source_chain：
// 优先级链 → 配置覆盖 → provider API 查询(带缓存) → 模型名启发式 → 默认值）
// ============================================================

// 常见模型名 → 上下文窗口（启发式兑底，命中不了再走默认）
const MODEL_CONTEXT_HEURISTICS = [
  [/claude-3[.-]5|claude-3-7|claude-sonnet-4|claude-opus-4/i, 200000],
  [/claude-3-opus|claude-3-sonnet|claude-3-haiku/i, 200000],
  [/gpt-4o-mini/i, 128000],
  [/gpt-4o/i, 128000],
  [/gpt-4\.1/i, 1047576],
  [/gpt-4-turbo/i, 128000],
  [/o1-mini/i, 128000],
  [/o1/i, 200000],
  [/o3|o4-mini/i, 200000],
  [/gemini-2\.5-pro|gemini-2\.5-flash/i, 1048576],
  [/gemini-2\.0/i, 1048576],
  [/gemini-1\.5/i, 2097152],
  [/deepseek-(v3|r1)/i, 163840],
  [/llama-3\.3-70b/i, 131072],
  [/llama-3\.1-(405b|70b|8b)/i, 131072],
  [/qwen3/i, 131072],
  [/qwen2\.5/i, 131072],
  [/nemotron/i, 131072],
];

// OpenRouter 查询缓存：model -> { context, ts }
const _openrouterCtxCache = new Map();
const OPENROUTER_CTX_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h

/**
 * 解析模型上下文窗口大小（token 数）。
 * 优先级：
 *   1. 配置显式覆盖（config.modelContextWindow / config.contextWindow）
 *   2. OpenRouter provider → GET /models/{id}/endpoints 的 context_length（带缓存）
 *   3. 模型名启发式表
 *   4. DEFAULT_MODEL_TOKEN_BUDGET
 * @param {object} cfg  { provider, model, baseURL, modelContextWindow? }
 * @returns {Promise<number>}
 */
export async function resolveModelContextWindow(cfg = {}) {
  // 1) 显式配置覆盖
  const override = Number(cfg.modelContextWindow || cfg.contextWindow || 0);
  if (override > 0) return override;

  const model = cfg.model || '';

  // 2) OpenRouter：查 endpoints API（免费/付费档窗口不同，必须按完整 model id 查）
  if ((cfg.provider || '') === 'openrouter' && model) {
    const cached = _openrouterCtxCache.get(model);
    if (cached && Date.now() - cached.ts < OPENROUTER_CTX_CACHE_TTL_MS) return cached.context;
    try {
      const base = (cfg.baseURL || 'https://openrouter.ai/api/v1').replace(/\/$/, '');
      // 注：模型 ID 本身含 '/'（如 nvidia/nemotron-...），不能 encodeURIComponent，
      // 否则路径被转义成 %2F 导致 404；直接拼接原始路径段。
      const resp = await fetch(`${base}/models/${model}/endpoints`, {
        headers: cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {},
        signal: AbortSignal.timeout(8000),
      });
      if (resp.ok) {
        const data = await resp.json();
        const endpoints = (data && data.data && data.data.endpoints) || [];
        const ctxList = endpoints.map((e) => Number(e && e.context_length) || 0).filter((n) => n > 0);
        // 多 endpoint 时取最大值（与前端可用能力对齐）
        const context = ctxList.length ? Math.max(...ctxList) : 0;
        if (context > 0) {
          _openrouterCtxCache.set(model, { context, ts: Date.now() });
          return context;
        }
      }
    } catch (e) {
      console.warn(`[ContextManager] OpenRouter context lookup failed for ${model}: ${e.message}`);
    }
  }

  // 3) 启发式
  for (const [re, ctx] of MODEL_CONTEXT_HEURISTICS) {
    if (re.test(model)) return ctx;
  }

  // 4) 默认
  return DEFAULT_MODEL_TOKEN_BUDGET;
}

// ============================================================
// 会话历史注入预算管理（用户规则：超过模型上下文的 70% 时，
// 丢弃最早的一轮对话（user 提问 + assistant 回答），循环直到达标）
// ============================================================

/**
 * 按 70% 预算裁剪会话历史。
 * 规则：systemTokens + historyTokens > budget*ratio 时，从头部丢弃最早的一轮
 * （一个 user 消息 + 紧随其后的 assistant/system 附属消息），直到达标或只剩最近一轮。
 *
 * @param {Array}  history       [{role, content}, ...]（不含 system）
 * @param {object} opts
 *   - tokenBudget?: number     模型上下文窗口（token）
 *   - systemTokens?: number    system prompt 估算 token（一并计入占用）
 *   - ratio?: number           预算比例（默认 CONTEXT_USAGE_TARGET_RATIO = 0.7）
 * @returns {{ history: Array, droppedTurns: number, tokens: number, budget: number, threshold: number }}
 */
export function trimHistoryToBudget(history, { tokenBudget = DEFAULT_MODEL_TOKEN_BUDGET, systemTokens = 0, ratio = CONTEXT_USAGE_TARGET_RATIO } = {}) {
  const list = Array.isArray(history) ? history.slice() : [];
  const threshold = Math.max(1, Math.floor(tokenBudget * Math.min(Math.max(ratio, 0.1), 1.0)));
  let droppedTurns = 0;

  const used = () => systemTokens + estimateWireTokens(list);

  // 一轮 = 一个 user 消息 + 紧随其后的非 user 消息（assistant 回答 / system 补充）
  const dropEarliestTurn = () => {
    if (list.length === 0) return false;
    let start = 0;
    // 头部可能是 system 附属消息（如 agent 模板注入），一并丢弃
    while (start < list.length && list[start].role !== 'user') start++;
    if (start >= list.length) {
      list.length = 0;
      return true;
    }
    let end = start + 1;
    while (end < list.length && list[end].role !== 'user') end++;
    list.splice(start, end - start);
    return true;
  };

  while (used() > threshold && list.length > 0) {
    // 至少保留最近一轮：若只剩一轮且仍超预算，停止丢弃（避免清空）
    const userCount = list.filter((m) => m.role === 'user').length;
    if (userCount <= 1) break;
    if (!dropEarliestTurn()) break;
    droppedTurns++;
  }

  return { history: list, droppedTurns, tokens: used(), budget: tokenBudget, threshold };
}

/**
 * 构建上下文使用情况快照（供前端展示：模型窗口多大 / 会话已用多少）。
 */
export function contextUsageSnapshot({ history, systemTokens = 0, tokenBudget, droppedTurns = 0 }) {
  const tokens = systemTokens + estimateWireTokens(Array.isArray(history) ? history : []);
  const pct = tokenBudget > 0 ? Math.min(100, Math.round((tokens / tokenBudget) * 1000) / 10) : 0;
  return {
    modelTokens: tokenBudget || 0,
    usedTokens: tokens,
    percent: pct,
    messageCount: Array.isArray(history) ? history.length : 0,
    droppedTurns,
  };
}

// 暴露内部常量供 agent-kernel 复用
export const TOOL_CALLS_CONTENT_SENTINEL = '[tool_calls]';
