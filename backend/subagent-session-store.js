// ============================================================
// Sub-Agent Session Store — 移植自 qaimodelbuilder sub_agent_session
//                         + SqliteSubAgentSessionRepository
//
// 轻量级 JSON 文件持久化（替代 SQLite），与 MyAgent 的 Node/Express 架构对齐。
//
// 一个 SubAgentSession 是"被主 Agent 派生出的子 Agent"的会话/记忆，携带子
// Agent 自己的结构化 transcript（messages），用于：
//   - 主 Agent 之后能唤醒/续跑该子 Agent（resume）；
//   - 用户可接管（take_over）手动继续该线程；
//   - 前端可回看每个子 Agent 的完整运行过程。
//
// 对比 qaimodelbuilder：
//   - 单文件 JSON 聚合（single-row aggregate 的等价物）：整条会话
//     （含 AUTHORITATIVE 结构化 messages transcript）存在一个 JSON 对象里，
//     save 即整体写回（无子表重写）。
//   - 乐观锁：用 version 字段做 compare-and-swap，避免并发写互相覆盖。
//   - 级联删除：deleteByRoot(rootConversationId) 删除该 root 下所有子会话
//     （对应父会话被删时一并清理）。
// ============================================================

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const STORE_FILE = path.join(DATA_DIR, 'subagent-sessions.json');

const MAX_PROMPT_PREVIEW_LENGTH = 500;

// ── 生命周期状态 ──
const STATUS = {
  RUNNING: 'running',
  DONE: 'done',
  ERROR: 'error',
  INTERRUPTED: 'interrupted',
  USER_OWNED: 'user_owned',
};
const TERMINAL_STATUSES = new Set([STATUS.DONE, STATUS.ERROR, STATUS.INTERRUPTED]);

// ── 拥有者 ──
export const OWNER = {
  MAIN_AGENT: 'main_agent',
  USER: 'user',
};

function nowIso() {
  return new Date().toISOString();
}

// ── 内存缓存（进程内全量映射；文件为权威持久层） ──
// 运行期数据量小，全量加载即可；写时落盘。
let _cache = null;
let _loaded = false;

function _ensureLoaded() {
  if (_loaded) return;
  _loaded = true;
  try {
    if (fs.existsSync(STORE_FILE)) {
      const raw = fs.readFileSync(STORE_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      _cache = parsed.sessions && Array.isArray(parsed.sessions) ? parsed.sessions : [];
    } else {
      _cache = [];
    }
  } catch (e) {
    console.error('[subagent-session-store] load failed, starting empty:', e.message);
    _cache = [];
  }
}

function _persist() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STORE_FILE, JSON.stringify({ sessions: _cache }, null, 2), 'utf8');
}

// ── 防御性读取：单条坏消息不应导致整条会话丢失 ──
function _messageToJson(msg) {
  return {
    id: msg.id != null ? String(msg.id) : uuidv4(),
    role: msg.role || 'assistant',
    text: typeof msg.text === 'string' ? msg.text : '',
    created_at: msg.created_at || nowIso(),
    parent_id: msg.parent_id != null ? String(msg.parent_id) : null,
    tool_call_id: msg.tool_call_id != null ? String(msg.tool_call_id) : null,
    tool_calls: Array.isArray(msg.tool_calls) ? msg.tool_calls.map((c) => ({ ...c })) : [],
    tool_results: Array.isArray(msg.tool_results) ? msg.tool_results.map((r) => ({ ...r })) : [],
    usage: msg.usage && typeof msg.usage === 'object' ? { ...msg.usage } : null,
    model_id: msg.model_id != null ? String(msg.model_id) : null,
    model_provider: msg.model_provider != null ? String(msg.model_provider) : null,
    meta: msg.meta && typeof msg.meta === 'object' ? { ...msg.meta } : null,
    sender_id: msg.sender_id != null ? String(msg.sender_id) : null,
  };
}

