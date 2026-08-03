// ============================================================
// Discussion Manager — 移植自 qaimodelbuilder discussion_mode.py
//                       + orchestrate_discussion.py（讨论编排内核）
//
// 这是一个「多 Agent 讨论编排器」：给定一支 roster（谁参与）和一个 mode
// （怎么协作），围绕一个 topic 驱动多名角色轮流发言，最后可选地做综合收敛。
//
// 设计取舍（与 qaimodelbuilder 对齐但务实简化）：
//   • 复用 session 的 LLMAdapter.stream 做逐轮流式发言（与 runAgentLoop 同款）。
//   • 讨论回合为"纯文本发言"（不执行工具）——讨论/评审/辩论天然是话语；
//     实施模式把 tool_policy 默认设为 deny 作为状态真值（State-Truth-First），
//     V1 不在讨论路径执行工具，避免误导。
//   • speaker_strategy:
//       - round_robin：每轮按固定顺序，所有成员各发一次言；
//       - manager：每轮由"主持人"用一次轻量 LLM 调用决定本轮发言顺序
//         （失败则回退 round_robin），近似 qaimodelbuilder 的发言人选择。
//   • 收敛（judge_enabled）：全部轮次结束后，由"主持人"读取完整发言记录，
//     产出共识/分歧/开放问题/建议结论。
//   • 通过 broadcast(data) 把结构化帧推给前端；同一 session 的所有客户端
//     收到同一帧（session 级广播，对应 qaimodelbuilder 的 channel 广播）。
// ============================================================

import { v4 as uuidv4 } from 'uuid';

// ── 工具广告交集（§26.5）：role_tools ∩ mode_policy ∩ global_policy ──
// 讨论 V1 不执行工具，此函数保留以支撑未来"讨论内工具"与前端展示。
export function effectiveAdvertisedTools({ roleTools = [], mode = null, globalExcluded = new Set() }) {
  const allowed = (roleTools || []).filter((t) => !globalExcluded.has(t));
  if (!mode || !mode.tool_policy) return allowed;
  const { default: def = 'allow', tools = {} } = mode.tool_policy;
  return allowed.filter((t) => (tools[t] ?? def) === 'allow');
}

function buildSpeakerSystemPrompt(speaker, roster, mode, topic) {
  const others = roster.filter((m) => m !== speaker).map((m) => m.display_name);
  const parts = [];
  parts.push(
    `You are "${speaker.display_name}" participating in a multi-agent ${mode.name || 'discussion'} ` +
      `with: ${others.length ? others.join(', ') : 'no other participants'}.`
  );
  if (speaker.persona) parts.push(`## Your role\n${speaker.persona}`);
  if (mode.framing && mode.framing.trim()) {
    parts.push(`## How the group should collaborate\n${mode.framing.trim()}`);
  }
  // 会议发言软约束（§26.8，仅作提示，不截断流）
  const hc = mode.hard_constraints || {};
  const constraints = [];
  if (hc.max_chars_per_turn) {
    constraints.push(
      `单次发言不超过 ${hc.max_chars_per_turn} 个字（中文按字符数计，英文按以空白分词的单词数计；中英混合按各自规则相加）`
    );
  }
  if (hc.max_seconds_per_turn) constraints.push(`每轮发言不超过 ${hc.max_seconds_per_turn} 秒`);
  if (constraints.length) parts.push(`本场会议有发言约束：${constraints.join('；')}。请遵守。`);
  parts.push(
    `Stay in character as "${speaker.display_name}". Speak ONLY for yourself — never write on behalf of other participants. ` +
      `Be concise and substantive. Respond to the topic and to what others have said where relevant.`
  );
  return parts.join('\n\n');
}

function formatTranscript(transcript) {
  if (!transcript.length) return '(讨论尚未开始，还没有任何发言记录。)';
  return transcript.map((t) => `【${t.speaker}】\n${t.text}`).join('\n\n');
}

function buildTurnUserMessage(topic, transcript, round, maxRounds, speakerName) {
  return (
    `=== 讨论主题 ===\n${topic}\n\n` +
    `=== 当前发言记录 ===\n${formatTranscript(transcript)}\n\n` +
    `现在是你的回合（第 ${round}/${maxRounds} 轮），你是「${speakerName}」。\n` +
    `请基于主题与已有发言，给出你作为「${speakerName}」的见解、补充或回应。` +
    `直接输出你的发言内容，不要添加开场白或署名。`
  );
}

