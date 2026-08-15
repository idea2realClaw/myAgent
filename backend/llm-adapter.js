// ============================================================
// LLM Provider Adapter
// Supports: OpenAI, Anthropic (Claude), OpenRouter, QGenie, Local (GenieAPIService)
// Features: Native function calling, structured stream events
// ============================================================

import { repairJsonArgs } from './json-repair-util.js';

// 单次 LLM 调用的默认超时(毫秒)。provider 网络一旦挂起，没有超时会让
// await llm.chat(...) 永远不返回——调用方(如 planDecompose 的"正在分解任务")
// 会卡死。超时后抛错，由调用方 try/catch 兜底(退化为单一子任务)，状态得以推进。
const DEFAULT_LLM_TIMEOUT_MS = 90000;

// 超时熔断：包裹任意 promise，超时即 reject，避免调用方无限挂起。
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export class LLMAdapter {
  constructor(config) {
    this.config = config; // { provider, apiKey, model, baseURL? }
  }

  /**
   * Check if this adapter supports native function calling
   */
  supportsFunctionCalling() {
    const { provider } = this.config;
    return ['openai', 'openrouter', 'qgenie', 'local'].includes(provider);
  }

  async chat(messages, options = {}) {
    const { provider } = this.config;
    const ms = options.timeout ?? DEFAULT_LLM_TIMEOUT_MS;

    let inner;
    if (provider === 'anthropic') {
      inner = this._anthropicChat(messages, options);
    } else if (provider === 'qgenie') {
      inner = this._qgenieChat(messages, options);
    } else if (provider === 'local') {
      inner = this._localChat(messages, options);
    } else {
      // OpenAI-compatible (openai + openrouter both use same API)
      inner = this._openaiChat(messages, options);
    }
    // 统一超时熔断：即便 provider SDK 未正确处理底层超时，也保证 await 会返回/抛错。
    return withTimeout(inner, ms, `llm.chat[${provider}]`);
  }

  async *stream(messages, options = {}) {
    const { provider } = this.config;
    if (provider === 'anthropic') {
      yield* this._anthropicStream(messages, options);
    } else if (provider === 'qgenie') {
      yield* this._qgenieStream(messages, options);
    } else if (provider === 'local') {
      yield* this._localStream(messages, options);
    } else {
      yield* this._openaiStream(messages, options);
    }
  }

  // ── OpenAI-compatible (openai, openrouter) ─────────

  async _openaiChat(messages, options) {
    const { OpenAI } = await import('openai');
    const { apiKey, model, baseURL } = this.config;

    const clientConfig = { apiKey, timeout: options.timeout ?? DEFAULT_LLM_TIMEOUT_MS };
    if (baseURL) clientConfig.baseURL = baseURL;

    const client = new OpenAI(clientConfig);
    const response = await client.chat.completions.create({
      model: model || 'gpt-4o',
      messages,
      temperature: options.temperature ?? 0.7,
      max_tokens: options.maxTokens,
      tools: options.tools || undefined,
      ...options.extra,
    });
    return response.choices[0].message.content;
  }

  async *_openaiStream(messages, options = {}) {
    const { OpenAI } = await import('openai');
    const { apiKey, model, baseURL } = this.config;

    const clientConfig = { apiKey, timeout: options.timeout ?? DEFAULT_LLM_TIMEOUT_MS };
    if (baseURL) clientConfig.baseURL = baseURL;

    const client = new OpenAI(clientConfig);
    
    // Build request params
    const params = {
      model: model || 'gpt-4o',
      messages,
      temperature: options.temperature ?? 0.7,
      stream: true,
      ...options.extra,
      ...(options.signal ? { signal: options.signal } : {}),
    };
    
    // Add tools if provided (for native function calling)
    if (options.tools && options.tools.length > 0) {
      params.tools = options.tools;
      params.tool_choice = 'auto';
    }

    const stream = await client.chat.completions.create(params);

    let currentToolCall = null;
    let toolCalls = [];

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      
      if (!delta) continue;

      // Handle text content
      if (delta.content) {
        yield {
          type: 'text',
          content: delta.content,
        };
      }

      // Handle tool calls (native function calling)
      if (delta.tool_calls && delta.tool_calls.length > 0) {
        for (const tc of delta.tool_calls) {
          if (!currentToolCall || tc.index !== currentToolCall.index) {
            // New tool call
            if (currentToolCall) {
              toolCalls.push(currentToolCall);
            }
            currentToolCall = {
              index: tc.index,
              id: tc.id || `call_${Date.now()}_${tc.index}`,
              type: 'function',
              function: {
                name: tc.function?.name || '',
                arguments: tc.function?.arguments || '',
              },
            };
          } else {
            // Append to current tool call
            if (tc.function?.arguments) {
              currentToolCall.function.arguments += tc.function.arguments;
            }
          }
        }
      }
    }

    // Push last tool call
    if (currentToolCall) {
      toolCalls.push(currentToolCall);
    }

    // Yield tool calls as structured events (tolerant JSON parse for streamed/truncated args)
    for (const tc of toolCalls) {
      const args = repairJsonArgs(tc.function.arguments);
      // 仅当修复彻底失败（原串非空却解析为空对象）时附带 raw 供上层兜底
      const raw = (typeof tc.function.arguments === 'string' && tc.function.arguments.trim() && Object.keys(args).length === 0)
        ? tc.function.arguments
        : undefined;
      yield {
        type: 'tool_call',
        id: tc.id,
        name: tc.function.name,
        arguments: args,
        ...(raw ? { raw } : {}),
      };
    }
  }

  // ── Anthropic (Claude) ─────────────────────────────

  async _anthropicChat(messages, options) {
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    const { apiKey, model } = this.config;

    const client = new Anthropic({ apiKey, timeout: options.timeout ?? DEFAULT_LLM_TIMEOUT_MS });
    // Separate system message from conversation
    const sysMsg = messages.find(m => m.role === 'system');
    const convMsgs = messages.filter(m => m.role !== 'system');

    const response = await client.messages.create({
      model: model || 'claude-opus-4-5',
      max_tokens: options.maxTokens || 8192,
      system: sysMsg?.content,
      messages: convMsgs,
    });
    return response.content[0].text;
  }

  async *_anthropicStream(messages, options) {
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    const { apiKey, model } = this.config;

    const client = new Anthropic({ apiKey });
    const sysMsg = messages.find(m => m.role === 'system');
    const convMsgs = messages.filter(m => m.role !== 'system');

    const stream = client.messages.stream({
      model: model || 'claude-opus-4-5',
      max_tokens: options.maxTokens || 8192,
      system: sysMsg?.content,
      messages: convMsgs,
      ...(options.signal ? { signal: options.signal } : {}),
    });

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        yield {
          type: 'text',
          content: event.delta.text,
        };
      }
    }
  }

  // ── QGenie ────────────────────────────────────────

  async _qgenieChat(messages, options) {
    const { apiKey, model, baseURL } = this.config;
    const url = `${baseURL || 'https://qgenie.example.com/v1'}/chat/completions`;
    const ms = options.timeout ?? DEFAULT_LLM_TIMEOUT_MS;

    const response = await fetch(url, {
      method: 'POST',
      signal: options.signal || AbortSignal.timeout(ms),
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey || 'dummy'}`,
      },
      body: JSON.stringify({
        model: model || 'qgenie-default',
        messages,
        temperature: options.temperature ?? 0.7,
        max_tokens: options.maxTokens,
        stream: false,
      }),
    });

    const data = await response.json();
    return data.choices[0]?.message?.content || '';
  }

  async *_qgenieStream(messages, options = {}) {
    const { apiKey, model, baseURL } = this.config;
    const url = `${baseURL || 'https://qgenie.example.com/v1'}/chat/completions`;
    const ms = options.timeout ?? DEFAULT_LLM_TIMEOUT_MS;

    const response = await fetch(url, {
      method: 'POST',
      signal: options.signal || AbortSignal.timeout(ms),
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey || 'dummy'}`,
      },
      body: JSON.stringify({
        model: model || 'qgenie-default',
        messages,
        temperature: options.temperature ?? 0.7,
        stream: true,
        ...(options.tools ? { tools: options.tools } : {}),
      }),
    });

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n').filter(l => l.trim());

      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') return;

        try {
          const json = JSON.parse(data);
          const delta = json.choices?.[0]?.delta;
          if (delta?.content) {
            yield { type: 'text', content: delta.content };
          }
          // Handle tool calls if present (tolerant JSON parse for streamed/truncated args)
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              let args = {};
              try { args = repairJsonArgs(tc.function?.arguments); } catch { /* ignore */ }
              yield {
                type: 'tool_call',
                name: tc.function?.name,
                arguments: args,
              };
            }
          }
        } catch { /* ignore parse errors */ }
      }
    }
  }

  // ── Local (GenieAPIService) ──────────────────────

  async _localChat(messages, options) {
    const { model, baseURL } = this.config;
    const url = `${baseURL || 'http://127.0.0.1:8910/v1'}/chat/completions`;
    const ms = options.timeout ?? DEFAULT_LLM_TIMEOUT_MS;

    const response = await fetch(url, {
      method: 'POST',
      signal: options.signal || AbortSignal.timeout(ms),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: model || 'local-default',
        messages,
        temperature: options.temperature ?? 0.7,
        max_tokens: options.maxTokens,
        stream: false,
      }),
    });

    const data = await response.json();
    return data.choices[0]?.message?.content || '';
  }

  async *_localStream(messages, options = {}) {
    const { model, baseURL } = this.config;
    const url = `${baseURL || 'http://127.0.0.1:8910/v1'}/chat/completions`;
    const ms = options.timeout ?? DEFAULT_LLM_TIMEOUT_MS;

    const response = await fetch(url, {
      method: 'POST',
      signal: options.signal || AbortSignal.timeout(ms),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: model || 'local-default',
        messages,
        temperature: options.temperature ?? 0.7,
        stream: true,
      }),
    });

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n').filter(l => l.trim());

      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') return;

        try {
          const json = JSON.parse(data);
          const delta = json.choices?.[0]?.delta;
          if (delta?.content) {
            yield { type: 'text', content: delta.content };
          }
        } catch { /* ignore parse errors */ }
      }
    }
  }

  /**
   * Chat with tools (function calling)
   * Returns the full response with tool_calls for structured output
   * Used by TaskOrchestrator for reliable task decomposition
   */
  async chatWithTools(messages, tools, options = {}) {
    const { provider } = this.config;

    if (provider === 'openai' || provider === 'openrouter' || provider === 'qgenie' || provider === 'local') {
      return this._openaiChatWithTools(messages, tools, options);
    } else if (provider === 'anthropic') {
      // Anthropic doesn't support function calling in the same way
      // Fall back to regular chat and parse JSON from response
      const response = await this._anthropicChat(messages, { ...options, tools });
      return { content: response, tool_calls: [] };
    } else {
      throw new Error(`chatWithTools not supported for provider: ${provider}`);
    }
  }

  async _openaiChatWithTools(messages, tools, options = {}) {
    const { OpenAI } = await import('openai');
    const { apiKey, model, baseURL } = this.config;

    const clientConfig = { apiKey };
    if (baseURL) clientConfig.baseURL = baseURL;

    const client = new OpenAI(clientConfig);

    // Convert tools to OpenAI format
    const openaiTools = tools.map(tool => ({
      type: 'function',
      function: {
        name: tool.name || tool.function?.name,
        description: tool.description || '',
        parameters: tool.parameters || tool.function?.parameters,
      },
    }));

    const response = await client.chat.completions.create({
      model: model || 'gpt-4o',
      messages,
      tools: openaiTools,
      tool_choice: 'auto',
      temperature: options.temperature ?? 0.2,
      max_tokens: options.maxTokens || 2000,
      ...options.extra,
    });

    const message = response.choices[0].message;

    // Return structured response
    if (message.tool_calls && message.tool_calls.length > 0) {
      return {
        content: message.content || '',
        tool_calls: message.tool_calls.map(tc => ({
          id: tc.id,
          type: tc.type,
          function: {
            name: tc.function.name,
            arguments: tc.function.arguments,
          },
        })),
      };
    }

    return {
      content: message.content || '',
      tool_calls: [],
    };
  }

  /**
   * Get available models for this provider
   */
  async listModels() {
    const { provider, apiKey, baseURL } = this.config;
    
    try {
      if (provider === 'local') {
        const url = `${baseURL || 'http://127.0.0.1:8910/v1'}/models`;
        const resp = await fetch(url);
        const data = await resp.json();
        return data.data || [];
      } else if (provider === 'openai' || provider === 'openrouter' || provider === 'qgenie') {
        const url = `${baseURL || 'https://api.openai.com/v1'}/models`;
        const resp = await fetch(url, {
          headers: { 'Authorization': `Bearer ${apiKey}` },
        });
        const data = await resp.json();
        return data.data || [];
      }
    } catch (err) {
      console.error('listModels error:', err.message);
    }
    return [];
  }
}