function _jsonToMessage(raw, sessionCreatedAt) {
  const role = typeof raw.role === 'string' ? raw.role : 'assistant';
  const parentRaw = raw.parent_id;
  const parentId = typeof parentRaw === 'string' && parentRaw ? parentRaw : null;
  const toolCallId = raw.tool_call_id != null ? String(raw.tool_call_id) : null;
  const toolCalls = Array.isArray(raw.tool_calls) ? raw.tool_calls.filter((c) => c && typeof c === 'object').map((c) => ({ ...c })) : [];
  const toolResults = Array.isArray(raw.tool_results) ? raw.tool_results.filter((r) => r && typeof r === 'object').map((r) => ({ ...r })) : [];
  const usage = raw.usage && typeof raw.usage === 'object' ? { ...raw.usage } : null;
  const meta = raw.meta && typeof raw.meta === 'object' ? { ...raw.meta } : null;
  const id = raw.id != null ? String(raw.id) : uuidv4();
  // 文本守卫：空/非字符串 → ""；不静默丢弃行
  const textRaw = raw.text;
  const text = typeof textRaw === 'string' ? textRaw : '';
  // created_at 守卫：缺失/非法 → 回退到会话 created_at（保持 transcript 完整）
  let createdAt = sessionCreatedAt || nowIso();
  if (raw.created_at != null) {
    const d = new Date(raw.created_at);
    if (!isNaN(d.getTime())) createdAt = d.toISOString();
  }
  return {
    id,
    role,
    text,
    created_at: createdAt,
    parent_id: parentId,
    tool_call_id: toolCallId,
    tool_calls: toolCalls,
    tool_results: toolResults,
    usage,
    model_id: raw.model_id != null ? String(raw.model_id) : null,
    model_provider: raw.model_provider != null ? String(raw.model_provider) : null,
    meta,
    sender_id: raw.sender_id != null ? String(raw.sender_id) : null,
  };
}

export class SubAgentSessionStore {
  constructor() {
    this.STATUS = STATUS;
    this.OWNER = OWNER;
  }

  // ── 写路径 ──
  /**
   * 插入或 upsert 一条子 Agent 会话（按 id 整体写回）。
   * 乐观锁：每条已存在记录带 version；仅当持久层 version 仍等于传入
   * session.version 时才允许更新，并将 version +1；若 0 行受影响说明
   * 被别的写者抢先，抛出 ConflictError（不静默覆盖）。
   */
  save(session) {
    _ensureLoaded();
    const existingIdx = _cache.findIndex((s) => s.id === session.id);
    const expectedVersion = Number(session.version) || 0;
    const record = this._serialize(session);
    if (existingIdx === -1) {
      // 新插入：写入当前 version（新建会话为 0）
      _cache.push(record);
      session.version = expectedVersion;
    } else {
      const storedVersion = Number(_cache[existingIdx].version) || 0;
      if (storedVersion !== expectedVersion) {
        const err = new Error(
          `sub-agent session ${session.id} version conflict: expected ${expectedVersion}, stored ${storedVersion}`
        );
        err.code = 'CONFLICT';
        throw err;
      }
      record.version = storedVersion + 1;
      _cache[existingIdx] = record;
      session.version = storedVersion + 1;
    }
    _persist();
    return session;
  }

  delete(id) {
    _ensureLoaded();
    const before = _cache.length;
    _cache = _cache.filter((s) => s.id !== id);
    const removed = before - _cache.length;
    if (removed === 0) {
      const err = new Error(`sub-agent session ${id} not found`);
      err.code = 'NOT_FOUND';
      throw err;
    }
    _persist();
    return true;
  }

  /**
   * 级联删除某 root 会话下的全部子 Agent 会话。
   * 返回删除条数。
   */
  deleteByRoot(rootConversationId) {
    _ensureLoaded();
    const before = _cache.length;
    _cache = _cache.filter((s) => s.root_conversation_id !== rootConversationId);
    const removed = before - _cache.length;
    if (removed > 0) _persist();
    return removed;
  }

  // ── 读路径 ──
  find(id) {
    _ensureLoaded();
    const rec = _cache.find((s) => s.id === id);
    return rec ? this._deserialize(rec) : null;
  }

  get(id) {
    const s = this.find(id);
    if (!s) {
      const err = new Error(`sub-agent session ${id} not found`);
      err.code = 'NOT_FOUND';
      throw err;
    }
    return s;
  }