// 经理策略：每轮用一次轻量 LLM 调用确定本轮发言顺序（索引数组），失败回退 null
async function selectSpeakingOrder(llm, roster, topic, transcript) {
  try {
    const names = roster.map((m, i) => `${i}: ${m.display_name}`).join(', ');
    const prompt =
      `You are the discussion moderator. Given the topic and the transcript so far, decide the best ` +
      `speaking order for the NEXT round. Return ONLY a JSON array of participant indices (0-based) ` +
      `in the order they should speak this round — each index exactly once.\n` +
      `Participants: ${names}\nTopic: ${topic}\nExisting turns: ${transcript.length}\n` +
      `Example response: [2, 0, 1]`;
    const wire = [
      { role: 'system', content: 'You are a strict moderator. Respond with a JSON array of integers only, no prose, no markdown.' },
      { role: 'user', content: prompt },
    ];
    let raw = '';
    for await (const chunk of llm.stream(wire, { temperature: 0.3 })) {
      if (chunk && chunk.type === 'text' && chunk.content) raw += chunk.content;
    }
    const cleaned = raw.replace(/```json|```/g, '').trim();
    const arr = JSON.parse(cleaned);
    if (Array.isArray(arr)) {
      const valid = arr.filter((n) => Number.isInteger(n) && n >= 0 && n < roster.length);
      if (valid.length === new Set(valid).size && valid.length > 0) return valid;
    }
  } catch {
    // 回退到 round_robin
  }
  return null;
}

/**
 * 运行一次多 Agent 讨论。
 *
 * @param {object} params
 *   ws          - 当前会话 WebSocket（仅用于 readyState 检查，实际发送走 broadcast）
 *   session     - 会话对象，需含 stopRequested / id
 *   llm         - LLMAdapter 实例（提供 .stream(wire, opts)）
 *   topic       - 讨论主题
 *   roster      - [{ display_name, model_id, persona, config:{allowed_tools,enabled_skills,color} }]
 *   mode        - { name, framing, tool_policy, flow_policy, hard_constraints }
 *   config      - 运行配置（可选，目前仅透传 max_rounds 覆盖）
 *   broadcast   - (data:object) => void  把结构化帧推给客户端
 */

// ── 收敛检测（移植自 qai-appbuilder 的 convergence controller 思想）────────────
// 多 Agent 讨论若已达成一致或陷入重复，应提前结束，避免无限辩论、浪费调用。
// 触发条件：① 近几轮发言两两高度相似（Jaccard ≥ 0.62）；② 出现"同意/一致/达成共识"等信号。
// 为避免过早收敛，仅在第 2 轮之后才允许提前终止。
function normalizeText(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}
function _tokens(s) {
  return new Set(normalizeText(s).split(/[\s,，。、;；.]+/).filter((w) => w.length > 1));
}
function _jaccard(a, b) {
  const A = _tokens(a);
  const B = _tokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}
export function detectConvergence(transcript, round, maxRounds) {
  if (round < 2 || (maxRounds && maxRounds <= 2)) return { converged: false };
  const recent = (transcript || []).slice(-4);
  if (recent.length < 3) return { converged: false };

  const sims = [];
  for (let i = 1; i < recent.length; i++) sims.push(_jaccard(recent[i].text, recent[i - 1].text));
  const avgSim = sims.reduce((a, b) => a + b, 0) / sims.length;
  if (avgSim >= 0.62)
    return { converged: true, reason: `近 ${recent.length} 轮发言高度重复（平均相似度 ${avgSim.toFixed(2)}），判定已收敛` };

  const joined = recent.map((r) => r.text).join(' ');
  if (/(同意|一致|达成共识|没异议|无新意见|不再有新的|concur|agree|consensus|no new)/i.test(joined))
    return { converged: true, reason: '检测到一致/同意信号' };

  return { converged: false };
}

