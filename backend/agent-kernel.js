// ============================================================
// Agent Kernel — 移植自 qaimodelbuilder _single_agent_turn.py
//                 (SingleAgentTurnKernel 共享回合内核)
//
// 这是 main agent / 子 agent / 讨论循环共用的「回合迭代骨架」：
//
//   for round_no in 1..max_rounds:
//     ① abort 检查            → 停止
//     ② 回合间压缩 wire        (共享阈值/比例)
//     ③ 构建 SEND wire         (清空 [tool_calls] 哨兵 + 剥离展示用字段)
//     ④ 开一轮 LLM 流          (openRoundStream)
//     ⑤ drain 流并分类帧       (chunk / tool_call / end / error)
//     ⑥ 无工具调用 → 结束回合；有工具调用 →
//        构建 assistant{tool_calls} + 并行执行工具 + 构建 role:tool 块 → 增长 wire
//     ⑦ 达到 max_rounds → 给出上限提示
//
// 内核是一个「中性 KernelEvent 生产者」：调用方的 emitter 把每个事件适配成
// 自己的 wire 形状（main = WebSocket 帧；sub = subagent_* 事件），内核不碰
// SSE 戳记 / 持久化 / 广播等 shell 专属逻辑（与 qaimodelbuilder §15.2 务实边界一致）。
// ============================================================

import { maybeCompressWire, TOOL_CALLS_CONTENT_SENTINEL } from './context-manager.js';

// ── 中性内核事件（调用方 emitter 适配成各自 wire 形状） ──
export const KernelEventKind = {
  ROUND_STARTED: 'round_started',
  CHUNK: 'chunk',
  TOOL_CALL_SEEN: 'tool_call_seen',
  ERROR: 'error',
  TOOL_CALLS_ISSUED: 'tool_calls_issued',
  TOOL_PARTIAL: 'tool_partial',
  TOOL_RESULT: 'tool_result',
  STREAM_PASSTHROUGH: 'stream_passthrough',
  FINISHED: 'finished',
  MAX_ROUNDS_REACHED: 'max_rounds_reached',
  ABORTED: 'aborted',
};

const ev = (kind, extra) => ({ kind, ...extra });

export const KernelRoundStarted = (roundNo) => ev(KernelEventKind.ROUND_STARTED, { roundNo });
export const KernelChunk = (roundNo, text) => ev(KernelEventKind.CHUNK, { roundNo, text });
export const KernelToolCallSeen = (roundNo, frame) => ev(KernelEventKind.TOOL_CALL_SEEN, { roundNo, frame });
export const KernelError = (roundNo, message, frame = null) => ev(KernelEventKind.ERROR, { roundNo, message, frame });
export const KernelToolCallsIssued = (roundNo, toolMetas, assistantText, thoughtSignatures = {}) =>
  ev(KernelEventKind.TOOL_CALLS_ISSUED, { roundNo, toolMetas, assistantText, thoughtSignatures });
export const KernelToolPartial = (roundNo, toolName, callId, delta, frame = null) =>
  ev(KernelEventKind.TOOL_PARTIAL, { roundNo, toolName, callId, delta, frame });
export const KernelToolResult = (
  roundNo,
  { toolName, callId, arguments: args = {}, resultText = '', ok = true, truncated = false, originalLength = null, durationMs = 0, frame = null, cancelled = false }
) => ev(KernelEventKind.TOOL_RESULT, { roundNo, toolName, callId, arguments: args, resultText, ok, truncated, originalLength, durationMs, frame, cancelled });
export const KernelStreamPassthrough = (roundNo, frame) => ev(KernelEventKind.STREAM_PASSTHROUGH, { roundNo, frame });
export const KernelFinished = (roundNo, finalText, endPayload = {}) => ev(KernelEventKind.FINISHED, { roundNo, finalText, endPayload });
export const KernelMaxRoundsReached = (roundNo, maxRounds, lastText) => ev(KernelEventKind.MAX_ROUNDS_REACHED, { roundNo, maxRounds, lastText });
export const KernelAborted = (roundNo) => ev(KernelEventKind.ABORTED, { roundNo });

// ── SEND wire 构建（两个循环共用）：清空哨兵 + 剥离展示用字段，不修改原 wire ──
const _DISPLAY_ONLY = ['created_at', 'request_id', 'usage', 'duration_ms'];

