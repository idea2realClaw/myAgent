// ============================================================
// Task Decomposer & Parallel Executor
// 结构化任务分解：每个子任务必须是一个可执行的工具调用
// 确保每一步都有结果
// ============================================================

import { executeTool, buildToolInstructions, TOOL_SCHEMAS_OPENAI, KNOWN_TOOLS } from './tool-executor.js';

// 可在分解计划中使用的"工具"白名单
// 包含真实工具 + 一个特殊的 llm_reason（用于需要 LLM 推理/综合的步骤）
const PLANNABLE_TOOLS = new Set([...KNOWN_TOOLS, 'llm_reason']);

export class TaskOrchestrator {
  constructor(llmAdapter, onProgress, shouldStop, { permissionManager, snapshotManager } = {}) {
    this.llm = llmAdapter;
    this.onProgress = onProgress || (() => {});
    this.shouldStop = shouldStop || (() => false);
    this.permissionManager = permissionManager || null;
    this.snapshotManager = snapshotManager || null;
    this.useNativeFunctionCalling = llmAdapter.supportsFunctionCalling?.() || false;
  }

  /**
   * Decompose a user request into structured, executable subtasks.
   * Uses pyramid analysis: first understand the question, then break down.
   * Each subtask has a clear purpose and uses a concrete tool.
   * Returns: { title, subtasks: [{ id, title, purpose, tool, args, depends_on }] }
   */
  async decompose(userRequest, systemContext) {
    // Simple decomposition: create a single llm_reason task
    return {
      title: userRequest.slice(0, 60),
      subtasks: [{
        id: "task-1",
        title: "Answer user question",
        tool: "llm_reason",
        args: { prompt: userRequest },
        depends_on: [],
      }],
    };
  }


