// ============================================================
// LLM Provider Adapter
// Supports: OpenAI, Anthropic (Claude), OpenRouter
// ============================================================

export class LLMAdapter {
  constructor(config) {
    this.config = config; // { provider, apiKey, model, baseURL? }
  }

  async chat(messages, options = {}) {
    const { provider, apiKey, model, baseURL } = this.config;

    if (provider === 'anthropic') {
      return this._anthropicChat(messages, options);
    } else {
      // OpenAI-compatible (openai + openrouter both use same API)
      return this._openaiChat(messages, options);
    }
  }

  async *stream(messages, options = {}) {
    const { provider } = this.config;
    if (provider === 'anthropic') {
      yield* this._anthropicStream(messages, options);
    } else {
      yield* this._openaiStream(messages, options);
    }
  }

  async _openaiChat(messages, options) {
    const { OpenAI } = await import('openai');
    const { apiKey, model, baseURL } = this.config;

    const clientConfig = { apiKey };
    if (baseURL) clientConfig.baseURL = baseURL;

    const client = new OpenAI(clientConfig);
    const response = await client.chat.completions.create({
      model: model || 'gpt-4o',
      messages,
      temperature: options.temperature ?? 0.7,
      max_tokens: options.maxTokens,
      ...options.extra,
    });
    return response.choices[0].message.content;
  }

  async *_openaiStream(messages, options) {
    const { OpenAI } = await import('openai');
    const { apiKey, model, baseURL } = this.config;

    const clientConfig = { apiKey };
    if (baseURL) clientConfig.baseURL = baseURL;

    const client = new OpenAI(clientConfig);
    const stream = await client.chat.completions.create({
      model: model || 'gpt-4o',
      messages,
      temperature: options.temperature ?? 0.7,
      stream: true,
      ...options.extra,
    });

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content || '';
      if (delta) yield delta;
    }
  }

  async _anthropicChat(messages, options) {
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    const { apiKey, model } = this.config;

    const client = new Anthropic({ apiKey });
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
    });

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        yield event.delta.text;
      }
    }
  }
}
