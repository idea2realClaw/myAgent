// guardrail.js — 护栏控制器（移植自 qai-appbuilder 的 guardrail 设计）
// 在每轮工具执行前(preCheck)与执行后(record)检测三类异常重试模式，
// 返回 ALLOW / WARN / BLOCK，防止 Agent 陷入"同参重复 / 连续失败 / 幂等同结果"的死循环。
//
// 阈值（与 qai 默认语义一致）：
//   EXACT_REPEAT_WARN=2  → 相同 (tool,args) 连续出现 ≥2 次 → WARN
//   EXACT_REPEAT_BLOCK=5 → ≥5 次 → BLOCK
//   FAILURE_WARN=3       → 同工具连续失败 ≥3 次 → WARN
//   FAILURE_BLOCK=8      → ≥8 次 → BLOCK
//   IDEMPOTENT_SAME_RESULT=2 → 幂等工具(读类)返回结果未变化 ≥2 次 → WARN

const EXACT_REPEAT_WARN = 2;
const EXACT_REPEAT_BLOCK = 5;
const FAILURE_WARN = 3;
const FAILURE_BLOCK = 8;
const IDEMPOTENT_SAME_RESULT = 2;
const MAX_TAIL = 24;

// 读类 / 幂等工具：重复调用通常只会产生相同结果，应被护栏视为"无效重试"
const IDEMPOTENT_TOOLS = new Set([
  'read', 'read_file', 'file_read', 'view', 'cat', 'less',
  'glob', 'ls', 'list_files', 'list_dir', 'dir',
  'grep', 'search_content', 'search_file', 'rg', 'find',
]);

function hashStr(s) {
  let h = 5381;
  s = String(s == null ? '' : s);
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16);
}

export class GuardrailController {
  constructor() {
    this.tail = []; // {toolName, argsHash, resultHash, ok}
  }

  reset() {
    this.tail = [];
  }

  _push(rec) {
    this.tail.push(rec);
    if (this.tail.length > MAX_TAIL) this.tail.shift();
  }

  // 工具执行后记录结果，更新尾部状态
  record(toolName, args, ok, resultText) {
    const argsHash = hashStr(`${toolName}:${JSON.stringify(args == null ? {} : args)}`);
    const resultHash = hashStr(String(resultText == null ? '' : resultText));
    this._push({ toolName, argsHash, resultHash, ok: ok !== false });
  }

  // 工具执行前检查；返回 {decision:'ALLOW'|'WARN'|'BLOCK', reason}
  preCheck(toolName, args) {
    const argsHash = hashStr(`${toolName}:${JSON.stringify(args == null ? {} : args)}`);

    // 1) 相同参数连续重复
    let exact = 0;
    for (let i = this.tail.length - 1; i >= 0; i--) {
      const t = this.tail[i];
      if (t.toolName === toolName && t.argsHash === argsHash) exact++;
      else break;
    }
    if (exact >= EXACT_REPEAT_BLOCK)
      return { decision: 'BLOCK', reason: `工具 ${toolName} 以相同参数已连续调用 ${exact} 次` };
    if (exact >= EXACT_REPEAT_WARN)
      return { decision: 'WARN', reason: `工具 ${toolName} 以相同参数已连续调用 ${exact} 次` };

    // 2) 同一工具连续失败
    let fail = 0;
    for (let i = this.tail.length - 1; i >= 0; i--) {
      const t = this.tail[i];
      if (t.toolName === toolName && t.ok === false) fail++;
      else break;
    }
    if (fail >= FAILURE_BLOCK)
      return { decision: 'BLOCK', reason: `工具 ${toolName} 已连续失败 ${fail} 次` };
    if (fail >= FAILURE_WARN)
      return { decision: 'WARN', reason: `工具 ${toolName} 已连续失败 ${fail} 次` };

    // 3) 幂等工具返回结果未变化
    if (IDEMPOTENT_TOOLS.has(toolName)) {
      let same = 0;
      for (let i = this.tail.length - 1; i >= 1; i--) {
        const t = this.tail[i];
        const p = this.tail[i - 1];
        if (
          t.toolName === toolName && p.toolName === toolName &&
          t.argsHash === argsHash && t.resultHash && t.resultHash === p.resultHash
        ) same++;
        else break;
      }
      if (same >= IDEMPOTENT_SAME_RESULT)
        return { decision: 'WARN', reason: `工具 ${toolName} 返回结果未变化（已读同样内容 ${same + 1} 次）` };
    }

    return { decision: 'ALLOW', reason: '' };
  }
}

export default GuardrailController;
