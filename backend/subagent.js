// ============================================================
// Sub-Agent Manager — 移植自 qaimodelbuilder agent_tool.py
//                      (AgentToolHandler：Agent 工具处理器)
//
// 能力：
//  - 主 Agent 通过 `agent` 工具派生子 Agent；子 Agent 跑自己的 agentic 循环
//    （复用 SingleAgentTurnKernel）直到任务完成。
//  - 同一轮 LLM 发出多个 `agent` 工具调用时，通过 executeMany 并行派发
//    （Promise.all），墙钟延迟 = max(t_i) 而非 sum(t_i)。
//  - 递归封顶：spawn_depth 达到 maxSpawnDepth 时拒绝再派生子 Agent（诊断字符串），
//    配合 per-level allow_spawn 实现可控的嵌套。
//  - Profile 感知：子 Agent 的系统提示与工具集按 GENERAL / EXPLORE profile 过滤。
//  - 独立取消：每个运行中的子 Agent 在内存级 abort registry 注册自己的协作取消
//    标志，父 tab 停止时级联取消它派生出的所有子 Agent（修复"主 Agent 停了子
//    Agent 一直跑"的缺陷）。
// ============================================================

import { SingleAgentTurnKernel } from './agent-kernel.js';
import { resolveProfile, GENERAL, EXPLORE } from './agent-profiles.js';
import { truncateToolResult, TOOL_CALLS_CONTENT_SENTINEL } from './context-manager.js';

// 子 Agent 基础排除（绝不能让子 Agent 再派发 / 提问 / 列子 Agent，除非 allow_spawn）
const _SUB_AGENT_BASE_EXCLUDED = new Set(['agent', 'question', 'list_subagents']);

const DEFAULT_SUB_AGENT_MAX_ROUNDS = 12;
const DEFAULT_MAX_SPAWN_DEPTH = 8;

// 子 Agent 聚焦系统提示（general profile 使用；explore 用 profile 覆盖）
const _SUB_AGENT_SYSTEM_PROMPT = `You are a focused sub-agent spawned by the main AI agent to accomplish ONE specific, well-bounded task.

Guidelines:
- Work autonomously through multiple tool rounds until the task is complete.
- Stay strictly on the assigned task. Do not ask the user questions; make reasonable assumptions.
- Report your final answer as a concise, self-contained summary of what you did and found.
- Use tools as needed; prefer reading and searching before writing.`;

export class SubAgentAbortRegistry {
  constructor() {
    this._records = new Map(); // subagentId -> { aborted, reason, ownerTabId }
  }
  register(subagentId, { ownerTabId = null } = {}) {
    const rec = { aborted: false, reason: null, ownerTabId };
    this._records.set(subagentId, rec);
    return rec;
  }
  unregister(subagentId) {
    this._records.delete(subagentId);
  }
  abort(subagentId) {
    const rec = this._records.get(subagentId);
    if (!rec) return false;
    rec.aborted = true;
    rec.reason = 'user_requested';
    return true;
  }
  abortByOwnerTab(ownerTabId) {
    const aborted = [];
    for (const [id, rec] of this._records) {
      if (rec.ownerTabId === ownerTabId && !rec.aborted) {
        rec.aborted = true;
        rec.reason = 'user_requested';
        aborted.push(id);
      }
    }
    return aborted;
  }
  isAborted(subagentId) {
    const rec = this._records.get(subagentId);
    return !!(rec && rec.aborted);
  }
}

let _agentSeq = 0;
function nextSubAgentId() {
  _agentSeq += 1;
  return `subagent_${Date.now()}_${_agentSeq}`;
}

export class SubAgentManager {
  /**
   * @param {object} deps
   *   createLLM(config)   - 工厂：根据 {provider,apiKey,model,baseURL} 创建 LLM 适配器
   *   toolRunner({name, arguments}) - 执行非 agent 工具，返回 {success, output, ...}
   *   getToolSchemas()    - () => 当前所有工具 schema（OpenAI 函数调用形状）
   *   skillLoader?        - 注入 AGENTS.md / skills 上下文用
   *   agentsMdLoader?
   *   llmConfig           - 父 turn 的 LLM 配置（用于子 Agent 同源路由）
   *   maxRounds?          - 子 Agent 回合预算
   *   maxSpawnDepth?      - 递归派发深度上限
   */
  constructor(deps) {
    this.createLLM = deps.createLLM;
    this.toolRunner = deps.toolRunner;
    this.getToolSchemas = deps.getToolSchemas;
    this.skillLoader = deps.skillLoader || null;
    this.agentsMdLoader = deps.agentsMdLoader || null;
    this.llmConfig = deps.llmConfig || {};
    this._maxRounds = deps.maxRounds || DEFAULT_SUB_AGENT_MAX_ROUNDS;
    this._maxSpawnDepth = Math.max(1, deps.maxSpawnDepth || DEFAULT_MAX_SPAWN_DEPTH);
    this._kernel = new SingleAgentTurnKernel();
    this._abortRegistry = new SubAgentAbortRegistry();
  }

