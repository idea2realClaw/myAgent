// ============================================================
// Task Decomposer & Parallel Executor
// Breaks a complex task into subtasks, runs them concurrently
// Now supports Native Function Calling (OpenAI tool_calls)
// Features: Loop Guard, structured stream events
// ============================================================

import { executeTool, buildToolInstructions, TOOL_SCHEMAS_OPENAI, KNOWN_TOOLS } from './tool-executor.js';

export class TaskOrchestrator {
  constructor(llmAdapter, onProgress, shouldStop) {
    this.llm = llmAdapter;
    this.onProgress = onProgress || (() => {});
    this.shouldStop = shouldStop || (() => false);
    this.useNativeFunctionCalling = llmAdapter.supportsFunctionCalling?.() || false;
  }

  /**
   * Decompose a user request into subtasks using LLM
   */
  async decompose(userRequest, systemContext) {
    const prompt = `You are a task planning expert. Analyze this request and decompose it into independent subtasks that can be executed in parallel.

Return ONLY a JSON object in this exact format (no markdown, no explanation):
{
  "title": "Brief overall task title",
  "canParallelize": true,
  "subtasks": [
    {
      "id": "task-1",
      "title": "Subtask title",
      "description": "Detailed description of what this subtask should accomplish",
      "type": "research|analysis|generation|code|summary",
      "dependencies": []
    }
  ]
}

Rules:
- 1-6 subtasks only
- Each subtask must be independently executable
- dependencies[] lists task IDs that must complete first
- If the request is simple (1 step), return a single subtask
- Parallel tasks have empty dependencies[]

User request: "${userRequest}"`;

    const messages = [
      { role: 'system', content: systemContext || 'You are a helpful assistant.' },
      { role: 'user', content: prompt },
    ];

    try {
      const raw = await this.llm.chat(messages, { temperature: 0.3 });
      // Extract JSON from response
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON in decomposition response');
      return JSON.parse(jsonMatch[0]);
    } catch (err) {
      // Fallback: treat entire request as single task
      return {
        title: userRequest.slice(0, 60),
        canParallelize: false,
        subtasks: [{
          id: 'task-1',
          title: 'Execute request',
          description: userRequest,
          type: 'general',
          dependencies: [],
        }],
      };
    }
  }

  /**
   * Execute a single subtask (with tool-calling loop)
   * Supports Native Function Calling or legacy text-based tool calls
   */
  async executeSubtask(subtask, context, onChunk) {
    // Build conversation messages
    let messages = [
      { role: 'system', content: context.system + buildToolInstructions(this.useNativeFunctionCalling) },
      {
        role: 'user',
        content: `# Task: ${subtask.title}\n\n${subtask.description}\n\n${context.history ? `Previous context:\n${context.history}` : ''}`,
      },
    ];

    let result = '';
    let toolLoopCount = 0;
    const MAX_TOOL_LOOPS = 10;
    
    // Loop Guard: detect repeated tool calls
    let lastToolCallKey = null;
    let repeatCount = 0;

    this.onProgress({ type: 'subtask_start', taskId: subtask.id, title: subtask.title });

    while (toolLoopCount < MAX_TOOL_LOOPS) {
      toolLoopCount++;

      // Check if stop requested
      if (this.shouldStop()) {
        return { success: false, error: 'Task stopped by user', partial: result };
      }

      let llmResponse = '';
      let toolCalls = [];

      // Stream LLM response, collecting full text
      this.onProgress({ type: 'subtask_thinking', taskId: subtask.id, loop: toolLoopCount });
      
      if (this.useNativeFunctionCalling) {
        // Native Function Calling mode
        const streamResult = this._collectStreamWithToolCalls(messages, onChunk, subtask.id);
        llmResponse = streamResult.text;
        toolCalls = streamResult.toolCalls;
      } else {
        // Legacy mode: stream text, then parse tool_call blocks
        for await (const chunk of this.llm.stream(messages, { temperature: 0.7 })) {
          llmResponse += chunk;
          if (onChunk) onChunk(subtask.id, chunk);
          this.onProgress({ type: 'subtask_chunk', taskId: subtask.id, chunk });
        }
        // Parse legacy tool_call block
        const legacyCall = this._parseLegacyToolCall(llmResponse);
        if (legacyCall) {
          toolCalls = [legacyCall];
        }
      }

      // No tool calls → final answer
      if (toolCalls.length === 0) {
        result = llmResponse;
        break;
      }

      // Process each tool call
      for (const toolCall of toolCalls) {
        const { name, arguments: args } = toolCall;

        // Strict whitelist check
        if (!KNOWN_TOOLS.has(name)) {
          this.onProgress({
            type: 'tool_result',
            taskId: subtask.id,
            success: false,
            output: `Error: Unknown tool "${name}". Available tools: ${Array.from(KNOWN_TOOLS).join(', ')}`,
          });
          continue;
        }

        // Loop Guard: detect repeated calls
        const callKey = `${name}:${JSON.stringify(args)}`;
        if (callKey === lastToolCallKey) {
          repeatCount++;
          if (repeatCount >= 2) {
            this.onProgress({
              type: 'tool_result',
              taskId: subtask.id,
              success: false,
              output: `Error: Repeated tool call detected. Stopping to prevent infinite loop.`,
            });
            result = llmResponse + '\n\n[Tool loop detected and prevented]';
            break;
          }
        } else {
          repeatCount = 0;
        }
        lastToolCallKey = callKey;

        this.onProgress({
          type: 'tool_call',
          taskId: subtask.id,
          tool: name,
          args,
        });

        // Execute the tool
        const toolResult = await executeTool({
          name,
          arguments: args || {},
        });

        this.onProgress({
          type: 'tool_result',
          taskId: subtask.id,
          success: toolResult.success,
          output: toolResult.output.slice(0, 2000), // truncate for display
        });

        // Add assistant response (with tool call) and tool result to messages
        if (this.useNativeFunctionCalling) {
          // Native mode: add assistant message with tool_calls, then tool result
          messages.push({
            role: 'assistant',
            content: llmResponse,
            tool_calls: toolCalls.map((tc, i) => ({
              id: tc.id || `call_${Date.now()}_${i}`,
              type: 'function',
              function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
            })),
          });
          messages.push({
            role: 'tool',
            tool_call_id: toolCalls[0].id || `call_${Date.now()}_0`,
            content: toolResult.output,
          });
        } else {
          // Legacy mode: add text with tool_call block
          messages.push({
            role: 'assistant',
            content: llmResponse,
          });
          messages.push({
            role: 'user',
            content: `Tool result (${name}):\n\`\`\`json\n${toolResult.output}\n\`\`\`\n\nContinue with the task. If you have the final answer, provide it. Otherwise, call another tool.`,
          });
        }

        // Trim messages to avoid token overflow
        if (messages.length > 20) {
          messages = [messages[0], ...messages.slice(-18)];
        }
      }

      // Check loop guard break
      if (repeatCount >= 2) {
        break;
      }
    }

    if (toolLoopCount >= MAX_TOOL_LOOPS) {
      result += '\n\n[Tool loop limit reached]';
    }

    this.onProgress({ type: 'subtask_done', taskId: subtask.id, result });
    return { id: subtask.id, title: subtask.title, result, status: 'done' };
  }

