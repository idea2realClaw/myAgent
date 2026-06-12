// ============================================================
// Skill Loader — Compatible with Claude Code / OpenCode format
// Scans: .opencode/skills/, .claude/skills/, .agents/skills/
//        ~/.config/opencode/skills/, ~/.claude/skills/
// ============================================================

import fs from 'fs';
import path from 'path';
import os from 'os';
import yaml from 'js-yaml';

const SKILL_SEARCH_PATHS = [
  '.opencode/skills',
  '.claude/skills',
  '.agents/skills',
  path.join(os.homedir(), '.config', 'opencode', 'skills'),
  path.join(os.homedir(), '.claude', 'skills'),
  path.join(os.homedir(), '.agents', 'skills'),
  path.join(os.homedir(), '.workbuddy', 'skills'),
];

export class SkillLoader {
  constructor(cwd = process.cwd()) {
    this.cwd = cwd;
    this.skills = new Map(); // name -> { meta, content, path }
  }

  load() {
    this.skills.clear();

    for (const basePath of SKILL_SEARCH_PATHS) {
      const resolved = path.isAbsolute(basePath)
        ? basePath
        : path.join(this.cwd, basePath);

      if (!fs.existsSync(resolved)) continue;

      const entries = fs.readdirSync(resolved, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const skillFile = path.join(resolved, entry.name, 'SKILL.md');
        if (!fs.existsSync(skillFile)) continue;

        const raw = fs.readFileSync(skillFile, 'utf8');
        const parsed = this._parseSkillMd(raw, skillFile);
        if (!parsed) continue;

        const { meta, content } = parsed;
        const name = meta.name || entry.name;

        // First-found wins (project > global)
        if (!this.skills.has(name)) {
          this.skills.set(name, { meta, content, path: skillFile });
        }
      }
    }

    return this.skills;
  }

  _parseSkillMd(raw, filePath) {
    try {
      const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
      if (!fmMatch) {
        // No frontmatter — try to use filename as name
        const name = path.basename(path.dirname(filePath));
        return { meta: { name, description: raw.slice(0, 100) }, content: raw };
      }

      const meta = yaml.load(fmMatch[1]) || {};
      const content = fmMatch[2].trim();

      if (!meta.name || !meta.description) return null;
      return { meta, content };
    } catch {
      return null;
    }
  }

  getAll() {
    return Array.from(this.skills.values()).map(s => ({
      name: s.meta.name,
      description: s.meta.description,
    }));
  }

  getContent(name) {
    return this.skills.get(name)?.content || null;
  }

  toSystemPromptSnippet() {
    const list = this.getAll();
    if (list.length === 0) return '';
    const xml = list
      .map(s => `  <skill>\n    <name>${s.name}</name>\n    <description>${s.description}</description>\n  </skill>`)
      .join('\n');
    return `<available_skills>\n${xml}\n</available_skills>`;
  }
}