  // ── 公开 API：单子 Agent 执行（兼容返回字符串） ──
  async execute(request) {
    const parts = [];
    let final = null;
    for await (const ev of this.iterEvents(request)) {
      if (ev.type === 'subagent_output') parts.push(String(ev.content || ''));
      else if (ev.type === 'subagent_done') final = String(ev.result || '');
      else if (ev.type === 'subagent_error') return `[sub-agent error: ${ev.message}]`;
    }
    if (final != null) return final;
    const joined = parts.join('').trim();
    return joined || '[sub-agent produced no output]';
  }

  // ── 公开 API：并行派发多个子 Agent（异常隔离） ──
  async executeMany(requests) {
    if (!requests || requests.length === 0) return [];
    const results = await Promise.allSettled(
      requests.map((req) => this.execute(req))
    );
    return results.map((r) =>
      r.status === 'fulfilled' ? String(r.value) : `[sub-agent error: ${r.reason}]`
    );
  }

  // ── 子 Agent 事件流（subagent_* 形状） ──
  async *iterEvents(request, opts = {}) {
    const {
      agentIndex = 0,
      totalAgents = 1,
      modelHint = null,
      subagentType = null,
      subagentName = null,
      allowSpawn = false,
      spawnDepth = 1,
      parentTabId = null,
      parentAbortCheck = null,
    } = opts;

    let description = request.arguments?.description || request.arguments?.prompt || '';
    if (!description) {
      yield { type: 'subagent_error', index: agentIndex, message: "'description' argument is required" };
      return;
    }
    const promptPreview = description.slice(0, 500);

    // 解析 profile（显式 > 参数内 > 默认 GENERAL）
    let effectiveType = subagentType || request.arguments?.subagent_type || null;
    let profile = resolveProfile(effectiveType, {
      modelOverride: request.arguments?.model || null,
    });
    // profile 自带 maxRounds 时优先
    const maxRounds = profile.maxRounds || this._maxRounds;
    const subagentId = nextSubAgentId();

    yield {
      type: 'subagent_start',
      index: agentIndex,
      total: totalAgents,
      prompt_preview: promptPreview,
      subagent_id: subagentId,
      subagent_type: profile.name,
      name: subagentName || request.arguments?.name || null,
    };

    // 注册独立取消标志（owner = 父 tab）
    this._abortRegistry.register(subagentId, { ownerTabId: parentTabId });

    const abortCheck = () => {
      if (this._abortRegistry.isAborted(subagentId)) return true;
      if (parentAbortCheck && parentAbortCheck()) return true;
      return false;
    };

    try {
    for await (const ev of this._iterLoop({
      description,
      agentIndex,
      totalAgents,
      modelHint: modelHint || profile.model || this.llmConfig.model,
      profile,
      allowSpawn,
      spawnDepth,
      subagentId,
      parentTabId,
      abortCheck,
      maxRounds,
    })) {
        yield ev;
      }
    } catch (err) {
      yield { type: 'subagent_error', index: agentIndex, message: String(err.message || err) };
    } finally {
      this._abortRegistry.unregister(subagentId);
    }
  }

