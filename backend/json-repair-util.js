// ============================================================
// JSON 容错解析工具
// 用于 LLM 流式返回 / 模型生成的、可能残损的工具参数 JSON。
// 目标：尽量还原成对象，最坏返回 {}，绝不抛错（避免工具参数退化成空对象导致工具失效）。
// ============================================================

// 对未闭合的 JSON 做括号/引号平衡（主要修复流式截断导致的残损）
function balanceJson(s) {
  const stack = []; // 待闭合的 '}' / ']'
  let inStr = false;
  let escaped = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (escaped) { escaped = false; continue; }
    if (c === '\\') { escaped = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{' || c === '[') stack.push(c === '{' ? '}' : ']');
    else if (c === '}' || c === ']') {
      if (stack.length && stack[stack.length - 1] === c) stack.pop();
    }
  }
  let out = s;
  if (inStr) out += '"'; // 闭合未结束的字符串
  while (stack.length) out += stack.pop(); // 闭合未结束的容器
  return out;
}

export function repairJsonArgs(raw) {
  if (raw == null) return {};
  let s = typeof raw === 'string' ? raw.trim() : raw;
  if (typeof s !== 'string') return s && typeof s === 'object' ? s : {};
  if (s === '') return {};

  const tryParse = (str) => {
    try {
      const v = JSON.parse(str);
      return v;
    } catch {
      return null;
    }
  };

  // 1) 直接解析（最快路径，覆盖绝大多数正常情况）
  let r = tryParse(s);
  if (r !== null) return r;

  // 2) 去代码围栏 ```json ... ```
  const fenced = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  if (fenced !== s) {
    r = tryParse(fenced);
    if (r !== null) return r;
    s = fenced;
  }

  // 3) 去掉尾随逗号（{"a": 1, } -> {"a": 1}）
  const noTrailing = s.replace(/,(\s*[}\]])/g, '$1');
  r = tryParse(noTrailing);
  if (r !== null) return r;

  // 4) 平衡括号/引号后重试（主要修复流式截断：{"query": "beij）
  r = tryParse(balanceJson(noTrailing));
  if (r !== null) return r;

  // 5) 丢弃悬空属性（键后无值被截断：{"a":1, "n": -> 截到上个逗号再平衡）
  const lastComma = noTrailing.lastIndexOf(',');
  if (lastComma > 0) {
    r = tryParse(balanceJson(noTrailing.slice(0, lastComma)));
    if (r !== null) return r;
  }

  // 6) 兜底：退化为空对象
  return {};
}