export async function runDiscussion({ ws, session, llm, topic, roster, mode, config = {}, broadcast }) {
  const send = (data) => {
    try {
      broadcast(data);
    } catch (err) {
      console.error('[Discussion] broadcast error:', err.message);
    }
  };
  const stop = () => !!(session && session.stopRequested);

  if (!Array.isArray(roster) || roster.length === 0) {
    send({ type: 'error', message: 'discussion requires at least one participant' });
    return;
  }
  if (!topic || !topic.trim()) {
    send({ type: 'error', message: 'discussion requires a topic' });
    return;
  }

  const flow = (mode && mode.flow_policy) || {};
  const maxRounds = Math.min(Math.max(parseInt(flow.max_rounds || config.max_rounds || 8, 10) || 8, 1), 50);
  const strategy = flow.speaker_strategy === 'manager' ? 'manager' : 'round_robin';
  const judgeEnabled = flow.judge_enabled !== false;
  const discussionId = uuidv4();

  const rosterWire = roster.map((m, i) => ({
    index: i,
    name: m.display_name || `Speaker ${i + 1}`,
    color: m.config && m.config.color != null ? m.config.color : i,
  }));

  send({
    type: 'discussion_start',
    discussionId,
    topic,
    roster: rosterWire,
    mode: { name: mode.name || 'discussion', speaker_strategy: strategy, max_rounds: maxRounds, judge_enabled: judgeEnabled },
    maxRounds,
  });

  const transcript = []; // { speaker, text, index, round }
  const baseOrder = roster.map((_, i) => i);

  for (let round = 1; round <= maxRounds; round++) {
    if (stop()) {
      send({ type: 'discussion_stopped', round, discussionId });
      break;
    }
    send({ type: 'discussion_round_start', round, totalRounds: maxRounds, discussionId });

    let order = baseOrder;
    if (strategy === 'manager') {
      const selected = await selectSpeakingOrder(llm, roster, topic, transcript);
      if (selected && selected.length) order = selected;
    }

    for (const idx of order) {
      if (stop()) break;
      const speaker = roster[idx];
      const speakerName = speaker.display_name || `Speaker ${idx + 1}`;
      const turnId = uuidv4();
      send({
        type: 'discussion_speaker_start',
        round,
        turnId,
        discussionId,
        speaker: { index: idx, name: speakerName, color: speaker.config && speaker.config.color != null ? speaker.config.color : idx },
      });

      const system = buildSpeakerSystemPrompt(speaker, roster, mode, topic);
      const userMsg = buildTurnUserMessage(topic, transcript, round, maxRounds, speakerName);
      const wire = [
        { role: 'system', content: system },
        { role: 'user', content: userMsg },
      ];

      let text = '';
      try {
        for await (const chunk of llm.stream(wire, { temperature: 0.8 })) {
          if (stop()) break;
          if (chunk && chunk.type === 'text' && chunk.content) {
            text += chunk.content;
            send({ type: 'discussion_chunk', turnId, discussionId, round, speakerIndex: idx, content: chunk.content });
          }
        }
      } catch (e) {
        send({ type: 'error', message: `Speaker ${speakerName} failed: ${e.message}` });
      }

      text = text.trim();
      send({ type: 'discussion_speaker_end', turnId, discussionId, round, speakerIndex: idx, content: text });
      if (text) transcript.push({ speaker: speakerName, text, index: idx, round });
    }

    // ── 收敛检测：达成收敛则提前结束，避免无限辩论 ──
    const conv = detectConvergence(transcript, round, maxRounds);
    if (conv.converged) {
      console.log(`[Discussion] 第 ${round} 轮检测到收敛，提前结束：${conv.reason}`);
      send({ type: 'discussion_convergence_early', round, discussionId, reason: conv.reason });
      break;
    }

    if (stop()) {
      send({ type: 'discussion_stopped', round, discussionId });
      break;
    }
  }

  // ── 收敛 / 综合（judge）──
  let summary = '';
  if (judgeEnabled && !stop() && transcript.length > 0) {
    send({ type: 'discussion_convergence_start', discussionId });
    const turnId = uuidv4();
    const convSpeaker = { index: -1, name: '🧭 主持人 / 综合', color: null };
    send({ type: 'discussion_speaker_start', round: maxRounds + 1, turnId, discussionId, speaker: convSpeaker, convergence: true });
    const system =
      'You are the moderator of a multi-agent discussion. Read the full transcript and produce a concise synthesis: ' +
      '(1) points of agreement, (2) major disagreements, (3) open questions, (4) a recommended conclusion or next step. ' +
      'Write in the same language the discussion used.';
    const userMsg =
      `=== 讨论主题 ===\n${topic}\n\n` +
      `=== 完整发言记录 ===\n${formatTranscript(transcript)}\n\n` +
      `请综合上述发言，给出总结（共识、分歧、开放问题、建议结论 / 下一步）。`;
    const wire = [
      { role: 'system', content: system },
      { role: 'user', content: userMsg },
    ];
    try {
      for await (const chunk of llm.stream(wire, { temperature: 0.5 })) {
        if (chunk && chunk.type === 'text' && chunk.content) {
          summary += chunk.content;
          send({ type: 'discussion_chunk', turnId, discussionId, round: maxRounds + 1, speakerIndex: -1, content: chunk.content, convergence: true });
        }
      }
    } catch (e) {
      send({ type: 'error', message: `Convergence failed: ${e.message}` });
    }
    summary = summary.trim();
    send({ type: 'discussion_speaker_end', turnId, discussionId, round: maxRounds + 1, speakerIndex: -1, content: summary, convergence: true });
  }

  send({
    type: 'discussion_done',
    discussionId,
    topic,
    transcript,
    summary,
    roster: rosterWire,
    mode: { name: mode.name || 'discussion', speaker_strategy: strategy, judge_enabled: judgeEnabled },
  });
}

export default runDiscussion;
