// ============================================================
// Roster Template Store — 移植自 qaimodelbuilder roster_template
//                            (+ roster_template_management / repository)
//
// 轻量级 JSON 文件持久化（替代 SQLite），与 MyAgent 的 Node/Express 架构对齐。
// 一个 RosterTemplate 是一组可复用的「讨论角色定义」——一支团队（谁参与）：
//   id, name, description,
//   members: [{ display_name, model_id, persona, config:{allowed_tools,enabled_skills,color} }],
//   default_mode_id, is_builtin, cloned_from_id, created_at, updated_at
//
// 提供 CRUD + clone + reset，以及若干内置预设团队。
// 与 AgentTemplateStore 保持一致的代码风格，便于维护。
// ============================================================

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const STORE_FILE = path.join(DATA_DIR, 'roster-templates.json');

const MAX_NAME_LENGTH = 256;
const MAX_DESCRIPTION_LENGTH = 2000;
const MAX_MEMBER_DISPLAY_NAME_LENGTH = 256;
const MAX_MEMBERS = 50;
const MAX_PERSONA_LENGTH = 100_000;

// 内置预设团队（只读）
const BUILTIN_PRESETS = [
  {
    id: 'builtin-arch-team',
    name: 'arch_team',
    description: '架构师 + 开发者 + 测试协作的标准研发团队',
    members: [
      {
        display_name: 'Architect',
        model_id: null,
        persona:
          'You are a pragmatic software architect. Focus on system design, trade-offs, scalability, and maintainability. ' +
          'Challenge assumptions, propose clean interfaces, and call out risks early.',
        config: { allowed_tools: [], color: 0 },
      },
      {
        display_name: 'Developer',
        model_id: null,
        persona:
          'You are a hands-on full-stack developer. Focus on concrete implementation, correctness, and pragmatic solutions. ' +
          'Be willing to push back on over-engineering.',
        config: { allowed_tools: [], color: 1 },
      },
      {
        display_name: 'Tester',
        model_id: null,
        persona:
          'You are a rigorous QA engineer. Focus on edge cases, failure modes, test coverage, and verification. ' +
          'Be skeptical of "it works on my machine".',
        config: { allowed_tools: [], color: 2 },
      },
    ],
    default_mode_id: 'builtin-review',
    is_builtin: true,
    cloned_from_id: null,
  },
  {
    id: 'builtin-debate-team',
    name: 'debate_team',
    description: '乐观派 + 怀疑派 + 主持人的辩论三角色',
    members: [
      {
        display_name: 'Optimist',
        model_id: null,
        persona:
          'You are the optimistic voice. Argue strongly for the benefits, opportunities, and upside of the proposal. ' +
          'Be persuasive but honest — no strawmen.',
        config: { allowed_tools: [], color: 0 },
      },
      {
        display_name: 'Skeptic',
        model_id: null,
        persona:
          'You are the skeptical voice. Stress-test the proposal: risks, hidden costs, failure cases, and weak assumptions. ' +
          'Be constructively critical, not contrarian for its own sake.',
        config: { allowed_tools: [], color: 1 },
      },
      {
        display_name: 'Moderator',
        model_id: null,
        persona:
          'You are the moderator. Keep the debate focused on the topic, surface the crux of disagreement, and press both sides for evidence.',
        config: { allowed_tools: [], color: 2 },
      },
    ],
    default_mode_id: 'builtin-debate',
    is_builtin: true,
    cloned_from_id: null,
  },
  {
    id: 'builtin-review-team',
    name: 'review_team',
    description: '初级 + 资深 + 安全三人代码评审小组',
    members: [
      {
        display_name: 'Junior Reviewer',
        model_id: null,
        persona:
          'You are a junior reviewer. Catch obvious bugs, style issues, and readability problems. Ask clarifying questions.',
        config: { allowed_tools: [], color: 0 },
      },
      {
        display_name: 'Senior Reviewer',
        model_id: null,
        persona:
          'You are a senior reviewer. Focus on architecture, correctness under load, and long-term maintainability. ' +
          'Prioritize the highest-impact issues.',
        config: { allowed_tools: [], color: 1 },
      },
      {
        display_name: 'Security Expert',
        model_id: null,
        persona:
          'You are a security expert. Hunt for injection, authn/authz, data-leak, and dependency risks. Cite the threat clearly.',
        config: { allowed_tools: [], color: 2 },
      },
    ],
    default_mode_id: 'builtin-review',
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
    console.error('[RosterTemplateStore] failed to load store:', err.message);
  }
  return [];
}

function saveToDisk(records) {
  ensureDataDir();
  fs.writeFileSync(STORE_FILE, JSON.stringify(records, null, 2), 'utf8');
}