export function buildSendWire(wireMessages) {
  const send = [];
  for (const m of wireMessages) {
    if (!m || typeof m !== 'object') {
      send.push(m);
      continue;
    }
    const needsCopy =
      m.content === TOOL_CALLS_CONTENT_SENTINEL || _DISPLAY_ONLY.some((k) => k in m);
    if (needsCopy) {
      const clean = {};
      for (const [k, v] of Object.entries(m)) {
        if (_DISPLAY_ONLY.includes(k)) continue;
        clean[k] = v;
      }
      if (clean.content === TOOL_CALLS_CONTENT_SENTINEL) clean.content = '';
      send.push(clean);
    } else {
      send.push(m);
    }
  }
  return send;
}

// ── wire 块构造（与 OpenAI tool_calling 协议对齐） ──
export function buildAssistantToolCallsBlock(toolMetas, { thoughtSignatures = null } = {}) {
  return toolMetas.map(([name, args, callId]) => ({
    id: callId,
    type: 'function',
    function: {
      name,
      arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}),
    },
    ...(thoughtSignatures && thoughtSignatures[callId] ? { thought_signature: thoughtSignatures[callId] } : {}),
  }));
}

export function buildToolReplyBlocks(toolMetas, results, { includeName = false, durationsMs = null } = {}) {
  return toolMetas.map(([name, , callId], i) => {
    let content = results[i] != null ? String(results[i]) : '';
    if (includeName && content) content = `[${name}]\n${content}`;
    const block = { role: 'tool', tool_call_id: callId, content };
    if (durationsMs && durationsMs[i] != null) block.duration_ms = durationsMs[i];
    return block;
  });
}

export class SingleAgentTurnKernel {
  constructor({ compressor = null, truncator = null, compressThresholdRatio = 0.8 } = {}) {
    this._compressor = compressor;
    this._truncator = truncator;
    this._compressThresholdRatio = Math.min(Math.max(compressThresholdRatio, 0.1), 1.0);
  }