  listByRootConversation(rootConversationId) {
    _ensureLoaded();
    return _cache
      .filter((s) => s.root_conversation_id === rootConversationId)
      .sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''))
      .map((r) => this._deserialize(r));
  }

  listByParentSubAgent(parentSubAgentId) {
    _ensureLoaded();
    return _cache
      .filter((s) => s.parent_subagent_id === parentSubAgentId)
      .sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''))
      .map((r) => this._deserialize(r));
  }

  // 全量列表（无过滤）
  listAll() {
    _ensureLoaded();
    return _cache
      .slice()
      .sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''))
      .map((r) => this._deserialize(r));
  }

  // 给 server 路由用的便捷封装：设置模型并落盘
  setModel(session, modelId, modelProvider, { now = nowIso() } = {}) {
    setSessionModel(session, modelId, modelProvider, { now });
    return session;
  }

  // 摘要（不含完整 transcript，列表用）
  toSummary(session) {
    return {
      id: session.id,
      root_conversation_id: session.root_conversation_id,
      parent_subagent_id: session.parent_subagent_id,
      depth: session.depth,
      subagent_type: session.subagent_type,
      title: session.title,
      prompt_preview: session.prompt_preview,
      status: session.status,
      owner: session.owner,
      rounds: session.rounds,
      created_at: session.created_at,
      updated_at: session.updated_at,
      version: session.version,
      usage: session.usage,
      last_prompt_tokens: session.last_prompt_tokens,
      allow_spawn: session.allow_spawn,
      model_id: session.model_id,
      model_provider: session.model_provider,
      message_count: Array.isArray(session.messages) ? session.messages.length : 0,
    };
  }

  // 详情（含完整结构化 transcript）
  toDetail(session) {
    return {
      id: session.id,
      root_conversation_id: session.root_conversation_id,
      parent_subagent_id: session.parent_subagent_id,
      depth: session.depth,
      subagent_type: session.subagent_type,
      title: session.title,
      prompt_preview: session.prompt_preview,
      status: session.status,
      owner: session.owner,
      rounds: session.rounds,
      created_at: session.created_at,
      updated_at: session.updated_at,
      version: session.version,
      usage: session.usage,
      last_prompt_tokens: session.last_prompt_tokens,
      allow_spawn: session.allow_spawn,
      model_id: session.model_id,
      model_provider: session.model_provider,
      messages: session.messages,
    };
  }

  // ── 序列化 ──
  _serialize(session) {
    return {
      id: session.id,
      root_conversation_id: session.root_conversation_id,
      parent_subagent_id: session.parent_subagent_id != null ? session.parent_subagent_id : null,
      depth: session.depth != null ? session.depth : 1,
      parent_message_id: session.parent_message_id != null ? session.parent_message_id : null,
      subagent_type: session.subagent_type || 'general',
      title: session.title || '',
      prompt_preview: (session.prompt_preview || '').slice(0, MAX_PROMPT_PREVIEW_LENGTH),
      status: session.status || STATUS.RUNNING,
      owner: session.owner || OWNER.MAIN_AGENT,
      rounds: session.rounds || 0,
      created_at: session.created_at || nowIso(),
      updated_at: session.updated_at || nowIso(),
      version: session.version || 0,
      usage: session.usage && typeof session.usage === 'object' ? { ...session.usage } : null,
      round_snapshots: session.round_snapshots && typeof session.round_snapshots === 'object'
        ? Object.fromEntries(Object.entries(session.round_snapshots).map(([k, v]) => [k, v]))
        : null,
      last_prompt_tokens: session.last_prompt_tokens != null ? session.last_prompt_tokens : null,
      allow_spawn: !!session.allow_spawn,
      model_id: session.model_id != null ? String(session.model_id) : null,
      model_provider: session.model_provider != null ? String(session.model_provider) : null,
      messages: Array.isArray(session.messages) ? session.messages.map((m) => _messageToJson(m)) : [],
    };
  }

  _deserialize(rec) {
    const sessionCreatedAt = rec.created_at || nowIso();
    const messages = Array.isArray(rec.messages)
      ? rec.messages
          .filter((e) => e && typeof e === 'object')
          .map((e) => _jsonToMessage(e, sessionCreatedAt))
      : [];
    return {
      id: rec.id,
      root_conversation_id: rec.root_conversation_id,
      parent_subagent_id: rec.parent_subagent_id != null ? rec.parent_subagent_id : null,
      depth: typeof rec.depth === 'number' && rec.depth >= 1 ? rec.depth : 1,
      parent_message_id: rec.parent_message_id != null ? rec.parent_message_id : null,
      subagent_type: rec.subagent_type || 'general',
      title: rec.title || '',
      prompt_preview: rec.prompt_preview || '',
      status: rec.status || STATUS.RUNNING,
      owner: rec.owner || OWNER.MAIN_AGENT,
      rounds: typeof rec.rounds === 'number' ? rec.rounds : 0,
      created_at: sessionCreatedAt,
      updated_at: rec.updated_at || sessionCreatedAt,
      version: typeof rec.version === 'number' ? rec.version : 0,
      usage: rec.usage && typeof rec.usage === 'object' ? { ...rec.usage } : null,
      round_snapshots:
        rec.round_snapshots && typeof rec.round_snapshots === 'object'
          ? Object.fromEntries(
              Object.entries(rec.round_snapshots).map(([k, v]) => [Number(k), v])
            )
          : null,
      last_prompt_tokens: rec.last_prompt_tokens != null ? rec.last_prompt_tokens : null,
      allow_spawn: !!rec.allow_spawn,
      model_id: rec.model_id != null ? rec.model_id : null,
      model_provider: rec.model_provider != null ? rec.model_provider : null,
      messages,
    };
  }
}

