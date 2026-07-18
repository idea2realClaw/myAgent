// ============================================================
// Agent Template Store — 移植自 qaimodelbuilder agent_template + repository
//
// 轻量级 JSON 文件持久化（替代 SQLite），与 MyAgent 的 Node/Express 架构对齐。
// 一个 AgentTemplate 是单一可复用讨论角色的定义：
//   id, name, description, display_name, model_id, persona,
//   config { allowed_tools?, enabled_skills?, color? },
//   is_builtin, cloned_from_id, created_at, updated_at
//
// 提供 CRUD + clone + reset + apply，以及若干内置预设。
// ============================================================

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const STORE_FILE = path.join(DATA_DIR, 'agent-templates.json');

const MAX_NAME_LENGTH = 256;
const MAX_DISPLAY_NAME_LENGTH = 256;
const MAX_DESCRIPTION_LENGTH = 2000;
const MAX_PERSONA_LENGTH = 100_000;

// 内置预设（只读）：通用的单角色模板
const BUILTIN_PRESETS = [
  {
    id: 'builtin-code-reviewer',
    name: 'code_reviewer',
    description: '专注代码审查与质量改进的资深工程师',
    display_name: 'Code Reviewer',
    model_id: null,
    persona:
      'You are a meticulous code reviewer. Focus on correctness, readability, performance, security, and maintainability. ' +
      'Point out concrete issues with file paths and line numbers where possible, and suggest actionable improvements. ' +
      'Be concise but thorough.',
    config: { allowed_tools: ['file_read', 'file_grep', 'file_glob'], color: 0 },
    is_builtin: true,
    cloned_from_id: null,
  },
  {
    id: 'builtin-fullstack-dev',
    name: 'fullstack_dev',
    description: '熟悉前后端、数据库与部署的全栈开发者',
    display_name: 'Full-stack Developer',
    model_id: null,
    persona:
      'You are a pragmatic full-stack developer. You can read, write, edit and execute code across the stack. ' +
      'Prefer simple, robust solutions. Always explain the trade-offs of your recommendations.',
    config: { allowed_tools: ['file_read', 'file_write', 'file_edit', 'file_glob', 'file_grep', 'shell_execute'], color: 1 },
    is_builtin: true,
    cloned_from_id: null,
  },
  {
    id: 'builtin-test-engineer',
    name: 'test_engineer',
    description: '严谨、覆盖全面的测试工程师',
    display_name: 'Test Engineer',
    model_id: null,
    persona:
      'You are a rigorous test engineer. You design test plans, identify edge cases, write test cases, and analyze code for bugs. ' +
      'Report findings with clear reproduction steps and severity levels.',
    config: { allowed_tools: ['file_read', 'file_grep', 'file_glob', 'shell_execute'], color: 2 },
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
    console.error('[AgentTemplateStore] failed to load store:', err.message);
  }
  return [];
}

function saveToDisk(records) {
  ensureDataDir();
  fs.writeFileSync(STORE_FILE, JSON.stringify(records, null, 2), 'utf8');
}

function validateConfig(config) {
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

function validateTemplateFields(fields) {
  if (fields.name !== undefined && (typeof fields.name !== 'string' || fields.name.length > MAX_NAME_LENGTH)) {
    throw new Error(`name must be a string <= ${MAX_NAME_LENGTH} chars`);
  }
  if (fields.display_name !== undefined && (typeof fields.display_name !== 'string' || fields.display_name.length > MAX_DISPLAY_NAME_LENGTH)) {
    throw new Error(`display_name must be a string <= ${MAX_DISPLAY_NAME_LENGTH} chars`);
  }
  if (fields.description !== undefined && (typeof fields.description !== 'string' || fields.description.length > MAX_DESCRIPTION_LENGTH)) {
    throw new Error(`description must be a string <= ${MAX_DESCRIPTION_LENGTH} chars`);
  }
  if (fields.model_id !== undefined && fields.model_id !== null && typeof fields.model_id !== 'string') {
    throw new Error('model_id must be a string or null');
  }
  if (fields.persona !== undefined && fields.persona !== null) {
    if (typeof fields.persona !== 'string') throw new Error('persona must be a string or null');
    if (fields.persona.length > MAX_PERSONA_LENGTH) throw new Error(`persona <= ${MAX_PERSONA_LENGTH} chars`);
  }
  if (fields.config !== undefined) validateConfig(fields.config);
}

function normalizeRecord(rec) {
  return {
    id: rec.id,
    name: rec.name || '',
    description: rec.description || '',
    display_name: rec.display_name || '',
    model_id: rec.model_id || null,
    persona: rec.persona || null,
    config: rec.config || null,
    is_builtin: !!rec.is_builtin,
    cloned_from_id: rec.cloned_from_id || null,
    created_at: rec.created_at || nowIso(),
    updated_at: rec.updated_at || nowIso(),
  };
}

export class AgentTemplateStore {
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
    // 内置在前，随后按 created_at 升序
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
    if (!rec) throw new Error(`agent template not found: ${id}`);
    return rec;
  }

  // ---- public write API ----
  create({ name, description, display_name, model_id, persona, config }) {
    validateTemplateFields({ name, description, display_name, model_id, persona, config });
    const rec = normalizeRecord({
      id: uuidv4(),
      name: name || '',
      description: description || '',
      display_name: display_name || '',
      model_id: model_id || null,
      persona: persona || null,
      config: validateConfig(config),
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
    validateTemplateFields(patch);
    if (patch.name !== undefined) rec.name = patch.name;
    if (patch.description !== undefined) rec.description = patch.description;
    if (patch.display_name !== undefined) rec.display_name = patch.display_name;
    if (patch.model_id !== undefined) rec.model_id = patch.model_id;
    if (patch.persona !== undefined) rec.persona = patch.persona;
    if (patch.config !== undefined) rec.config = validateConfig(patch.config);
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
      display_name: src.display_name,
      model_id: src.model_id,
      persona: src.persona,
      config: src.config ? { ...src.config } : null,
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
    copy.display_name = src.display_name;
    copy.model_id = src.model_id;
    copy.persona = src.persona;
    copy.config = src.config ? { ...src.config } : null;
    copy.updated_at = nowIso();
    this._persist();
    return copy;
  }

  // ---- apply to session ----
  // 返回一个可注入当前会话系统的对象：display name + persona + config
  apply(id) {
    const rec = this.get(id);
    return {
      id: rec.id,
      display_name: rec.display_name,
      name: rec.name,
      model_id: rec.model_id,
      persona: rec.persona || '',
      config: rec.config || {},
    };
  }

  // 序列化为供 REST/前端消费的 wire 形状
  toWire(rec) {
    return {
      id: rec.id,
      name: rec.name,
      description: rec.description,
      display_name: rec.display_name,
      model_id: rec.model_id,
      persona: rec.persona,
      config: rec.config,
      is_builtin: rec.is_builtin,
      cloned_from_id: rec.cloned_from_id,
      created_at: rec.created_at,
      updated_at: rec.updated_at,
    };
  }
}

export default AgentTemplateStore;
