// experience-store.js — 经验记忆（移植自 qai-appbuilder 的 experience 设计）
// 让 Agent "越用越聪明"：成功完成 agentic 任务后，用 LLM 提炼可复用知识存入经验库；
// 下次相似任务开始时，召回相关经验并注入 system prompt（<past_experiences> 块）。
//
// 存储：data/experiences.json（文件型，轻量、无需 sqlite）。data/ 已被 .gitignore 忽略。

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '..', 'data');
const STORE_PATH = path.join(DATA_DIR, 'experiences.json');

let _store = null;

function load() {
  if (_store) return _store;
  try {
    _store = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
  } catch {
    _store = { experiences: [] };
  }
  if (!_store.experiences) _store.experiences = [];
  return _store;
}

function persist() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STORE_PATH, JSON.stringify(_store, null, 2), 'utf8');
  } catch (e) {
    console.warn('[experience] persist failed:', e.message);
  }
}

// 召回相关性闸门：必须有真实词元重叠且重叠率达标，否则不召回。
// （否则无关经验会被塞进 system prompt，污染上下文、误导模型。）
const MIN_OVERLAP = 1;
const MIN_RELEVANCE = 0.12;

// 中文没有空格，若整串当一个词元则永远无法重叠匹配。
// 这里：英文/数字按词切；连续汉字串切成字符 bi-gram（单字串保留单字）。
function tokenize(s) {
  const out = [];
  const chunks = (s || '').toLowerCase().match(/[a-z0-9]+|[\u4e00-\u9fa5]+/g) || [];
  for (const c of chunks) {
    if (/[\u4e00-\u9fa5]/.test(c)) {
      if (c.length === 1) { out.push(c); continue; }
      for (let i = 0; i + 1 < c.length; i++) out.push(c.slice(i, i + 2));
    } else {
      out.push(c);
    }
  }
  return out;
}

function escapeXml(s) {
  return String(s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
}

function parseJsonArray(s) {
  try {
    const m = String(s).match(/\[[\s\S]*\]/);
    if (!m) return [];
    const arr = JSON.parse(m[0]);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export class ExperienceStore {
  constructor() {
    this.data = load();
  }

  add(exp) {
    const content = String(exp?.content || '').trim();
    if (!content) return null;
    const e = {
      id: 'exp_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      category: exp?.category || 'general',
      content,
      metadata: {
        tags: exp?.metadata?.tags || [],
        source: exp?.metadata?.source || 'auto',
        score: exp?.metadata?.score || 1,
      },
      createdAt: new Date().toISOString(),
    };
    this.data.experiences.push(e);
    if (this.data.experiences.length > 500) {
      this.data.experiences = this.data.experiences.slice(-500);
    }
    persist();
    return e;
  }

  all() {
    return this.data.experiences;
  }

  // 关键词/词元重叠打分，取 top-k；无 sqlite 时足够用于经验召回
  search(query, k = 5) {
    const q = new Set(tokenize(query));
    if (!q.size) return [];
    const scored = this.data.experiences
      .map((e) => {
        const t = new Set(
          tokenize(e.content + ' ' + (e.metadata.tags || []).join(' ') + ' ' + e.category)
        );
        let inter = 0;
        for (const w of q) if (t.has(w)) inter++;
        // 归一化重叠率：短 query 配长经验时也稳定；基础分只做同分时的 tie-breaker，
        // 不能参与"是否召回"的判定，否则闸门恒真。
        const rel = inter / Math.min(q.size, Math.max(t.size, 1));
        return { e, inter, rel, score: rel + (e.metadata.score || 1) * 0.001 };
      })
      .filter((x) => x.inter >= MIN_OVERLAP && x.rel >= MIN_RELEVANCE)
      .sort((a, b) => b.score - a.score);
    return scored.slice(0, k).map((x) => x.e);
  }

  // 生成注入 system prompt 的 <past_experiences> XML 块；无命中返回 ''
  recallBlock(query, k = 5) {
    const hits = this.search(query, k);
    if (!hits.length) return '';
    const items = hits
      .map(
        (e, i) =>
          `<experience index="${i + 1}" category="${escapeXml(e.category)}">\n${e.content}\n</experience>`
      )
      .join('\n');
    return (
      `<past_experiences>\n` +
      `以下是过往相似任务中积累的可复用经验，请优先参考其方法与结论（但需结合本次实际情况判断，不要盲目照搬）：\n` +
      `${items}\n` +
      `</past_experiences>`
    );
  }

  // 提炼触发条件（对齐 qai：回合>2 且至少跑过一次工具）
  shouldExtract(roundIndex, toolsRan) {
    return (roundIndex >= 2) && Array.isArray(toolsRan) && toolsRan.length > 0;
  }

  // 成功 agentic 回合后调用 —— 设计为 fire-and-forget，内部吞掉所有错误，绝不阻塞回复。
  async extract(llm, ctx, question, opts = {}) {
    try {
      if (!this.shouldExtract(opts.roundIndex ?? 3, opts.toolsRan || [])) return [];
      const prompt =
        `你是一个经验提炼器。给定一段刚完成的任务上下文，请提炼 0~2 条可复用的经验` +
        `（方法、踩坑、结论、适用的工具或注意点），用于帮助未来类似任务。\n` +
        `只输出 JSON 数组，每条形如 {"category":"...","content":"...","tags":["..."]}。` +
        `若无有价值经验，输出 []。不要输出任何解释文字，只输出 JSON 数组。\n\n` +
        `任务问题：${question}\n\n` +
        `任务上下文（含工具真实结果）：\n${String(ctx).slice(-6000)}`;
      const raw = await llm.chat([{ role: 'user', content: prompt }], { temperature: 0.2, maxTokens: 600 });
      const arr = parseJsonArray(raw);
      const added = [];
      for (const x of arr) {
        const e = this.add({
          category: x.category,
          content: x.content,
          metadata: { tags: x.tags, source: 'auto-extract' },
        });
        if (e) added.push(e);
      }
      if (added.length) console.log(`[experience] 提炼并存储 ${added.length} 条经验`);
      return added;
    } catch (e) {
      console.warn('[experience] extract failed:', e.message);
      return [];
    }
  }
}

// 单例（进程内共享经验库）
export const experienceStore = new ExperienceStore();
export default experienceStore;
