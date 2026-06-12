// ============================================================
// Task Decomposer & Parallel Executor
// Breaks a complex task into subtasks, runs them concurrently
// Now supports tool-calling loop (shell, web_fetch, file ops)
// ============================================================

import { executeTool, buildToolInstructions } from './tool-executor.js';

export class TaskOrchestrator {
  constructor(llmAdapter, onProgress) {
    this.llm = llmAdapter;
    this.onProgress = onProgress || (() => {});
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
   */
  async executeSubtask(subtask, context, onChunk) {
    // Build conversation messages
    let messages = [
      { role: 'system', content: context.system + buildToolInstructions() },
      {
        role: 'user',
        content: `# Task: ${subtask.title}\n\n${subtask.description}\n\n${context.history ? `Previous context:\n${context.history}` : ''}`,
      },
    ];

    let result = '';
    let toolLoopCount = 0;
    const MAX_TOOL_LOOPS = 10;

    this.onProgress({ type: 'subtask_start', taskId: subtask.id, title: subtask.title });

    while (toolLoopCount < MAX_TOOL_LOOPS) {
      toolLoopCount++;
      let llmResponse = '';

      // Stream LLM response, collecting full text
      this.onProgress({ type: 'subtask_thinking', taskId: subtask.id, loop: toolLoopCount });
      for await (const chunk of this.llm.stream(messages, { temperature: 0.7 })) {
        llmResponse += chunk;
        if (onChunk) onChunk(subtask.id, chunk);
        this.onProgress({ type: 'subtask_chunk', taskId: subtask.id, chunk });
      }

      // Detect tool_call block
      const toolCallMatch = llmResponse.match(/```tool_call\s*\n([\s\S]*?)\n```/);
      if (!toolCallMatch) {
        // No tool call → final answer
        result = llmResponse;
        break;
      }

      // Parse tool call JSON
      let toolCall;
      try {
        toolCall = JSON.parse(toolCallMatch[1].trim());
      } catch {
        // If JSON parse fails, try extracting from the whole response
        const jsonMatch = llmResponse.match(/\{[\s\S]*"tool"[\s\S]*\}/);
        if (jsonMatch) {
          try { toolCall = JSON.parse(jsonMatch[0]); } catch { /* ignore */ }
        }
      }

      if (!toolCall || !toolCall.tool) {
        // No valid tool call → treat as final answer
        result = llmResponse;
        break;
      }

      this.onProgress({
        type: 'tool_call',
        taskId: subtask.id,
        tool: toolCall.tool,
        args: toolCall.arguments,
      });

      // Execute the tool
      const toolResult = await executeTool({
        name: toolCall.tool,
        arguments: toolCall.arguments || {},
      });

      this.onProgress({
        type: 'tool_result',
        taskId: subtask.id,
        success: toolResult.success,
        output: toolResult.output.slice(0, 2000), // truncate for display
      });

      // Add assistant response (with tool call) and tool result to messages
      messages.push({
        role: 'assistant',
        content: llmResponse,
      });
      messages.push({
        role: 'user',
        content: `Tool result (${toolCall.tool}):\n\`\`\`json\n${toolResult.output}\n\`\`\`\n\nContinue with the task. If you have the final answer, provide it. Otherwise, call another tool.`,
      });

      // Trim messages to avoid token overflow
      if (messages.length > 20) {
        messages = [messages[0], ...messages.slice(-18)];
      }
    }

    if (toolLoopCount >= MAX_TOOL_LOOPS) {
      result += '\n\n[Tool loop limit reached]';
    }

    this.onProgress({ type: 'subtask_done', taskId: subtask.id, result });
    return { id: subtask.id, title: subtask.title, result, status: 'done' };
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
