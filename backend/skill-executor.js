// ============================================================
// Skill Executor — ported from old main (skill-exec.js / skill-executor.js)
// 解析 SKILL.md 中的执行命令，用子进程真正运行（确保命令完整执行而非只给计划）
// ============================================================

import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { decodeShell } from './shell-decode.js';

const execAsync = promisify(exec);

// 占位符：$1 / $INPUT / {{input}}
const INPUT_PLACEHOLDER = /\$1|\$INPUT|\{\{input\}\}/g;

/**
 * 从 SKILL.md 内容里提取“可直接执行”的命令。
 * 优先级：
 *  1) ```bash 代码块中的 python3?/node 命令
 *  2) “## 使用方法”章节里的首个非注释命令
 *  3) scripts/ 目录下发现的 run/main/*.py 脚本
 * 返回命令字符串（含 $1/$INPUT 占位符）或 null。
 */
export function extractExecutionCommand(skillContent, skillPath) {
  if (!skillContent) return null;

  const sanitize = (cmd) => (cmd || '').trim().replace(/"$/, '');

  // ① bash 代码块里找 python/node 命令
  const bashBlockRegex = /```bash\r?\n([\s\S]*?)```/g;
  let match;
  while ((match = bashBlockRegex.exec(skillContent)) !== null) {
    const code = match[1];
    const cmdMatch = code.match(/(python3?|node)\s+.+/);
    if (cmdMatch) return sanitize(cmdMatch[0]);
  }

  // ② “## 使用方法”章节
  const usageSection = skillContent.match(/##\s*使用方法\s*\n([\s\S]*?)(?=\n##|$)/);
  if (usageSection) {
    const bashMatch = usageSection[1].match(/```bash\r?\n([\s\S]*?)```/);
    const block = bashMatch ? bashMatch[1] : usageSection[1];
    const lines = block.split(/\r?\n/);
    for (const line of lines) {
      const t = line.trim();
      if (t && !t.startsWith('#') && !/^```/.test(t)) {
        // 取首个看起来像命令（含 python/node/脚本名）的行
        if (/(python3?|node)\s|\.py|\.sh|\.js/.test(t)) return sanitize(t);
      }
    }
  }

  // ③ scripts/ 目录
  if (skillPath) {
    const scriptsDir = path.join(skillPath, 'scripts');
    if (fs.existsSync(scriptsDir)) {
      const files = fs.readdirSync(scriptsDir);
      const mainScript = files.find(f =>
        f.startsWith('run') || f.startsWith('main') || f.endsWith('.py')
      );
      if (mainScript) {
        const isPy = mainScript.endsWith('.py');
        return `${isPy ? 'python3' : 'node'} scripts/${mainScript} $INPUT`;
      }
    }
  }

  return null;
}

export class SkillExecutor {
  constructor(skillLoader, rootDir) {
    this.skillLoader = skillLoader;
    this.rootDir = rootDir;
  }

  /**
   * 检测自然语言里是否包含「用 X skill 做 Y」的意图
   * 返回 { skillName, question } 或 null
   */
  detectSkillCall(message) {
    const patterns = [
      /请.*?用\s*(.+?)\s*skill\s*(?:to|来|去)?\s*[:：]?\s*(.+)/i,
      /please.*?use\s+(.+?)\s*skill\s*(?:to)?\s*[:：]?\s*(.+)/i,
      /use\s+(.+?)\s*skill\s*(?:to)?\s*[:：]?\s*(.+)/i,
      /运行\s*(.+?)\s*skill\s*[:：]?\s*(.+)/i,
      /执行\s*(.+?)\s*skill\s*[:：]?\s*(.+)/i,
    ];
    for (const pattern of patterns) {
      const m = message.match(pattern);
      if (m) {
        return { skillName: m[1].trim(), question: m[2].trim() };
      }
    }
    return null;
  }

  /**
   * 真正执行一个技能。
   * @param {string} skillName
   * @param {string} input 喂给技能命令的输入
   * @param {(msg:string)=>void} [onProgress] 进度回调
   * @returns {Promise<{success:boolean, output:string, skillName:string}>}
   */
  async execute(skillName, input, onProgress) {
    const skill = this.skillLoader.get
      ? this.skillLoader.get(skillName)
      : this.skillLoader.skills.get(skillName);
    if (!skill) {
      throw new Error(`Skill not found: ${skillName}`);
    }

    const skillPath = path.dirname(skill.path);
    const skillContent = skill.content;

    const codeBlocks = this._extractCodeBlocks(skillContent);
    const runCommand = this._findRunCommand(codeBlocks, skillPath) ||
      extractExecutionCommand(skillContent, skillPath);

    if (!runCommand) {
      throw new Error(`No execution command found for skill: ${skillName}`);
    }

    const safeInput = String(input == null ? '' : input).replace(/"/g, '\\"');
    const cmd = runCommand.replace(INPUT_PLACEHOLDER, `"${safeInput}"`);
    const fullCmd = `cd "${skillPath}" && ${cmd}`;

    if (onProgress) {
      onProgress(`Executing skill: ${skillName}`);
      onProgress(`Command: ${cmd}`);
    }

    try {
      const { stdout, stderr } = await execAsync(fullCmd, {
        maxBuffer: 10 * 1024 * 1024, // 10MB
        timeout: 120000, // 2 分钟
        windowsHide: true, // 隐藏 Windows 子进程控制台窗口
        encoding: 'buffer', // capture raw bytes; decode with correct code page
      });
      if (stderr && stderr.length) {
        console.warn(`[SkillExecutor] ${skillName} stderr:`, decodeShell(stderr));
      }
      return {
        success: true,
        output: decodeShell(stdout) || '',
        skillName,
      };
    } catch (err) {
      throw new Error(`Skill execution failed: ${err.message}`);
    }
  }

  _extractCodeBlocks(markdown) {
    const blocks = [];
    const regex = /```(\w+)?\r?\n([\s\S]*?)```/g;
    let match;
    while ((match = regex.exec(markdown)) !== null) {
      blocks.push({
        language: match[1] || 'text',
        code: match[2].trim(),
      });
    }
    return blocks;
  }

  _findRunCommand(codeBlocks, skillPath) {
    for (const block of codeBlocks) {
      if (block.language === 'bash' || block.language === 'sh' || block.language === '') {
        const lines = block.code.split(/\r?\n/);
        for (const line of lines) {
          if (line.trim().startsWith('#') || !line.trim()) continue;
          return line.trim();
        }
      }
    }

    if (skillPath) {
      const scriptsDir = path.join(skillPath, 'scripts');
      if (fs.existsSync(scriptsDir)) {
        const files = fs.readdirSync(scriptsDir);
        const mainScript = files.find(f =>
          f.startsWith('run') || f.startsWith('main') || f.endsWith('.py')
        );
        if (mainScript) {
          const isPy = mainScript.endsWith('.py');
          return `${isPy ? 'python3' : 'node'} scripts/${mainScript} $INPUT`;
        }
      }
    }
    return null;
  }
}
