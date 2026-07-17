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
   * Uses OpenAI Function Calling for reliable structured output.
   * Falls back to prompt-based approach if function calling not supported.
   */
  async decompose(userRequest, systemContext) {
    // Try native function calling first (more reliable)
    if (this.useNativeFunctionCalling && this.llm.chatWithTools) {
      try {
        console.log(`[TaskOrchestrator] Using native function calling for decomposition`);
        const result = await this._decomposeWithFunctionCalling(userRequest, systemContext);
        if (result && result.subtasks && result.subtasks.length > 0) {
          console.log(`[TaskOrchestrator] Function calling decomposition successful, got ${result.subtasks.length} subtasks`);
          return result;
        }
      } catch (err) {
        console.error(`[TaskOrchestrator] Function calling failed: ${err.message}, falling back to prompt-based approach`);
      }
    }

    // Fallback: prompt-based approach
    console.log(`[TaskOrchestrator] Using prompt-based decomposition`);
    return await this._decomposeWithPrompt(userRequest, systemContext);
  }

  /**
   * Decompose using OpenAI Function Calling (native tool use)
   * This is more reliable than parsing JSON from text
   */
  async _decomposeWithFunctionCalling(userRequest, systemContext) {
    // Define the decomposition function for OpenAI
    const decompositionFunction = {
      name: 'decompose_task',
      description: 'Decompose a user request into structured, executable subtasks',
      parameters: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: 'Brief description of the overall task',
          },
          subtasks: {
            type: 'array',
            description: 'List of executable subtasks',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'Unique task ID (e.g., task-1, task-2)' },
                title: { type: 'string', description: 'What this step does' },
                purpose: { type: 'string', description: 'Why this step is needed' },
                tool: {
                  type: 'string',
                  description: 'Tool to use',
                  enum: [...PLANABLE_TOOLS],
                },
                args: {
                  type: 'object',
                  description: 'Tool-specific arguments',
                },
                depends_on: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'IDs of tasks that must complete first',
                },
              },
              required: ['id', 'title', 'tool', 'args'],
            },
          },
        },
        required: ['title', 'subtasks'],
      },
    };

    const messages = [
      {
        role: 'system',
        content: `You are a task decomposition expert. Break down user requests into executable subtasks.
        
Rules:
1. Each subtask MUST use a concrete tool (not just llm_reason)
2. For file operations, use: file_list, file_read, file_glob, file_grep
3. For shell commands, use: shell_execute
4. For web operations, use: web_search, web_fetch
5. For code execution, use: python_execute
6. Use depends_on for task dependencies
7. Keep subtasks focused and executable`,
      },
      {
        role: 'user',
        content: `Decompose this request into executable subtasks: ${userRequest}\n\nContext: ${systemContext || 'General purpose'}`,
      },
    ];

    try {
      // Call LLM with function definition
      const response = await this.llm.chatWithTools(messages, [decompositionFunction], {
        temperature: 0.2,
        maxTokens: 2000,
      });

      // Extract function call from response
      if (response && response.tool_calls && response.tool_calls.length > 0) {
        const toolCall = response.tool_calls[0];
        if (toolCall.function.name === 'decompose_task') {
          const args = JSON.parse(toolCall.function.arguments);
          
          // Validate and normalize
          const subtasksList = Array.isArray(args.subtasks) ? args.subtasks : [];
          const validatedSubtasks = subtasksList.map((subtask, index) => {
            if (!subtask || typeof subtask !== 'object') {
              return {
                id: `task-${index + 1}`,
                title: `Step ${index + 1}`,
                purpose: '',
                tool: 'llm_reason',
                args: {},
                depends_on: [],
              };
            }
            return {
              id: subtask.id || `task-${index + 1}`,
              title: subtask.title || `Step ${index + 1}`,
              purpose: subtask.purpose || '',
              tool: PLANABLE_TOOLS.has(subtask.tool) ? subtask.tool : 'llm_reason',
              args: subtask.args || {},
              depends_on: subtask.depends_on || [],
            };
          });

          return {
            title: args.title || userRequest.slice(0, 60),
            subtasks: validatedSubtasks,
          };
        }
      }

      throw new Error('No valid function call in response');
    } catch (err) {
      console.error(`[TaskOrchestrator] Function calling error: ${err.message}`);
      throw err;
    }
  }

  /**
   * Decompose using prompt-based approach (fallback)
   */
  async _decomposeWithPrompt(userRequest, systemContext) {
    // 尝试最多 2 次分解（如果第一次 JSON 解析失败，重试）
    for (let attempt = 1; attempt <= 2; attempt++) {
      const messages = [
        { role: 'system', content: this._buildDecompositionPrompt() },
        { role: 'user', content: `用户请求: ${userRequest}\n\n项目上下文: ${systemContext || '通用'}` },
      ];

      try {
        const llmResponse = await this.llm.chat(messages, {
          temperature: 0.2,  // 降低温度，提高 JSON 输出稳定性
          maxTokens: 2000,
        });

        // 详细记录 LLM 原始回复（用于调试）
        console.log(`[TaskOrchestrator] decompose() attempt ${attempt}, LLM response length: ${llmResponse?.length || 0}`);
        console.log(`[TaskOrchestrator] LLM raw response (first 500 chars): ${JSON.stringify(llmResponse?.slice(0, 500))}`);

        // 健壮的 JSON 提取
        let decomposition;
        try {
          let jsonStr = llmResponse.trim();

          // 方法1：直接解析（如果 LLM 返回了纯 JSON）
          try {
            decomposition = JSON.parse(jsonStr);
          } catch {
            // 方法2：提取 ```json ... ``` 或 ``` ... ``` 包裹的内容
            const markdownMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
            if (markdownMatch) {
              decomposition = JSON.parse(markdownMatch[1].trim());
            } else {
              // 方法3：提取第一个 { 到最后一个 }
              const jsonStart = jsonStr.indexOf('{');
              const jsonEnd = jsonStr.lastIndexOf('}') + 1;
              if (jsonStart >= 0 && jsonEnd > jsonStart) {
                const extracted = jsonStr.slice(jsonStart, jsonEnd);
                console.log(`[TaskOrchestrator] Extracted JSON (chars ${jsonStart}-${jsonEnd}): ${extracted.slice(0, 200)}...`);
                decomposition = JSON.parse(extracted);
              } else {
                throw new Error('No JSON object found in response');
              }
            }
          }

          // 验证结构
          if (!decomposition.subtasks || !Array.isArray(decomposition.subtasks)) {
            throw new Error('Invalid structure: missing subtasks array');
          }

          // 验证通过，跳出重试循环
          console.log(`[TaskOrchestrator] Decomposition successful on attempt ${attempt}, got ${decomposition.subtasks.length} subtasks`);
          break;

        } catch (parseErr) {
          console.error(`[TaskOrchestrator] JSON parse failed (attempt ${attempt}): ${parseErr.message}`);
          if (attempt === 2) {
            // 两次都失败，使用 fallback
            console.warn('[TaskOrchestrator] Both attempts failed, using fallback');
            return this._createFallbackDecomposition(userRequest);
          }
          // 否则继续重试
          continue;
        }
      } catch (err) {
        console.error(`[TaskOrchestrator] LLM call failed (attempt ${attempt}): ${err.message}`);
        if (attempt === 2) {
          return this._createFallbackDecomposition(userRequest);
        }
      }
    }

    // 验证并规范化每个子任务
    const validatedSubtasks = [];
    for (const [index, subtask] of decomposition.subtasks.entries()) {
      if (!subtask.tool) {
        console.warn(`[TaskOrchestrator] Subtask ${index} missing tool, skipping`);
        continue;
      }

      // 验证工具是否存在
      if (!PLANABLE_TOOLS.has(subtask.tool)) {
        console.warn(`[TaskOrchestrator] Unknown tool: ${subtask.tool}, converting to llm_reason`);
        subtask.tool = 'llm_reason';
      }

      // 确保必需字段存在
      validatedSubtasks.push({
        id: subtask.id || `task-${index + 1}`,
        title: subtask.title || `Step ${index + 1}`,
        purpose: subtask.purpose || '',
        tool: subtask.tool,
        args: subtask.args || {},
        depends_on: subtask.depends_on || [],
      });
    }

    // 如果验证后没有子任务，使用 fallback
    if (validatedSubtasks.length === 0) {
      console.warn('[TaskOrchestrator] No valid subtasks after validation, using fallback');
      return this._createFallbackDecomposition(userRequest);
    }

    return {
      title: decomposition.title || userRequest.slice(0, 60),
      subtasks: validatedSubtasks,
    };
  }

  /**
   * 创建 fallback 分解（当 LLM 分解失败时使用）
   */
  _createFallbackDecomposition(userRequest) {
    // 尝试根据请求内容智能选择工具
    const request = userRequest.toLowerCase();

    // 如果请求涉及文件/代码分析，使用文件工具
    if (request.includes('代码') || request.includes('code') || request.includes('文件') || request.includes('file')) {
      return {
        title: userRequest.slice(0, 60),
        subtasks: [
          {
            id: 'task-1',
            title: '列出项目文件',
            purpose: '了解项目结构',
            tool: 'file_list',
            args: { path: '.' },
            depends_on: [],
          },
          {
            id: 'task-2',
            title: '分析内容',
            purpose: '基于文件列表回答问题',
            tool: 'llm_reason',
            args: { prompt: `用户请求: ${userRequest}\n\n请基于前面列出的文件结构，回答用户的问题。` },
            depends_on: ['task-1'],
          },
        ],
      };
    }

    // 如果请求涉及搜索
    if (request.includes('搜索') || request.includes('search') || request.includes('查找') || request.includes('find')) {
      return {
        title: userRequest.slice(0, 60),
        subtasks: [
          {
            id: 'task-1',
            title: '搜索信息',
            purpose: '获取相关信息',
            tool: 'web_search',
            args: { query: userRequest, count: 5 },
            depends_on: [],
          },
          {
            id: 'task-2',
            title: '总结结果',
            purpose: '整理搜索结果',
            tool: 'llm_reason',
            args: { prompt: `基于搜索结果，回答: ${userRequest}` },
            depends_on: ['task-1'],
          },
        ],
      };
    }

    // 默认：单个 llm_reason
    return {
      title: userRequest.slice(0, 60),
      subtasks: [{
        id: 'task-1',
        title: '回答用户问题',
        tool: 'llm_reason',
        args: { prompt: userRequest },
        depends_on: [],
      }],
    };
  }

  /**
   * Build the decomposition prompt for LLM
   * 强化版：确保 LLM 返回纯 JSON
   */
  _buildDecompositionPrompt() {
    const toolList = Array.from(KNOWN_TOOLS).join(', ');

    return `你是一个任务分解专家。你的任务是把用户的请求分解成多个可执行的子任务。
每个子任务必须调用一个具体的工具（不能用 llm_reason 代替所有步骤）。

## 可用工具列表：
${toolList}

## 各工具的参数说明：
- file_list: { "path": "目录路径" } — 列出目录内容
- file_read: { "path": "文件路径" } — 读取文件内容
- file_glob: { "pattern": "*.js", "path": "." } — 搜索文件
- file_grep: { "pattern": "关键字", "path": "." } — 搜索文件内容
- shell_execute: { "command": "ls -la" } — 执行 shell 命令
- web_search: { "query": "搜索词", "count": 5 } — 搜索网络
- web_fetch: { "url": "https://..." } — 获取网页内容
- python_execute: { "code": "print('hello')" } — 执行 Python
- http_request: { "url": "...", "method": "GET" } — HTTP 请求
- llm_reason: { "prompt": "分析问题..." } — LLM 推理（仅用于需要综合分析的步骤）

## 输出格式（必须严格遵守）：
你必须只返回一个纯 JSON 对象，不要有任何其他文字、解释、或 markdown 包裹。

JSON 格式：
{"title":"任务标题","subtasks":[{"id":"task-1","title":"步骤描述","purpose":"目的","tool":"工具名","args":{工具参数},"depends_on":[]}]}

## 示例 1：
用户输入：分析代码 /Users/zhuxiaodong/Documents/GitRepo/MyAgent
你的输出：
{"title":"分析 MyAgent 代码","subtasks":[{"id":"task-1","title":"列出项目文件结构","purpose":"了解项目整体结构","tool":"file_list","args":{"path":"."},"depends_on":[]},{"id":"task-2","title":"读取 server.js","purpose":"了解服务器实现","tool":"file_read","args":{"path":"backend/server.js"},"depends_on":["task-1"]},{"id":"task-3","title":"总结分析结果","purpose":"综合分析代码结构和功能","tool":"llm_reason","args":{"prompt":"基于前面读取的文件，分析 MyAgent 的代码结构、主要功能和技术栈"},"depends_on":["task-1","task-2"]}]}

## 示例 2：
用户输入：搜索 MyAgent 的相关信息
你的输出：
{"title":"搜索 MyAgent 信息","subtasks":[{"id":"task-1","title":"搜索 MyAgent","purpose":"获取 MyAgent 的相关资料","tool":"web_search","args":{"query":"MyAgent","count":5},"depends_on":[]},{"id":"task-2","title":"总结搜索结果","purpose":"整理搜索到的信息","tool":"llm_reason","args":{"prompt":"根据搜索结果，总结 MyAgent 的关键信息"},"depends_on":["task-1"]}]}

## 关键要求：
1. 必须返回纯 JSON，不要用 \`\`\`json 包裹
2. 每个子任务都必须有具体的 tool，不能全是 llm_reason
3. 对于文件操作，必须用 file_list/file_read 等工具，不能只用 llm_reason
4. 子任务数量：简单任务 2-3 个，复杂任务 3-5 个
5. 使用 depends_on 表示依赖关系（前面的任务 ID）

现在，请分解用户的请求。`;
  }


  /**
   * Execute a single structured subtask.
   * The subtask specifies a tool and args — we execute it directly.
   * For llm_reason tool, we call the LLM with the prompt + dependency results.
   * For other tools, we call executeTool() directly.
   * Guarantees a result for every step.
   */
  async executeSubtask(subtask, context, onChunk) {
    const { id, title, tool, args, depends_on, purpose } = subtask;

    // 发送 subtask_panel 消息，包含 purpose（目的）和 command（具体命令）
    const commandStr = tool === 'llm_reason'
      ? `llm_reason(prompt: "${args.prompt || args.description || title}")`
      : `${tool}(${JSON.stringify(args)})`;
    this.onProgress({ type: 'subtask_panel', taskId: id, title: purpose || title, purpose: purpose || '', command: commandStr, instruction: `${tool}(${JSON.stringify(args).slice(0, 200)})` });
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
   * Accepts either a decomposition object { title, subtasks } or a subtasks array
   */
  async executeAll(decomposition, context, onChunk) {
    // Handle both formats: decomposition object or raw subtasks array
    let subtasks = [];
    
    if (Array.isArray(decomposition)) {
      subtasks = decomposition;
    } else if (decomposition && Array.isArray(decomposition.subtasks)) {
      subtasks = decomposition.subtasks;
    } else if (decomposition && decomposition.results) {
      // Might be a results object, extract if possible
      console.error('[executeAll] Received results object instead of decomposition');
      return { success: false, results: [] };
    } else {
      console.error('[executeAll] Invalid input:', typeof decomposition, JSON.stringify(decomposition).slice(0, 200));
      throw new Error('executeAll: Invalid decomposition input (expected array or { subtasks })');
    }
    
    if (subtasks.length === 0) {
      throw new Error('executeAll: No subtasks to execute');
    }
    
    console.log(`[executeAll] Executing ${subtasks.length} subtasks...`);
    const results = new Map();
    const completed = new Set();
    
    // Topological sort (simple version)
    const executeTask = async (task) => {
      // Wait for dependencies
      for (const depId of task.depends_on || []) {
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

  /**
   * Synthesize results from multiple subtasks into a final answer
   * Uses LLM to combine and summarize the results
   */
  async synthesize(originalRequest, results, context) {
    const { system, history } = context || {};
    
    // Build a summary of all results
    const resultSummary = results.map(r => 
      `[${r.id}] ${r.title}\nStatus: ${r.status}\nResult: ${r.result?.slice(0, 500) || '(no result)'}`
    ).join('\n\n---\n\n');
    
    const messages = [
      { role: 'system', content: system || 'You are a helpful AI assistant.' },
      ...(history || []).slice(-10),
      { role: 'user', content: `Original request: ${originalRequest}\n\nHere are the results from executing subtasks:\n\n${resultSummary}\n\nPlease synthesize these results into a clear, comprehensive final answer.` },
    ];
    
    try {
      const llmResponse = await this.llm.chat(messages, { temperature: 0.7, maxTokens: 2000 });
      return llmResponse;
    } catch (err) {
      console.error('[TaskOrchestrator] Synthesis failed:', err.message);
      // Fallback: return raw results
      return `Task execution completed. Results:\n\n${resultSummary}`;
    }
  }
}

export default TaskOrchestrator;