  // ── 子 Agent agentic 循环（复用共享内核） ──
  async *_iterLoop({
    description, agentIndex, totalAgents, modelHint, profile,
    allowSpawn, spawnDepth, subagentId, parentTabId, abortCheck, maxRounds,
  }) {
    // 1) 构建 system prompt（profile 覆盖 + AGENTS.md 上下文）
    const systemPrompt = this._buildSystemText(profile);

    // 2) 过滤工具集（profile allow/deny + 基础排除 + allow_spawn 决定 agent 是否可见）
    const toolSchemas = this._filterToolSchemas(profile, allowSpawn);

    // 3) 播种 wire（system + user 任务）
    const wire = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: description },
    ];

    // 4) openRoundStream：开 LLM 流，带工具
    const llmCfg = { ...this.llmConfig, model: modelHint || this.llmConfig.model };
    const openRoundStream = async function* (_roundNo, sendWire) {
      let llm;
      try {
        llm = this.createLLM(llmCfg);
      } catch (e) {
        yield { type: 'error', message: `sub-agent LLM init failed: ${e.message}` };
        return;
      }
      let frames = [];
      try {
        for await (const chunk of llm.stream(sendWire, { tools: toolSchemas, temperature: 0.5 })) {
          if (chunk.type === 'text') frames.push({ type: 'chunk', text: chunk.content });
          else if (chunk.type === 'tool_call') {
            frames.push({ type: 'tool_call', id: chunk.id, name: chunk.name, arguments: chunk.arguments });
          }
        }
        frames.push({ type: 'end', payload: {} });
      } catch (e) {
        frames.push({ type: 'error', message: e.message });
      }
      for (const f of frames) yield f;
    }.bind(this);

    // 5) toolExecutor：并行执行工具；agent 工具按需递归派发
    const toolExecutor = (roundNo, toolMetas) => this._makeToolExecutor(roundNo, toolMetas, {
      allowSpawn, spawnDepth, subagentId, parentTabId, abortCheck, modelHint,
    });

    const buildToolMetas = (rawToolCalls, roundNo) =>
      rawToolCalls.map((tc, i) => {
        const name = tc.name || (tc.function && tc.function.name) || 'unknown';
        const args = tc.arguments || (tc.function && tc.function.arguments) || {};
        const callId = tc.id || `sub_${roundNo}_${i}`;
        return [name, typeof args === 'string' ? safeParse(args) : args, callId];
      });

    let rounds = 0;
    for await (const kev of this._kernel.run({
      wireMessages: wire,
      openRoundStream,
      toolExecutor,
      buildToolMetas,
      maxRounds,
      abortCheck,
      modelHint,
    })) {
      const mapped = this._adaptKernelEvent(kev, agentIndex, rounds);
      if (mapped) {
        if (mapped.type === 'subagent_round') rounds = mapped.round;
        else yield mapped;
      }
    }

    yield { type: 'subagent_done', index: agentIndex, result: wireToFinalText(wire), rounds };
  }

  // ── 构建工具执行器（并行） ──
  async *_makeToolExecutor(roundNo, toolMetas, ctx) {
    const tasks = toolMetas.map(async ([name, args, callId]) => {
      const start = Date.now();
      try {
        if (name === 'agent') {
          return await this._handleAgentTool(args, ctx, callId);
        }
        const result = await this.toolRunner({ name, arguments: args });
        const ok = result.success !== false;
        const raw = result.output != null ? String(result.output) : (result.error || '');
        return {
          partial: false,
          callId,
          toolName: name,
          resultText: truncateToolResult(raw),
          ok,
          durationMs: Date.now() - start,
        };
      } catch (err) {
        return {
          partial: false,
          callId,
          toolName: name,
          resultText: truncateToolResult(`Error: ${err.message}`),
          ok: false,
          durationMs: Date.now() - start,
        };
      }
    });

    // 并行执行，保持原始顺序
    const results = await Promise.all(tasks);
    for (const r of results) {
      yield r;
    }
  }

  async _handleAgentTool(args, ctx, callId) {
    const start = Date.now();
    // 递归封顶：达到深度上限则拒绝再派发
    if (!ctx.allowSpawn || ctx.spawnDepth >= this._maxSpawnDepth) {
      return {
        partial: false,
        callId,
        toolName: 'agent',
        resultText: `[error: max sub-agent nesting depth (${this._maxSpawnDepth}) reached — cannot spawn deeper]`,
        ok: false,
        durationMs: Date.now() - start,
      };
    }
    const childRequest = { arguments: args };
    const childEvents = [];
    let childFinal = '[sub-agent produced no output]';
    try {
      for await (const ev of this.iterEvents(childRequest, {
        modelHint: ctx.modelHint,
        allowSpawn: false, // 子子 Agent 默认不允许再派发（per-level 控制）
        spawnDepth: ctx.spawnDepth + 1,
        parentTabId: ctx.parentTabId,
        parentAbortCheck: ctx.abortCheck,
      })) {
        if (ev.type === 'subagent_output') childEvents.push(String(ev.content || ''));
        else if (ev.type === 'subagent_done') childFinal = String(ev.result || '');
        else if (ev.type === 'subagent_error') childFinal = `[sub-agent error: ${ev.message}]`;
      }
    } catch (e) {
      childFinal = `[sub-agent error: ${e.message}]`;
    }
    const text = childFinal != null ? childFinal : childEvents.join('').trim();
    return {
      partial: false,
      callId,
      toolName: 'agent',
      resultText: truncateToolResult(text),
      ok: !String(text).startsWith('[sub-agent error'),
      durationMs: Date.now() - start,
    };
  }

  // ── profile 感知 system prompt ──
  _buildSystemText(profile) {
    let prompt = profile.systemPrompt || _SUB_AGENT_SYSTEM_PROMPT;
    const parts = [prompt];
    if (this.agentsMdLoader && this.agentsMdLoader.exists) {
      parts.push(this.agentsMdLoader.toSystemPromptSnippet());
    }
    if (this.skillLoader) {
      const snip = this.skillLoader.toSystemPromptSnippet();
      if (snip) parts.push(snip);
    }
    return parts.join('\n\n');
  }

  // ── 过滤工具 schema（profile + 基础排除） ──
  _filterToolSchemas(profile, allowSpawn) {
    const all = this.getToolSchemas() || [];
    // 子 Agent 基础排除
    let names = new Set(all.map((t) => toolNameOf(t)).filter((n) => !_SUB_AGENT_BASE_EXCLUDED.has(n)));
    // profile allow/deny
    names = profile.filterToolNames(names);
    // 若 allowSpawn 则把 agent 工具加回来（递归派发）
    if (allowSpawn) names.add('agent');
    return all.filter((t) => names.has(toolNameOf(t)));
  }

  // ── KernelEvent → subagent_* 事件 ──
  _adaptKernelEvent(kev, agentIndex, rounds) {
    switch (kev.kind) {
      case 'round_started':
        return { type: 'subagent_round', round: kev.roundNo };
      case 'chunk':
        return { type: 'subagent_output', index: agentIndex, content: kev.text };
      case 'tool_calls_issued':
        return null; // 在具体 tool 事件里表达
      case 'tool_result':
        return {
          type: 'subagent_tool_result',
          index: agentIndex,
          tool_name: kev.toolName,
          tool_call_id: kev.callId,
          result: kev.resultText,
          ok: kev.ok,
        };
      case 'tool_call_seen':
        return {
          type: 'subagent_tool',
          index: agentIndex,
          tool_name: kev.frame?.name,
          tool_args: kev.frame?.arguments,
          tool_call_id: kev.frame?.id,
        };
      case 'finished':
      case 'max_rounds_reached':
      case 'aborted':
        return null; // 由 subagent_done 收尾
      case 'error':
        return { type: 'subagent_error', index: agentIndex, message: kev.message };
      default:
        return null;
    }
  }

  // ── 供 server.js 注册 `agent` 工具用 ──
  buildAgentToolSchema() {
    return {
      type: 'function',
      function: {
        name: 'agent',
        description:
          'Spawn a sub-agent to accomplish ONE specific, well-bounded task autonomously. ' +
          'Use for parallelizable or independent subtasks. Prefer spawning 1-3 sub-agents in one turn for parallelism. ' +
          'The sub-agent runs its own multi-round agentic loop and returns a concise result.',
        parameters: {
          type: 'object',
          required: ['description'],
          properties: {
            description: { type: 'string', description: 'Clear, self-contained task description for the sub-agent' },
            prompt: { type: 'string', description: 'Alias for description (legacy)' },
            name: { type: 'string', description: 'Optional human-readable label for the sub-agent' },
            subagent_type: {
              type: 'string',
              enum: [GENERAL.name, EXPLORE.name],
              description: `Sub-agent profile: '${GENERAL.name}' (full tools) or '${EXPLORE.name}' (read-only search)`,
            },
            model: { type: 'string', description: 'Optional model id override for this sub-agent' },
            allow_spawn: { type: 'boolean', description: 'Allow this sub-agent to spawn its own sub-agents (nesting)' },
          },
        },
      },
    };
  }
}

// ── 工具名提取（兼容 {function:{name}} 与 {name}） ──
function toolNameOf(t) {
  return t.function?.name || t.name;
}
function safeParse(s) {
  try { return JSON.parse(s); } catch { return {}; }
}
function wireToFinalText(wire) {
  // 取最后一条 assistant（非 tool_calls 哨兵）文本作为最终答案
  for (let i = wire.length - 1; i >= 0; i--) {
    const m = wire[i];
    if (m.role === 'assistant' && typeof m.content === 'string' && m.content && m.content !== TOOL_CALLS_CONTENT_SENTINEL) {
      return m.content;
    }
  }
  return '';
}

export default SubAgentManager;