  /**
   * Execute a single structured subtask.
   * The subtask specifies a tool and args — we execute it directly.
   * For llm_reason tool, we call the LLM with the prompt + dependency results.
   * For other tools, we call executeTool() directly.
   * Guarantees a result for every step.
   */
  async executeSubtask(subtask, context, onChunk) {
    const { id, title, tool, args, depends_on } = subtask;

    this.onProgress({ type: 'subtask_panel', taskId: id, title, instruction: `${tool}(${JSON.stringify(args).slice(0, 200)})` });
    this.onProgress({ type: 'subtask_start', taskId: id, title });

    // Build dependency context (results from previous steps)
    const depResults = (context.history || '')
      .split(/\n\n(?=\[)/)
      .filter(s => s.trim())
      .join('\n\n');
    const depContext = depResults ? `\n\n## Previous step results:\n${depResults}` : '';

    let result = '';
    let success = true;

    try {
      if (this.shouldStop()) {
        return { id, title, result: 'Task stopped by user', status: 'stopped' };
      }

      if (tool === 'llm_reason') {
        // LLM reasoning step: stream output, accumulate as result
        this.onProgress({ type: 'subtask_thinking', taskId: id, loop: 1 });
        const prompt = args.prompt || args.description || title;
        const messages = [
          { role: 'system', content: context.system || 'You are a helpful assistant.' },
          { role: 'user', content: `${prompt}${depContext}` },
        ];

        for await (const chunk of this.llm.stream(messages, { temperature: 0.7 })) {
          if (typeof chunk === 'string') {
            result += chunk;
            if (onChunk) onChunk(id, chunk);
            this.onProgress({ type: 'subtask_chunk', taskId: id, chunk });
          } else if (chunk.type === 'text') {
            result += chunk.content;
            if (onChunk) onChunk(id, chunk.content);
            this.onProgress({ type: 'subtask_chunk', taskId: id, chunk: chunk.content });
          }
        }
      } else {
        // Concrete tool execution
        this.onProgress({ type: 'tool_call', taskId: id, tool, args });

        // Permission check (if permissionManager is available)
        if (this.permissionManager) {
          const approval = this.permissionManager.checkRequiresApproval(tool, args || {});
          if (approval.required) {
            this.onProgress({ type: 'approval_request', taskId: id, reason: approval.reason, tool, args });
            // Wait for user approval (via WebSocket)
            const approved = await new Promise((resolve) => {
              const timeout = setTimeout(() => resolve(false), 60000);
              // This will be resolved by server.js when user responds
              this._pendingApprovals = this._pendingApprovals || new Map();
              this._pendingApprovals.set(id, { resolve, timeout });
            });
            if (!approved) {
              result = `Operation denied by user: ${approval.reason}`;
              success = false;
              this.onProgress({ type: 'tool_result', taskId: id, success: false, output: result });
              this.onProgress({ type: 'subtask_done', taskId: id, result });
              return { id, title, result, status: 'denied' };
            }
          }
        }

        // Snapshot before file modification (if snapshotManager is available)
        let snapshotId = null;
        if (this.snapshotManager && (tool === 'file_write' || tool === 'file_edit')) {
          snapshotId = await this.snapshotManager.snapshotBefore(args.path || args.filePath || 'unknown').catch(() => null);
        }

        const toolResult = await executeTool({ name: tool, arguments: args || {} });

        // Snapshot after file modification
        if (snapshotId && this.snapshotManager) {
          await this.snapshotManager.snapshotAfter(snapshotId).catch(() => {});
        }

        this.onProgress({
          type: 'tool_result',
          taskId: id,
          success: toolResult.success,
          output: toolResult.output.slice(0, 2000),
        });

        result = toolResult.output;
        success = toolResult.success;
      }
    } catch (err) {
      result = `Error executing ${tool}: ${err.message}`;
      success = false;
      this.onProgress({
        type: 'tool_result',
        taskId: id,
        success: false,
        output: result,
      });
    }

    this.onProgress({ type: 'subtask_done', taskId: id, result });
    return { id, title, result, status: success ? 'done' : 'error' };
  }

  /**
   * Run all subtasks respecting dependencies.
   * Each subtask is a direct tool call (no LLM-driven tool loop).
   */
  async executeAll(plan, context, onChunk) {
    const results = new Map();
    const pending = new Map(plan.subtasks.map(t => [t.id, t]));
    const running = new Set();

    const isReady = (task) =>
      (task.depends_on || []).every(dep => results.has(dep) && results.get(dep).status === 'done');

    while (pending.size > 0 || running.size > 0) {
      // Launch all ready tasks
      for (const [id, task] of pending) {
        if (isReady(task) && !running.has(id)) {
          running.add(id);
          pending.delete(id);

          // Build context with dependency results
          const depResults = (task.depends_on || [])
            .map(dep => results.get(dep))
            .filter(Boolean)
            .map(r => `[${r.title}]\n${r.result}`)
            .join('\n\n');

          const taskContext = {
            ...context,
            history: depResults || null,
          };

          this.executeSubtask(task, taskContext, onChunk).then(result => {
            results.set(id, result);
            running.delete(id);
          });
        }
      }

      if (running.size > 0) {
        await new Promise(r => setTimeout(r, 100));
      } else if (pending.size > 0) {
        // Stuck with pending but no running — dependency deadlock
        for (const [id, task] of pending) {
          results.set(id, { id, title: task.title, result: 'Skipped (dependency error)', status: 'skipped' });
        }
        break;
      }
    }

    return Array.from(results.values());
  }

  /**
   * Synthesize final answer from all subtask results.
   * If there's only one result, return it directly.
   */
  async synthesize(originalRequest, subtaskResults, context) {
    if (subtaskResults.length === 1) {
      return subtaskResults[0].result;
    }

    const resultsSummary = subtaskResults
      .map(r => `## ${r.title}\n${r.result}`)
      .join('\n\n---\n\n');

    const messages = [
      { role: 'system', content: context.system },
      {
        role: 'user',
        content: `Original request: "${originalRequest}"\n\nHere are the results from ${subtaskResults.length} subtasks:\n\n${resultsSummary}\n\nSynthesize these results into a clear, comprehensive final answer. Present it in a well-organized, readable format.`,
      },
    ];

    let synthesis = '';
    this.onProgress({ type: 'synthesis_start' });

    for await (const chunk of this.llm.stream(messages, { temperature: 0.5 })) {
      if (typeof chunk === 'string') {
        synthesis += chunk;
        this.onProgress({ type: 'synthesis_chunk', chunk });
      } else if (chunk.type === 'text') {
        synthesis += chunk.content;
        this.onProgress({ type: 'synthesis_chunk', chunk: chunk.content });
      }
    }

    this.onProgress({ type: 'synthesis_done' });
    return synthesis;
  }
}