// ── 工厂：构造一条全新的 RUNNING 子会话 ──
export function startSubAgentSession({
  sessionId,
  rootConversationId,
  parentSubAgentId = null,
  depth = 1,
  parentMessageId = null,
  subagentType = 'general',
  title = '',
  promptPreview = '',
  allowSpawn = false,
  modelId = null,
  modelProvider = null,
}) {
  const ts = nowIso();
  return {
    id: sessionId,
    root_conversation_id: rootConversationId,
    parent_subagent_id: parentSubAgentId,
    depth,
    parent_message_id: parentMessageId,
    subagent_type: subagentType,
    title,
    prompt_preview: String(promptPreview).slice(0, MAX_PROMPT_PREVIEW_LENGTH),
    status: STATUS.RUNNING,
    owner: OWNER.MAIN_AGENT,
    rounds: 0,
    created_at: ts,
    updated_at: ts,
    version: 0,
    usage: null,
    round_snapshots: null,
    last_prompt_tokens: null,
    allow_spawn: !!allowSpawn,
    model_id: modelId != null ? String(modelId) : null,
    model_provider: modelProvider != null ? String(modelProvider) : null,
    messages: [],
  };
}

// ── 领域 mutator：整体替换结构化 transcript ──
export function recordMessages(session, { messages, rounds = null, now = nowIso() }) {
  if (TERMINAL_STATUSES.has(session.status)) {
    throw new Error(`record_messages() not allowed in terminal status ${session.status}`);
  }
  if (!Array.isArray(messages)) throw new Error('messages must be an array');
  if (rounds != null) session.rounds = rounds;
  session.messages = messages.slice();
  session.updated_at = now;
  return session;
}

// ── 领域 mutator：累加单轮 token 用量（并维护 last_prompt_tokens 替换-最后语义） ──
export function accumulateUsage(session, delta, { now = nowIso() } = {}) {
  if (!delta || typeof delta !== 'object') return session;
  const current = session.usage && typeof session.usage === 'object' ? { ...session.usage } : {};
  let folded = false;
  for (const [key, value] of Object.entries(delta)) {
    if (typeof value === 'boolean' || typeof value !== 'number') continue;
    current[key] = (Number(current[key]) || 0) + value;
    folded = true;
  }
  if (folded) session.usage = current;
  let lrp = delta.last_round_prompt_tokens;
  if (lrp == null) lrp = delta.prompt_tokens;
  const lrpInt = Number(lrp) || 0;
  if (lrpInt > 0) {
    session.last_prompt_tokens = lrpInt;
    folded = true;
  }
  if (folded) session.updated_at = now;
  return session;
}

export function setSessionModel(session, modelId, modelProvider, { now = nowIso() } = {}) {
  session.model_id = modelId != null ? String(modelId) : null;
  session.model_provider = modelProvider != null ? String(modelProvider) : null;
  session.updated_at = now;
  return session;
}

function _guardSettle(session, attempted) {
  if (TERMINAL_STATUSES.has(session.status)) {
    throw new Error(`${attempted}() not allowed from terminal status ${session.status}`);
  }
}

export function markDone(session, { rounds, now = nowIso() } = {}) {
  if (session.status === STATUS.DONE) return session;
  _guardSettle(session, 'mark_done');
  if (typeof rounds === 'number' && rounds >= 0) session.rounds = rounds;
  session.status = STATUS.DONE;
  session.updated_at = now;
  return session;
}

export function markError(session, { now = nowIso() } = {}) {
  if (session.status === STATUS.ERROR) return session;
  _guardSettle(session, 'mark_error');
  session.status = STATUS.ERROR;
  session.updated_at = now;
  return session;
}

export function markInterrupted(session, { now = nowIso() } = {}) {
  if (session.status === STATUS.INTERRUPTED) return session;
  _guardSettle(session, 'mark_interrupted');
  session.status = STATUS.INTERRUPTED;
  session.updated_at = now;
  return session;
}

export function takeOverByUser(session, { now = nowIso() } = {}) {
  if (session.status === STATUS.USER_OWNED && session.owner === OWNER.USER) return session;
  // 仅真正结束的 DONE 不可接管；INTERRUPTED / ERROR 是可恢复的，允许翻转为 USER_OWNED
  // （TERMINAL_STATUSES 仍用于 recordMessages/markDone 等"已结算不可直接写"守卫，此处语义不同）
  if (session.status === STATUS.DONE) {
    throw new Error(`take_over_by_user() not allowed from terminal status ${session.status}`);
  }
  session.owner = OWNER.USER;
  session.status = STATUS.USER_OWNED;
  session.updated_at = now;
  return session;
}

// 用户接管后续跑：一轮用户消息处理完后保持 USER_OWNED，允许用户继续在面板里发消息
export function markUserOwned(session, { now = nowIso() } = {}) {
  session.owner = OWNER.USER;
  session.status = STATUS.USER_OWNED;
  session.updated_at = now;
  return session;
}

export default SubAgentSessionStore;
