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
    this.skills = new Map(); // name -> { meta, content, path, enabled }
    this.disabledSkills = new Set(); // Set of disabled skill names
    this.configFile = path.join(cwd, 'config.json');
  }

  load() {
    this.skills.clear();
    
    // Load disabled skills from config
    this._loadConfig();

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
          const enabled = !this.disabledSkills.has(name);
          this.skills.set(name, { meta, content, path: skillFile, enabled });
        }
      }
    }

    return this.skills;
  }
  
  _loadConfig() {
    try {
      if (fs.existsSync(this.configFile)) {
        const config = JSON.parse(fs.readFileSync(this.configFile, 'utf8'));
        if (config.disabledSkills && Array.isArray(config.disabledSkills)) {
          this.disabledSkills = new Set(config.disabledSkills);
        }
      }
    } catch (err) {
      console.error('[SkillLoader] Failed to load config:', err.message);
    }
  }
  
  _saveConfig() {
    try {
      let config = {};
      if (fs.existsSync(this.configFile)) {
        config = JSON.parse(fs.readFileSync(this.configFile, 'utf8'));
      }
      config.disabledSkills = Array.from(this.disabledSkills);
      fs.writeFileSync(this.configFile, JSON.stringify(config, null, 2));
    } catch (err) {
      console.error('[SkillLoader] Failed to save config:', err.message);
    }
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
      path: s.path,
      enabled: s.enabled,
    }));
  }
  
  getEnabled() {
    return Array.from(this.skills.values())
      .filter(s => s.enabled)
      .map(s => ({
        name: s.meta.name,
        description: s.meta.description,
      }));
  }

  getContent(name) {
    const skill = this.skills.get(name);
    if (!skill || !skill.enabled) return null;
    return skill.content;
  }
  
  getSearchPaths() {
    const paths = [];
    for (const basePath of SKILL_SEARCH_PATHS) {
      const resolved = path.isAbsolute(basePath)
        ? basePath
        : path.join(this.cwd, basePath);
      if (fs.existsSync(resolved)) {
        paths.push(resolved);
      }
    }
    return paths;
  }
  
  isEnabled(name) {
    return this.skills.has(name) && this.skills.get(name).enabled;
  }
  
  enable(name) {
    if (this.skills.has(name)) {
      this.skills.get(name).enabled = true;
    }
    this.disabledSkills.delete(name);
    this._saveConfig();
  }
  
  disable(name) {
    if (this.skills.has(name)) {
      this.skills.get(name).enabled = false;
    }
    this.disabledSkills.add(name);
    this._saveConfig();
  }
  
  scanDirectory(dirPath) {
    // Scan a directory for skills and return list (without adding to loaded skills)
    const results = [];
    
    if (!fs.existsSync(dirPath)) {
      return { error: `Directory not found: ${dirPath}` };
    }
    
    try {
      let searchDir = dirPath;
      
      // If the path itself is a skill directory (contains SKILL.md), use its parent
      const skillFile = path.join(dirPath, 'SKILL.md');
      if (fs.existsSync(skillFile)) {
        searchDir = path.dirname(dirPath);
      }
      
      const entries = fs.readdirSync(searchDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const skillFile2 = path.join(searchDir, entry.name, 'SKILL.md');
        if (!fs.existsSync(skillFile2)) continue;
        
        const raw = fs.readFileSync(skillFile2, 'utf8');
        const parsed = this._parseSkillMd(raw, skillFile2);
        if (!parsed) continue;
        
        results.push({
          name: parsed.meta.name || entry.name,
          description: parsed.meta.description,
          path: skillFile2,
          alreadyLoaded: this.skills.has(parsed.meta.name || entry.name),
        });
      }
      
      return { skills: results };
    } catch (err) {
      return { error: err.message };
    }
  }
  
  addSkillFromPath(skillPath, targetDir) {
    // Copy a skill from source path to target directory
    try {
      const srcDir = path.dirname(skillPath);
      const skillName = path.basename(srcDir);
      const destDir = path.join(targetDir, skillName);
      
      // Create target directory if not exists
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }
      
      // Copy skill directory
      if (fs.existsSync(destDir)) {
        return { error: `Skill already exists at ${destDir}` };
      }
      
      this._copyDir(srcDir, destDir);
      
      // Reload skills
      this.load();
      
      return { success: true, name: skillName, path: destDir };
    } catch (err) {
      return { error: err.message };
    }
  }
  
  _copyDir(src, dest) {
    fs.mkdirSync(dest, { recursive: true });
    const entries = fs.readdirSync(src, { withFileTypes: true });
    
    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);
      
      if (entry.isDirectory()) {
        this._copyDir(srcPath, destPath);
      } else {
        fs.copyFileSync(srcPath, destPath);
      }
    }
  }

  toSystemPromptSnippet() {
    const list = this.getEnabled();
    if (list.length === 0) return '';
    const xml = list
      .map(s => `  <skill>\n    <name>${s.name}</name>\n    <description>${s.description}</description>\n  </skill>`)
      .join('\n');
    return `<available_skills>\n${xml}\n</available_skills>`;
  }

  // ── 只读注入：按需把某个 skill 全文喂给 Agent（移植自 qaimodelbuilder skill 注入） ──
  // 用于 agent 循环中的 `skill` 工具：模型主动加载某 skill 的完整指令后遵循执行。
  // 支持分页 + 截断，避免超长 skill 撑爆上下文（与 qaimodelbuilder 的只读注入 + 分页一致）。
  getSkillContentForInjection(name, { page = 0, pageSize = 6000, maxChars = 24000 } = {}) {
    const skill = this.skills.get(name);
    if (!skill || !skill.enabled) return null;

    let content = skill.content || '';
    const totalChars = content.length;
    const truncated = totalChars > maxChars;
    if (truncated) content = content.slice(0, maxChars);

    const pages = Math.max(1, Math.ceil(content.length / pageSize));
    const safePage = Math.min(Math.max(page, 0), pages - 1);
    const start = safePage * pageSize;
    const end = Math.min(start + pageSize, content.length);
    const pageContent = content.slice(start, end);

    return {
      name: skill.meta.name,
      description: skill.meta.description,
      content: pageContent,
      page: safePage,
      pages,
      hasMore: safePage < pages - 1,
      totalChars,
      truncated,
    };
  }

  // 导出供 `skill` 工具使用的 schema 形状（OpenAI 函数调用）
  toToolSchema() {
    const list = this.getEnabled();
    return {
      type: 'function',
      function: {
        name: 'skill',
        description:
          'Load a skill\'s full instructions by name and follow them. ' +
          'Available skills: ' + (list.map(s => s.name).join(', ') || '(none)') +
          '. Call this when the user references a skill or when a skill would help.',
        parameters: {
          type: 'object',
          required: ['name'],
          properties: {
            name: {
              type: 'string',
              enum: list.map(s => s.name),
              description: 'Name of the skill to load',
            },
            page: { type: 'number', description: 'Page index for long skills (default 0)' },
          },
        },
      },
    };
  }
}