  /**
   * Collect stream output and detect tool_calls (for native function calling)
   */
  async _collectStreamWithToolCalls(messages, onChunk, taskId) {
    let text = '';
    let toolCalls = [];
    let waitingForToolCall = false;
    let currentToolCall = null;

    // Add tools to messages for this call
    const llmWithTools = this.llm.withTools?.(TOOL_SCHEMAS_OPENAI) || this.llm;

    try {
      for await (const event of llmWithTools.stream(messages, {
        temperature: 0.7,
        tools: TOOL_SCHEMAS_OPENAI,
      })) {
        // Handle structured events
        if (typeof event === 'object') {
          if (event.type === 'text') {
            text += event.content;
            if (onChunk) onChunk(taskId, event.content);
            this.onProgress({ type: 'subtask_chunk', taskId, chunk: event.content });
          } else if (event.type === 'tool_call') {
            toolCalls.push(event);
            this.onProgress({ type: 'tool_call', taskId, tool: event.name, args: event.arguments });
          }
        } else {
          // String chunk (legacy)
          text += event;
          if (onChunk) onChunk(taskId, event);
          this.onProgress({ type: 'subtask_chunk', taskId, chunk: event });
        }
      }
    } catch (err) {
      console.error('Stream error:', err);
    }

    return { text, toolCalls };
  }

  /**
   * Parse legacy tool_call block with strict whitelist
   */
  _parseLegacyToolCall(response) {
    // Only recognize ```tool_call code blocks, not bare JSON in body
    const toolCallMatch = response.match(/```tool_call\s*\n([\s\S]*?)\n```/);
    if (!toolCallMatch) {
      return null;
    }

    let toolCall;
    try {
      toolCall = JSON.parse(toolCallMatch[1].trim());
    } catch {
      return null;
    }

    if (!toolCall || !toolCall.tool) {
      return null;
    }

    // Strict whitelist check
    if (!KNOWN_TOOLS.has(toolCall.tool)) {
      console.warn(`[Legacy] Unknown tool: ${toolCall.tool}`);
      return null;
    }

    return {
      name: toolCall.tool,
      arguments: toolCall.arguments || {},
    };
  }

  /**
   * Run all subtasks in parallel (respecting dependencies)
   */
  async executeAll(plan, context, onChunk) {
    const results = new Map();
    const pending = new Map(plan.subtasks.map(t => [t.id, t]));
    const running = new Set();

    const isReady = (task) =>
      task.dependencies.every(dep => results.has(dep) && results.get(dep).status === 'done');

    while (pending.size > 0 || running.size > 0) {
      // Launch all ready tasks
      for (const [id, task] of pending) {
        if (isReady(task) && !running.has(id)) {
          running.add(id);
          pending.delete(id);

          // Build context with dependency results
          const depResults = task.dependencies
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
        // Wait a bit for tasks to complete
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
   * Synthesize final answer from all subtask results
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
        content: `Original request: "${originalRequest}"\n\nHere are the results from ${subtaskResults.length} parallel subtasks:\n\n${resultsSummary}\n\nSynthesize these results into a clear, comprehensive final answer. Present it in a well-organized, readable format.`,
      },
    ];

    let synthesis = '';
    this.onProgress({ type: 'synthesis_start' });

    for await (const chunk of this.llm.stream(messages, { temperature: 0.5 })) {
      synthesis += chunk;
      this.onProgress({ type: 'synthesis_chunk', chunk });
    }

    this.onProgress({ type: 'synthesis_done' });
    return synthesis;
  }
}
