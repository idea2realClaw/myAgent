// ============================================================
// Task Decomposer & Parallel Executor
// 结构化任务分解：每个子任务必须是一个可执行的工具调用
// 确保每一步都有结果
// ============================================================

import { executeTool, buildToolInstructions, TOOL_SCHEMAS_OPENAI, KNOWN_TOOLS } from './tool-executor.js';

// 可在分解计划中使用的"工具"白名单
// 包含真实工具 + 一个特殊的 llm_reason（用于需要 LLM 推理/综合的步骤）
const PLANABLE_TOOLS = new Set([...KNOWN_TOOLS, 'llm_reason']);

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
    // Use LLM to decompose the task
    const messages = [
      { role: 'system', content: this._buildDecompositionPrompt() },
      { role: 'user', content: `User request: ${userRequest}\n\nProject context: ${systemContext || 'General purpose'}` },
    ];

    try {
      const llmResponse = await this.llm.chat(messages, {
        temperature: 0.3,
        maxTokens: 2000,
        tools: this.useNativeFunctionCalling ? TOOL_SCHEMAS_OPENAI : undefined,
      });

      // Try to parse the response as JSON
      let decomposition;
      try {
        // Extract JSON from response (might be wrapped in markdown)
        const jsonMatch = llmResponse.match(/```(?:json)?\s*([\s\S]*?)\s*```/) || llmResponse.match(/(\{[\s\S]*\})/);
        const jsonStr = jsonMatch ? jsonMatch[1] : llmResponse;
        decomposition = JSON.parse(jsonStr);
      } catch (parseErr) {
        console.error('[TaskOrchestrator] Failed to parse decomposition:', parseErr.message);
        // Fallback: create a single llm_reason task
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

      // Validate decomposition structure
      if (!decomposition.subtasks || !Array.isArray(decomposition.subtasks)) {
        throw new Error('Invalid decomposition: missing subtasks array');
      }

      // Validate and normalize each subtask
      const validatedSubtasks = [];
      for (const [index, subtask] of decomposition.subtasks.entries()) {
        if (!subtask.tool) {
          console.warn(`[TaskOrchestrator] Subtask ${index} missing tool, skipping`);
          continue;
        }

        // Validate tool exists
        if (!PLANABLE_TOOLS.has(subtask.tool)) {
          console.warn(`[TaskOrchestrator] Unknown tool: ${subtask.tool}, converting to llm_reason`);
          subtask.tool = 'llm_reason';
        }

        // Ensure required fields
        validatedSubtasks.push({
          id: subtask.id || `task-${index + 1}`,
          title: subtask.title || `Step ${index + 1}`,
          purpose: subtask.purpose || '',
          tool: subtask.tool,
          args: subtask.args || {},
          depends_on: subtask.depends_on || [],
        });
      }

      return {
        title: decomposition.title || userRequest.slice(0, 60),
        subtasks: validatedSubtasks,
      };
    } catch (err) {
      console.error('[TaskOrchestrator] Decomposition failed:', err.message);
      // Fallback: create a single llm_reason task
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
  }

  /**
   * Build the decomposition prompt for LLM
   */
  _buildDecompositionPrompt() {
    const toolList = Array.from(KNOWN_TOOLS).join(', ');
    
    return `You are a task decomposition expert. Given a user request, break it down into structured, executable subtasks.

## Rules:
1. Each subtask MUST use a concrete tool from the whitelist
2. Each subtask MUST have a clear purpose
3. Tools should be executed in logical order (use depends_on for dependencies)
4. For tasks requiring reasoning/analysis, use "llm_reason" tool
5. For file operations, use: file_read, file_write, file_edit, file_list, file_glob, file_grep
6. For shell commands, use: shell_execute
7. For web operations, use: web_fetch, web_search
8. For code execution, use: python_execute
9. For API calls, use: http_request

## Available Tools:
${toolList}

## Output Format:
Return a JSON object with this structure:
{
  "title": "Brief description of the overall task",
  "subtasks": [
    {
      "id": "task-1",
      "title": "What this step does",
      "purpose": "Why this step is needed",
      "tool": "tool_name",
      "args": { /* tool-specific arguments */ },
      "depends_on": [] // IDs of tasks that must complete first
    }
  ]
}

## Examples:

User request: "Analyze the code in /Users/zhuxiaodong/Documents/GitRepo/MyAgent"
Output:
{
  "title": "Analyze MyAgent codebase",
  "subtasks": [
    {
      "id": "task-1",
      "title": "List project structure",
      "purpose": "Understand the overall project layout",
      "tool": "file_list",
      "args": { "path": "." },
      "depends_on": []
    },
    {
      "id": "task-2",
      "title": "Read main server file",
      "purpose": "Understand the server architecture",
      "tool": "file_read",
      "args": { "path": "backend/server.js" },
      "depends_on": ["task-1"]
    },
    {
      "id": "task-3",
      "title": "Analyze dependencies",
      "purpose": "Summarize the codebase analysis",
      "tool": "llm_reason",
      "args": { "prompt": "Analyze the MyAgent codebase based on the files read. Provide a summary of architecture, main components, and key features." },
      "depends_on": ["task-1", "task-2"]
    }
  ]
}

IMPORTANT: Return ONLY the JSON object, no other text.`;
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

    this.onProgress({ type: 'subtask_done', taskId: id, result: result.slice(0, 500) });
    return { id, title, result, status: success ? 'completed' : 'failed' };
  }

  /**
   * Execute all subtasks in parallel (respecting dependencies)
   */
  async executeAll(subtasks, context, onChunk) {
    const results = new Map();
    const completed = new Set();
    
    // Topological sort (simple version)
    const executeTask = async (task) => {
      // Wait for dependencies
      for (const depId of task.depends_on) {
        if (!completed.has(depId)) {
          // Dependency not yet complete, wait
          await new Promise((resolve) => {
            const check = () => {
              if (completed.has(depId)) {
                resolve();
              } else {
                setTimeout(check, 100);
              }
            };
            check();
          });
        }
      }

      // Execute the task
      const result = await this.executeSubtask(task, {
        ...context,
        history: Array.from(results.values()).map(r => `[${r.id}] ${r.result}`).join('\n\n'),
      }, onChunk);

      results.set(task.id, result);
      completed.add(task.id);

      return result;
    };

    // Execute all tasks (respecting dependencies)
    const tasks = subtasks.map(task => executeTask(task));
    const allResults = await Promise.all(tasks);

    return {
      success: allResults.every(r => r.status === 'completed'),
      results: allResults,
    };
  }
}

export default TaskOrchestrator;