function validateMemberConfig(config) {
  if (config == null) return null;
  if (typeof config !== 'object' || Array.isArray(config)) {
    throw new TypeError('config must be an object or null');
  }
  const copy = { ...config };
  if (copy.allowed_tools !== undefined) {
    if (!Array.isArray(copy.allowed_tools) || !copy.allowed_tools.every((t) => typeof t === 'string')) {
      throw new TypeError("config.allowed_tools must be an array of strings");
    }
  }
  if (copy.enabled_skills !== undefined) {
    if (!Array.isArray(copy.enabled_skills) || !copy.enabled_skills.every((s) => typeof s === 'string')) {
      throw new TypeError("config.enabled_skills must be an array of strings");
    }
  }
  if (copy.color !== undefined && copy.color !== null) {
    if (typeof copy.color !== 'number' && typeof copy.color !== 'string') {
      throw new TypeError("config.color must be a number, string, or null");
    }
  }
  return copy;
}

function validateMember(member) {
  if (member == null || typeof member !== 'object' || Array.isArray(member)) {
    throw new TypeError('member must be an object');
  }
  if (typeof member.display_name !== 'string' || member.display_name.length > MAX_MEMBER_DISPLAY_NAME_LENGTH) {
    throw new Error(`member.display_name must be a string <= ${MAX_MEMBER_DISPLAY_NAME_LENGTH} chars`);
  }
  if (member.model_id !== undefined && member.model_id !== null && typeof member.model_id !== 'string') {
    throw new Error('member.model_id must be a string or null');
  }
  if (member.persona !== undefined && member.persona !== null) {
    if (typeof member.persona !== 'string') throw new Error('member.persona must be a string or null');
    if (member.persona.length > MAX_PERSONA_LENGTH) throw new Error(`member.persona <= ${MAX_PERSONA_LENGTH} chars`);
  }
  validateMemberConfig(member.config);
}

function normalizeMember(m) {
  return {
    display_name: m.display_name || '',
    model_id: m.model_id || null,
    persona: m.persona || null,
    config: validateMemberConfig(m.config),
  };
}

function validateRosterFields(fields) {
  if (fields.name !== undefined && (typeof fields.name !== 'string' || fields.name.length > MAX_NAME_LENGTH)) {
    throw new Error(`name must be a string <= ${MAX_NAME_LENGTH} chars`);
  }
  if (fields.description !== undefined && (typeof fields.description !== 'string' || fields.description.length > MAX_DESCRIPTION_LENGTH)) {
    throw new Error(`description must be a string <= ${MAX_DESCRIPTION_LENGTH} chars`);
  }
  if (fields.members !== undefined) {
    if (!Array.isArray(fields.members)) throw new TypeError('members must be an array');
    if (fields.members.length > MAX_MEMBERS) throw new Error(`a roster may not exceed ${MAX_MEMBERS} members`);
    fields.members.forEach(validateMember);
  }
  if (fields.default_mode_id !== undefined && fields.default_mode_id !== null) {
    if (typeof fields.default_mode_id !== 'string') throw new Error('default_mode_id must be a string or null');
  }
}

function normalizeRecord(rec) {
  return {
    id: rec.id,
    name: rec.name || '',
    description: rec.description || '',
    members: Array.isArray(rec.members) ? rec.members.map(normalizeMember) : [],
    default_mode_id: rec.default_mode_id || null,
    is_builtin: !!rec.is_builtin,
    cloned_from_id: rec.cloned_from_id || null,
    created_at: rec.created_at || nowIso(),
    updated_at: rec.updated_at || nowIso(),
  };
}

export class RosterTemplateStore {
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
    if (!rec) throw new Error(`roster template not found: ${id}`);
    return rec;
  }

  // ---- public write API ----
  create({ name, description, members, default_mode_id }) {
    validateRosterFields({ name, description, members, default_mode_id });
    const rec = normalizeRecord({
      id: uuidv4(),
      name: name || '',
      description: description || '',
      members: Array.isArray(members) ? members.map(normalizeMember) : [],
      default_mode_id: default_mode_id || null,
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
    validateRosterFields(patch);
    if (patch.name !== undefined) rec.name = patch.name;
    if (patch.description !== undefined) rec.description = patch.description;
    if (patch.members !== undefined) rec.members = patch.members.map(normalizeMember);
    if (patch.default_mode_id !== undefined) {
      const v = patch.default_mode_id;
      rec.default_mode_id = v && v.trim ? (v.trim() || null) : v || null;
    }
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
      members: src.members.map((m) => ({ ...m, config: m.config ? { ...m.config } : null })),
      default_mode_id: src.default_mode_id,
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
    copy.members = src.members.map((m) => ({ ...m, config: m.config ? { ...m.config } : null }));
    copy.default_mode_id = src.default_mode_id;
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
      members: rec.members,
      default_mode_id: rec.default_mode_id,
      is_builtin: rec.is_builtin,
      cloned_from_id: rec.cloned_from_id,
      created_at: rec.created_at,
      updated_at: rec.updated_at,
    };
  }
}

export default RosterTemplateStore;
