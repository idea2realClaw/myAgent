// ============================================================
// Agent Profiles — 移植自 qaimodelbuilder agent_profile.py
//
// 一个 AgentProfile 是「子 Agent 行为形态」的不可变值对象：
//  - name            持久化标识（general / explore）
//  - description      人类可读说明（写入 agent 工具 schema 的枚举描述）
//  - systemPrompt     可选 system prompt 覆盖（explore 用只读专家提示）
//  - allowedTools     允许列表（白名单）；null = 不限制（general 行为）
//  - deniedTools      拒绝列表（永远减去）
//  - model            可选每 profile 模型覆盖（null = 继承父 turn 模型）
//  - maxRounds        可选每 profile 回合预算（null = 用调度器共享预算）
//
// GENERAL = 历史子 Agent 行为（无额外拒绝、无覆盖）。
// EXPLORE = 严格只读代码库搜索专家（只允许 read/glob/grep/webfetch/list）。
// ============================================================

// 探索子 Agent 永远不能拿到的工具（叠加在基础排除之上）
const EXPLORE_DENIED_TOOLS = new Set([
  'shell_execute', 'file_write', 'file_edit', 'python_execute', 'http_request',
  'apply_patch', 'todowrite', 'background_process',
  // 子 Agent 基础排除（显式声明，契约自洽）
  'agent', 'question', 'list_subagents',
]);

// 探索子 Agent 唯一可使用的工具（只读搜索面）
const EXPLORE_ALLOWED_TOOLS = new Set([
  'file_read', 'file_glob', 'file_grep', 'web_fetch', 'file_list',
]);

// explore 专属 system prompt（与 qaimodelbuilder 对齐：严格只读文件搜索专家）
const EXPLORE_SYSTEM_PROMPT = `You are a file search specialist. You excel at thoroughly navigating and exploring codebases to locate relevant files, symbols, and code.

Your strengths:
- Rapidly finding files using glob patterns (file_glob).
- Searching code and text with powerful regex patterns (file_grep).
- Reading and analysing file contents (file_read).
- Fetching reference material from the web when needed (web_fetch).
- Listing directory structure (file_list).

Guidelines:
- Use file_glob for broad file pattern matching, file_grep for content search with regex, and file_read when you already know the specific file path.
- Adapt the depth/breadth of your search to the thoroughness level asked: a quick lookup needs one or two targeted searches; a thorough audit warrants iterating across many patterns and files.
- Report findings as ABSOLUTE file paths (e.g. C:\\path\\to\\file.js:123) so the caller can navigate directly.
- Be concise. Summarise what you found and where; do NOT paste raw file contents back as your answer.

STRICTLY READ-ONLY: you MUST NOT modify any file or change system state in any way. You have NO write / edit / shell / python tools — never ask for them or attempt a workaround. Your job is to find and report, not to change anything.`;

class AgentProfile {
  constructor({ name, description, systemPrompt = null, allowedTools = null, deniedTools = new Set(), model = null, maxRounds = null }) {
    this.name = name;
    this.description = description;
    this.systemPrompt = systemPrompt;
    this.allowedTools = allowedTools ? new Set(allowedTools) : null;
    this.deniedTools = new Set(deniedTools || []);
    this.model = model;
    this.maxRounds = maxRounds;
  }

  /**
   * 应用本 profile 的 allow/deny 策略到一组 *已通过基础过滤* 的工具名。
   *  - 先减掉 deniedTools
   *  - 若 allowedTools 存在，仅保留同时存在于 allowedTools 的名
   * 纯函数，返回新 Set，不改传入集合。
   */
  filterToolNames(names) {
    const base = names instanceof Set ? names : new Set(names);
    let kept = new Set([...base].filter((n) => !this.deniedTools.has(n)));
    if (this.allowedTools != null) {
      kept = new Set([...kept].filter((n) => this.allowedTools.has(n)));
    }
    return kept;
  }
}

const GENERAL = new AgentProfile({
  name: 'general',
  description:
    'General-purpose sub-agent: full tool set (read/write/edit/exec/glob/grep/webfetch/…), ' +
    'runs a multi-step agentic loop until the delegated task is complete. Use for tasks that may need to CHANGE files or run commands.',
  systemPrompt: null,
  allowedTools: null,
  deniedTools: new Set(),
});

const EXPLORE = new AgentProfile({
  name: 'explore',
  description:
    'Read-only codebase exploration sub-agent: ONLY read/glob/grep/file_list/webfetch (no write/edit/exec). ' +
    'Use for fast, safe code-base search and investigation when you only need to FIND and READ, never change.',
  systemPrompt: EXPLORE_SYSTEM_PROMPT,
  allowedTools: EXPLORE_ALLOWED_TOOLS,
  deniedTools: EXPLORE_DENIED_TOOLS,
  maxRounds: 5,
});

const _PROFILES = { [GENERAL.name]: GENERAL, [EXPLORE.name]: EXPLORE };
// 历史子 Agent 持久化的 subagent_type 是字面量 "agent"，解析为 GENERAL
const _LEGACY_GENERAL_ALIAS = 'agent';

function resolveProfile(name, { modelOverride = null } = {}) {
  let base;
  if (typeof name !== 'string') {
    base = GENERAL;
  } else {
    const key = name.trim().toLowerCase();
    if (!key || key === _LEGACY_GENERAL_ALIAS) {
      base = GENERAL;
    } else {
      base = _PROFILES[key] || GENERAL;
    }
  }
  if (typeof modelOverride === 'string' && modelOverride.trim()) {
    // 返回带模型覆盖的副本（不修改单例）
    return new AgentProfile({
      name: base.name,
      description: base.description,
      systemPrompt: base.systemPrompt,
      allowedTools: base.allowedTools,
      deniedTools: base.deniedTools,
      model: modelOverride,
      maxRounds: base.maxRounds,
    });
  }
  return base;
}

function listProfiles() {
  return [GENERAL, EXPLORE];
}

export {
  AgentProfile,
  GENERAL,
  EXPLORE,
  resolveProfile,
  listProfiles,
  EXPLORE_DENIED_TOOLS,
  EXPLORE_ALLOWED_TOOLS,
};
