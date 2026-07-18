// ============================================================
// Mode Template Store — 移植自 qaimodelbuilder mode_template
//                           (+ mode_template_management / repository)
//
// 轻量级 JSON 文件持久化（替代 SQLite），与 MyAgent 的 Node/Express 架构对齐。
// 一个 ModeTemplate 是一个「协作模式」——怎么协作（讨论 / 评审 / 辩论 / 实施）：
//   id, name, description, framing,
//   tool_policy:  { default: 'allow'|'deny', tools: { name: 'allow'|'deny' } }
//   flow_policy:  { speaker_strategy, max_rounds, judge_enabled, allow_mode_switch, system_model_id }
//   hard_constraints: { max_chars_per_turn, max_seconds_per_turn }
//   is_builtin, cloned_from_id, created_at, updated_at
//
// 与 AgentTemplateStore / RosterTemplateStore 保持一致的代码风格。
// ============================================================

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const STORE_FILE = path.join(DATA_DIR, 'mode-templates.json');

const MAX_NAME_LENGTH = 256;
const MAX_DESCRIPTION_LENGTH = 2000;
const MAX_FRAMING_LENGTH = 8000;
const _MIN_MAX_CHARS_PER_TURN = 50;
const _MAX_MAX_CHARS_PER_TURN = 5000;
const _MIN_MAX_SECONDS_PER_TURN = 5;
const _MAX_MAX_SECONDS_PER_TURN = 600;

// 内置预设协作模式（只读）
const BUILTIN_PRESETS = [
  {
    id: 'builtin-discuss',
    name: 'discuss',
    description: '自由开放的多角色讨论，鼓励充分表达',
    framing: '',
    tool_policy: { default: 'allow', tools: {} },
    flow_policy: { speaker_strategy: 'round_robin', max_rounds: 4, judge_enabled: true, allow_mode_switch: true, system_model_id: null },
    hard_constraints: { max_chars_per_turn: null, max_seconds_per_turn: null },
    is_builtin: true,
    cloned_from_id: null,
  },
  {
    id: 'builtin-review',
    name: 'review',
    description: '围绕交付物（代码/方案）的多视角评审，评审者轮流给出意见',
    framing:
      '本场为评审会议。每位参与者从自身角色出发，针对主题给出具体、可执行的评审意见：' +
      '问题点、严重程度、改进建议。聚焦事实与证据，避免空泛评价。',
    tool_policy: { default: 'allow', tools: {} },
    flow_policy: { speaker_strategy: 'round_robin', max_rounds: 3, judge_enabled: true, allow_mode_switch: true, system_model_id: null },
    hard_constraints: { max_chars_per_turn: null, max_seconds_per_turn: null },
    is_builtin: true,
    cloned_from_id: null,
  },
  {
    id: 'builtin-debate',
    name: 'debate',
    description: '正反双方 + 主持人的辩论，最终由主持人综合',
    framing:
      '本场为辩论。正方充分论证主张的收益与可行性，反方系统性地提出风险与反例。' +
      '发言须有依据、针对对方论点，不得偷换概念。主持人负责聚焦议题、暴露分歧核心。',
    tool_policy: { default: 'allow', tools: {} },
    flow_policy: { speaker_strategy: 'manager', max_rounds: 3, judge_enabled: true, allow_mode_switch: true, system_model_id: null },
    hard_constraints: { max_chars_per_turn: null, max_seconds_per_turn: null },
    is_builtin: true,
    cloned_from_id: null,
  },
  {
    id: 'builtin-implement',
    name: 'implement',
    description: '实施模式：聚焦落地方案与执行计划（讨论阶段不执行工具）',
    framing:
      '本场为实施方案讨论。聚焦可落地的方案、步骤分解、依赖与风险，输出清晰的执行计划。' +
      '讨论阶段只做规划与决策，不实际执行命令。',
    tool_policy: { default: 'deny', tools: {} },
    flow_policy: { speaker_strategy: 'round_robin', max_rounds: 3, judge_enabled: false, allow_mode_switch: true, system_model_id: null },
    hard_constraints: { max_chars_per_turn: null, max_seconds_per_turn: null },
    is_builtin: true,
    cloned_from_id: null,
  },
];