  /**
   * 驱动 agentic 回合循环，原地增长 wire_messages，产出中性 KernelEvent。
   *
   * @param {object} params
   *   wireMessages      - 调用方播种的 OpenAI wire 历史（system + user [+ 历史]）
   *   openRoundStream    - (roundNo, sendWire) => AsyncIterator<Frame>
   *                        Frame: {type:'chunk',text} | {type:'tool_call',id,name,arguments}
   *                              | {type:'end',payload?} | {type:'error',message} | 其他(透传)
   *   toolExecutor       - (roundNo, toolMetas) => AsyncIterator<ToolExecutionItem>
   *                        ToolExecutionItem: {partial,callId,toolName,delta,resultText,ok,truncated,originalLength,durationMs,cancelled}
   *   buildToolMetas     - (rawToolCalls, roundNo) => [[name, args, callId], ...]
   *   maxRounds          - 回合预算
   *   abortCheck?        - () => boolean
   *   modelHint?         - 模型标识（用于压缩预算）
   *   includeToolNameInReply? - 工具结果是否带工具名前缀
   *   growWireHook?      - (roundNo, assistantText, toolMetas, finals) => Promise<void>  调用方自管 wire 增长
   *   onRoundEnd?        - (roundNo, endPayload, roundText, toolCalls) => Promise<{retry,retryWire,stop,finalText}>
   *   onRoundOpen?       - (roundNo, sendWire) => Promise<void>
   *   onToolRoundComplete? - (roundNo) => Promise<void>
   *   forwardToolCallsInline? - 是否逐帧转发 TOOL_CALL（main loop 用）
   */
  async *run({
    wireMessages,
    openRoundStream,
    toolExecutor,
    buildToolMetas,
    maxRounds,
    abortCheck = null,
    modelHint = null,
    includeToolNameInReply = false,
    growWireHook = null,
    onRoundEnd = null,
    onRoundOpen = null,
    onToolRoundComplete = null,
    forwardToolCallsInline = false,
    assistantTimestamp = null,
    startRound = 1,
    tokenBudget = null,
  }) {
    for (let roundNo = startRound; roundNo < startRound + maxRounds; roundNo++) {
      // ① abort 检查
      if (abortCheck && abortCheck()) {
        yield KernelAborted(roundNo);
        return;
      }

      // ② 回合间上下文压缩（或 compact_hook 覆盖）
      const rebuilt = await maybeCompressWire(wireMessages, {
        modelHint,
        thresholdRatio: this._compressThresholdRatio,
        ...(tokenBudget ? { tokenBudget } : {}),
      });
      if (rebuilt !== wireMessages) {
        wireMessages.length = 0;
        wireMessages.push(...rebuilt);
      }

      yield KernelRoundStarted(roundNo);

      // ③ 构建真正发给模型的 wire
      const sendWire = buildSendWire(wireMessages);

      if (onRoundOpen) await onRoundOpen(roundNo, sendWire);

      // ④ 开一轮 LLM 流 + ⑤ drain 分类
      const drain = { textParts: [], toolCalls: [], errorSeen: false, aborted: false, endPayload: {}, ended: false };
      const stream = openRoundStream(roundNo, sendWire);
      for await (const frame of stream) {
        if (abortCheck && abortCheck()) {
          drain.aborted = true;
          break;
        }
        if (!frame || typeof frame !== 'object') continue;
        if (frame.type === 'chunk') {
          const text = frame.text || '';
          if (text) {
            drain.textParts.push(text);
            yield KernelChunk(roundNo, text);
          }
        } else if (frame.type === 'tool_call') {
          drain.toolCalls.push(frame);
          if (forwardToolCallsInline) yield KernelToolCallSeen(roundNo, frame);
        } else if (frame.type === 'error') {
          drain.errorSeen = true;
          yield KernelError(roundNo, frame.message || 'unknown error', frame);
          break;
        } else if (frame.type === 'end') {
          if (frame.payload && typeof frame.payload === 'object') drain.endPayload = frame.payload;
          drain.ended = true;
          break;
        } else {
          // 其他帧（如 reasoning / network_retry 进度帧）透传，不影响控制流
          yield KernelStreamPassthrough(roundNo, frame);
        }
      }

      if (drain.aborted) {
        yield KernelAborted(roundNo);
        return;
      }
      if (drain.errorSeen) {
        return;
      }
      const roundText = drain.textParts.join('').trim();

      // ⑥a 无工具调用 → 结束回合
      if (drain.toolCalls.length === 0) {
        if (growWireHook == null && roundText) {
          const msg = { role: 'assistant', content: roundText };
          if (assistantTimestamp) msg.created_at = assistantTimestamp();
          wireMessages.push(msg);
        }
        yield KernelFinished(roundNo, roundText, drain.endPayload);
        return;
      }

      // ⑥b 有工具调用
      const toolMetas = buildToolMetas(drain.toolCalls, roundNo);

      if (growWireHook == null) {
        const assistantMsg = {
          role: 'assistant',
          content: roundText || TOOL_CALLS_CONTENT_SENTINEL,
          tool_calls: buildAssistantToolCallsBlock(toolMetas),
        };
        if (assistantTimestamp) assistantMsg.created_at = assistantTimestamp();
        wireMessages.push(assistantMsg);
      }

      yield KernelToolCallsIssued(roundNo, toolMetas, roundText);

      const finals = [];
      for await (const item of toolExecutor(roundNo, toolMetas)) {
        if (item.partial) {
          yield KernelToolPartial(roundNo, item.toolName, item.callId, item.delta, item.frame);
          continue;
        }
        finals.push(item);
        yield KernelToolResult(roundNo, item);
      }

      if (growWireHook) {
        await growWireHook(roundNo, roundText, toolMetas, finals);
      } else {
        const orderedResults = toolMetas.map(([, , cid]) => {
          const f = finals.find((x) => x.callId === cid);
          return f ? f.resultText : '';
        });
        const orderedDurations = toolMetas.map(([, , cid]) => {
          const f = finals.find((x) => x.callId === cid);
          return f ? f.durationMs : null;
        });
        wireMessages.push(
          ...buildToolReplyBlocks(toolMetas, orderedResults, {
            includeName: includeToolNameInReply,
            durationsMs: orderedDurations,
          })
        );
      }

      if (onToolRoundComplete) await onToolRoundComplete(roundNo);

      // ⑦ 回合预算耗尽且仍有工具调用
      if (roundNo === maxRounds) {
        yield KernelMaxRoundsReached(roundNo, maxRounds, roundText);
        return;
      }
    }
  }
}

export default SingleAgentTurnKernel;