function nowIso() {
  return new Date().toISOString();
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadFromDisk() {
  ensureDataDir();
  if (!fs.existsSync(STORE_FILE)) return [];
  try {
    const raw = fs.readFileSync(STORE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
  } catch (err) {
    console.error('[ModeTemplateStore] failed to load store:', err.message);
  }
  return [];
}

function saveToDisk(records) {
  ensureDataDir();
  fs.writeFileSync(STORE_FILE, JSON.stringify(records, null, 2), 'utf8');
}

function coerceToolPolicy(raw) {
  if (raw === 'allow' || raw === 'deny') return raw;
  if (raw === 'ALLOW' || raw === 'DENY') return raw.toLowerCase();
  return 'allow';
}

function validateToolPolicy(policy) {
  if (policy == null) return { default: 'allow', tools: {} };
  if (typeof policy !== 'object' || Array.isArray(policy)) {
    throw new TypeError('tool_policy must be an object or null');
  }
  const def = coerceToolPolicy(policy.default ?? 'allow');
  const tools = {};
  if (policy.tools && typeof policy.tools === 'object' && !Array.isArray(policy.tools)) {
    for (const [name, p] of Object.entries(policy.tools)) {
      if (typeof name !== 'string') continue;
      tools[name] = coerceToolPolicy(p);
    }
  }
  return { default: def, tools };
}

function validateFlowPolicy(flow) {
  if (flow == null) return { speaker_strategy: 'round_robin', max_rounds: 8, judge_enabled: true, allow_mode_switch: true, system_model_id: null };
  if (typeof flow !== 'object' || Array.isArray(flow)) {
    throw new TypeError('flow_policy must be an object or null');
  }
  const strategy = flow.speaker_strategy === 'manager' ? 'manager' : 'round_robin';
  let maxRounds = 8;
  if (typeof flow.max_rounds === 'number' && !Number.isNaN(flow.max_rounds)) {
    maxRounds = Math.min(Math.max(Math.trunc(flow.max_rounds), 1), 1000);
  }
  const judge = flow.judge_enabled === undefined ? true : !!flow.judge_enabled;
  const allowSwitch = flow.allow_mode_switch === undefined ? true : !!flow.allow_mode_switch;
  const systemModel = typeof flow.system_model_id === 'string' ? flow.system_model_id : null;
  return { speaker_strategy: strategy, max_rounds: maxRounds, judge_enabled: judge, allow_mode_switch: allowSwitch, system_model_id: systemModel };
}

function validateHardConstraints(hc) {
  if (hc == null) return { max_chars_per_turn: null, max_seconds_per_turn: null };
  if (typeof hc !== 'object' || Array.isArray(hc)) {
    throw new TypeError('hard_constraints must be an object or null');
  }
  const clamp = (v, lo, hi) => {
    if (v === null || v === undefined) return null;
    if (typeof v !== 'number' || Number.isNaN(v)) return null;
    return Math.min(Math.max(Math.trunc(v), lo), hi);
  };
  return {
    max_chars_per_turn: clamp(hc.max_chars_per_turn, _MIN_MAX_CHARS_PER_TURN, _MAX_MAX_CHARS_PER_TURN),
    max_seconds_per_turn: clamp(hc.max_seconds_per_turn, _MIN_MAX_SECONDS_PER_TURN, _MAX_MAX_SECONDS_PER_TURN),
  };
}

function validateModeFields(fields) {
  if (fields.name !== undefined && (typeof fields.name !== 'string' || fields.name.length > MAX_NAME_LENGTH)) {
    throw new Error(`name must be a string <= ${MAX_NAME_LENGTH} chars`);
  }
  if (fields.description !== undefined && (typeof fields.description !== 'string' || fields.description.length > MAX_DESCRIPTION_LENGTH)) {
    throw new Error(`description must be a string <= ${MAX_DESCRIPTION_LENGTH} chars`);
  }
  if (fields.framing !== undefined && fields.framing !== null) {
    if (typeof fields.framing !== 'string') throw new Error('framing must be a string or null');
    if (fields.framing.length > MAX_FRAMING_LENGTH) throw new Error(`framing <= ${MAX_FRAMING_LENGTH} chars`);
  }
  if (fields.tool_policy !== undefined) validateToolPolicy(fields.tool_policy);
  if (fields.flow_policy !== undefined) validateFlowPolicy(fields.flow_policy);
  if (fields.hard_constraints !== undefined) validateHardConstraints(fields.hard_constraints);
}

function normalizeRecord(rec) {
  return {
    id: rec.id,
    name: rec.name || '',
    description: rec.description || '',
    framing: rec.framing || '',
    tool_policy: validateToolPolicy(rec.tool_policy),
    flow_policy: validateFlowPolicy(rec.flow_policy),
    hard_constraints: validateHardConstraints(rec.hard_constraints),
    is_builtin: !!rec.is_builtin,
    cloned_from_id: rec.cloned_from_id || null,
    created_at: rec.created_at || nowIso(),
    updated_at: rec.updated_at || nowIso(),
  };
}

export class ModeTemplateStore {
  constructor() {
    this._records = [];
    this._load();
  }

  _load() {
    const user = loadFromDisk();
    const builtinIds = new Set(BUILTIN_PRESETS.map((b) => b.id));
    const userWithoutBuiltins = user.filter((r) => !builtinIds.has(r.id));
    const merged = [...BUILTIN_PRESETS.map((b) => normalizeRecord(b)), ...userWithoutBuiltins.map(normalizeRecord)];
    this._records = merged;
  }

  _persist() {
    const userOnly = this._records.filter((r) => !r.is_builtin);
    saveToDisk(userOnly);
  }

  // ---- public read API ----
  list() {
    return this._records
      .slice()
      .sort((a, b) => {
        if (a.is_builtin && !b.is_builtin) return -1;
        if (!a.is_builtin && b.is_builtin) return 1;
        return new Date(a.created_at) - new Date(b.created_at);
      });
  }

  find(id) {
    return this._records.find((r) => r.id === id) || null;
  }

  get(id) {
    const rec = this.find(id);
    if (!rec) throw new Error(`mode template not found: ${id}`);
    return rec;
  }

  // ---- public write API ----
  create({ name, description, framing, tool_policy, flow_policy, hard_constraints }) {
    validateModeFields({ name, description, framing, tool_policy, flow_policy, hard_constraints });
    const rec = normalizeRecord({
      id: uuidv4(),
      name: name || '',
      description: description || '',
      framing: framing || '',
      tool_policy: validateToolPolicy(tool_policy),
      flow_policy: validateFlowPolicy(flow_policy),
      hard_constraints: validateHardConstraints(hard_constraints),
      is_builtin: false,
      cloned_from_id: null,
      created_at: nowIso(),
      updated_at: nowIso(),
    });
    this._records.push(rec);
    this._persist();
    return rec;
  }

  update(id, patch) {
    const rec = this.get(id);
    if (rec.is_builtin) throw new Error('built-in preset cannot be modified');
    validateModeFields(patch);
    if (patch.name !== undefined) rec.name = patch.name;
    if (patch.description !== undefined) rec.description = patch.description;
    if (patch.framing !== undefined) rec.framing = patch.framing;
    if (patch.tool_policy !== undefined) rec.tool_policy = validateToolPolicy(patch.tool_policy);
    if (patch.flow_policy !== undefined) rec.flow_policy = validateFlowPolicy(patch.flow_policy);
    if (patch.hard_constraints !== undefined) rec.hard_constraints = validateHardConstraints(patch.hard_constraints);
    rec.updated_at = nowIso();
    this._persist();
    return rec;
  }

  delete(id) {
    const rec = this.get(id);
    if (rec.is_builtin) throw new Error('built-in preset cannot be deleted');
    this._records = this._records.filter((r) => r.id !== id);
    this._persist();
  }

  clone(id) {
    const src = this.get(id);
    const rec = normalizeRecord({
      id: uuidv4(),
      name: `${src.name} (副本)`,
      description: src.description,
      framing: src.framing,
      tool_policy: JSON.parse(JSON.stringify(src.tool_policy)),
      flow_policy: JSON.parse(JSON.stringify(src.flow_policy)),
      hard_constraints: JSON.parse(JSON.stringify(src.hard_constraints)),
      is_builtin: false,
      cloned_from_id: src.id,
      created_at: nowIso(),
      updated_at: nowIso(),
    });
    this._records.push(rec);
    this._persist();
    return rec;
  }

  reset(id) {
    const copy = this.get(id);
    if (copy.is_builtin || !copy.cloned_from_id) {
      throw new Error('only a clone of another template can be reset');
    }
    const src = this.get(copy.cloned_from_id);
    copy.name = src.name;
    copy.description = src.description;
    copy.framing = src.framing;
    copy.tool_policy = JSON.parse(JSON.stringify(src.tool_policy));
    copy.flow_policy = JSON.parse(JSON.stringify(src.flow_policy));
    copy.hard_constraints = JSON.parse(JSON.stringify(src.hard_constraints));
    copy.updated_at = nowIso();
    this._persist();
    return copy;
  }

  // 序列化为供 REST/前端消费的 wire 形状
  toWire(rec) {
    return {
      id: rec.id,
      name: rec.name,
      description: rec.description,
      framing: rec.framing,
      tool_policy: rec.tool_policy,
      flow_policy: rec.flow_policy,
      hard_constraints: rec.hard_constraints,
      is_builtin: rec.is_builtin,
      cloned_from_id: rec.cloned_from_id,
      created_at: rec.created_at,
      updated_at: rec.updated_at,
    };
  }
}

export default ModeTemplateStore;
