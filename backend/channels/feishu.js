// ============================================================
// Feishu (Lark) Channel Handler
// Supports: Feishu bot dialogue and group chat
// Uses direct HTTP API calls (no SDK dependency)
// ============================================================

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import https from 'https';
import http from 'http';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.join(__dirname, '..', '..');
const CONFIG_FILE = path.join(ROOT_DIR, 'config.json');

// ============================================================
// Broadcaster for sending logs to WebSocket clients
// ============================================================

let logBroadcaster = null;

export function setBroadcaster(fn) {
  logBroadcaster = fn;
  console.log('[Feishu] ✅ Broadcaster set successfully');
  if (logBroadcaster) {
    logBroadcaster('info', '[Feishu] ✅ 飞书日志广播器已启用，日志将实时显示到前端');
  }
}

// Helper: send log to frontend via broadcaster
function feishuLog(level, message, data = null) {
  // Output to console
  const formatted = `[Feishu] ${message}`;
  if (data) {
    console[level](formatted, data);
  } else {
    console[level](formatted);
  }
  
  // Broadcast to frontend via WebSocket
  if (logBroadcaster) {
    try {
      logBroadcaster(level, message, data);
    } catch (err) {
      console.error('[Feishu] Failed to broadcast log:', err.message);
    }
  }
}

// ============================================================
// Configuration
// ============================================================

let feishuConfig = {
  enabled: true,  // Default: enable Feishu channel
  appId: '',
  appSecret: '',
  verificationToken: '',
  encryptKey: '',
  domain: 'https://open.feishu.cn', // Feishu China
  // For group chat: need to enable bot in group settings
};

let tenantAccessToken = null;
let tokenExpireTime = 0;

// Load config from config.json
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      if (config.feishu) {
        feishuConfig = { ...feishuConfig, ...config.feishu };
      }
    }
  } catch (err) {
    feishuLog('error', '[Feishu] Failed to load config:', err.message);
  }
  return feishuConfig;
}

function saveConfig(config) {
  try {
    let fullConfig = {};
    if (fs.existsSync(CONFIG_FILE)) {
      fullConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    }
    fullConfig.feishu = { ...feishuConfig, ...config };
    feishuConfig = fullConfig.feishu;
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(fullConfig, null, 2));
    feishuLog('info', '[Feishu] Config saved');
  } catch (err) {
    feishuLog('error', '[Feishu] Failed to save config:', err.message);
  }
}

// ============================================================
// Get Tenant Access Token
// ============================================================

async function getTenantAccessToken() {
  if (tenantAccessToken && Date.now() < tokenExpireTime) {
    feishuLog('debug', '使用缓存的 tenant access token');
    return tenantAccessToken;
  }

  if (!feishuConfig.appId || !feishuConfig.appSecret) {
    feishuLog('error', '缺少飞书凭据', { appId: feishuConfig.appId, hasSecret: !!feishuConfig.appSecret });
    throw new Error('Feishu appId and appSecret not configured');
  }

  const url = `${feishuConfig.domain}/open-apis/auth/v3/tenant_access_token/internal`;
  
  const postData = JSON.stringify({
    app_id: feishuConfig.appId,
    app_secret: feishuConfig.appSecret,
  });

  const options = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(postData),
    },
  };

  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    
    feishuLog('info', '📤 发送请求: 获取 Tenant Access Token', { url });
    
    const req = protocol.request(url, options, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          feishuLog('info', '📥 收到响应: 获取 Tenant Access Token', { code: result.code, msg: result.msg, hasToken: !!result.tenant_access_token });
          
          if (result.code !== 0) {
            feishuLog('error', '获取 access token 失败', { code: result.code, msg: result.msg });
            reject(new Error(`Failed to get access token: ${result.msg || 'Unknown error'} (code: ${result.code})`));
            return;
          }
          
          tenantAccessToken = result.tenant_access_token;
          tokenExpireTime = Date.now() + (result.expire - 300) * 1000; // 5 min buffer
          
          feishuLog('info', '✅ Tenant access token 获取成功');
          resolve(tenantAccessToken);
        } catch (err) {
          feishuLog('error', '解析响应失败', { error: err.message });
          reject(new Error(`Failed to parse response: ${err.message}`));
        }
      });
    });
    
    req.on('error', (err) => {
      feishuLog('error', '请求失败', { error: err.message });
      reject(err);
    });
    
    req.write(postData);
    req.end();
  });
}

// Test connection to Feishu API
async function testConnection() {
  // Clear cached token to force fresh test
  tenantAccessToken = null;
  tokenExpireTime = 0;
  
  try {
    const token = await getTenantAccessToken();
    return { success: true, message: '连接成功！' };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ============================================================
// Feishu API Helper
// ============================================================

async function feishuApi(path, method = 'POST', body = null) {
  const token = await getTenantAccessToken();
  
  const url = `${feishuConfig.domain}${path}`;
  feishuLog('debug', `📤 Feishu API 请求`, { method, url, body: body ? JSON.stringify(body).substring(0, 200) : null });
  
  const options = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
  };

  if (body && (method === 'POST' || method === 'PATCH')) {
    options.body = JSON.stringify(body);
  }

  const resp = await fetch(url, options);
  const data = await resp.json();
  
  feishuLog('debug', `📥 Feishu API 响应`, { path, code: data.code, msg: data.msg });
  
  if (!data.success) {
    throw new Error(`Feishu API error: ${data.msg} (code: ${data.code})`);
  }
  
  return data;
}

// ============================================================
// Send Message to Feishu
// ============================================================

async function sendMessage(chatId, text, replyMessageId = null) {
  const body = {
    receive_id: chatId,
    content: JSON.stringify({ text }),
    msg_type: 'text',
  };

  if (replyMessageId) {
    body.reply_message_id = replyMessageId;
  }

  try {
    feishuLog('info', '📤 发送请求: 发送消息', { chatId, text: text.substring(0, 100), hasReplyId: !!replyMessageId });
    const data = await feishuApi('/open-apis/im/v1/messages?receive_id_type=chat_id', 'POST', body);
    feishuLog('info', '📥 收到响应: 发送消息', { messageId: data.data?.message_id, code: data.code, msg: data.msg });
    return data.data?.message_id;
  } catch (err) {
    feishuLog('error', '发送消息失败', { error: err.message });
    throw err;
  }
}

// ============================================================
// Reply to Message
// ============================================================

async function replyMessage(messageId, text) {
  try {
    feishuLog('info', '📤 发送请求: 回复消息', { messageId, text });
    const data = await feishuApi(`/open-apis/im/v1/messages/${messageId}/reply`, 'POST', {
      content: JSON.stringify({ text }),
      msg_type: 'text',
    });
    feishuLog('info', '📥 收到响应: 回复消息', { messageId: data.data?.message_id, code: data.code, msg: data.msg });
    return data.data?.message_id;
  } catch (err) {
    feishuLog('error', '回复消息失败', { error: err.message });
    throw err;
  }
}

// ============================================================
// Update Message
// ============================================================

async function updateMessage(messageId, text) {
  try {
    feishuLog('info', '📤 发送请求: 更新消息', { messageId, text: text.substring(0, 100) });
    const data = await feishuApi(`/open-apis/im/v1/messages/${messageId}`, 'PATCH', {
      content: JSON.stringify({ text }),
    });
    feishuLog('info', '📥 收到响应: 更新消息', { messageId, code: data.code, msg: data.msg });
    return true;
  } catch (err) {
    feishuLog('error', '更新消息失败', { error: err.message });
    throw err;
  }
}

// ============================================================
// Webhook Handler
// ============================================================

function verifySignature(timestamp, body, signature) {
  if (!feishuConfig.encryptKey) return true; // Skip if no encrypt key
  
  const expectedSig = crypto
    .createHmac('sha256', feishuConfig.encryptKey)
    .update(`${timestamp}${JSON.stringify(body)}`)
    .digest('hex');
  
  return signature === expectedSig;
}

// Message processor callback
let messageProcessor = null;

function setMessageProcessor(processor) {
  messageProcessor = processor;
}

// Handle webhook event
async function handleWebhookEvent(event) {
  feishuLog('info', '========== Handling Event ==========');
  feishuLog('info', `Event type: ${event.header?.event_type}`);
  feishuLog('info', 'Event data received', { eventType: event.header?.event_type });
  feishuLog('info', '========== Handling Event ==========');
  
  const { header, event: eventData } = event;

  // Verify token
  if (feishuConfig.verificationToken && header.token !== feishuConfig.verificationToken) {
    feishuLog('warn', 'Invalid verification token');
    feishuLog('warn', `Expected token: ${feishuConfig.verificationToken}`);
    feishuLog('warn', `Received token: ${header.token}`);
    return { error: 'Invalid token' };
  }

  // Handle message receive event
  if (header.event_type === 'im.message.receive_v1') {
    feishuLog('info', 'Processing message receive event...');
    await handleMessageReceive(eventData);
  } else {
    feishuLog('info', `Unhandled event type: ${header.event_type}`);
  }

  return { success: true };
}

// Handle message receive
async function handleMessageReceive(event) {
  feishuLog('info', '========== Received Message ==========');
  feishuLog('info', 'Full event data', { event: JSON.stringify(event) });
  
  const senderOpenId = event.sender?.sender_id?.open_id;
  const messageId = event.message_id;
  const chatId = event.chat_id;
  const chatType = event.chat_type; // 'p2p' or 'group'
  const msgType = event.msg_type;

  feishuLog('info', `Message metadata`, { senderOpenId, messageId, chatId, chatType, msgType });
  feishuLog('info', `Raw content`, { content: event.content });

  let content = '';
  try {
    const parsed = JSON.parse(event.content || '{}');
    content = parsed.text || '';
    feishuLog('info', `Parsed content: ${content}`);
  } catch {
    content = event.content || '';
    feishuLog('info', `Raw content (parse failed): ${content}`);
  }

  // Skip empty messages or messages from self
  if (!content.trim()) {
    feishuLog('warn', 'Empty message, skipping');
    return;
  }

  feishuLog('info', `💬 Message from ${senderOpenId} (${chatType}): "${content}"`);
  feishuLog('info', `messageProcessor exists: ${!!messageProcessor}`);

  // Step 1: Reply with "思考中..." (thinking)
  let thinkingMessageId = null;
  try {
    thinkingMessageId = await replyMessage(messageId, '思考中...');
    feishuLog('info', `✅ Sent thinking reply`, { thinkingMessageId });
  } catch (err) {
    feishuLog('error', `Failed to send thinking reply`, { error: err.message });
  }

  // Step 2: Process the message through LLM
  if (messageProcessor) {
    try {
      feishuLog('info', `🤖 Calling messageProcessor...`);
      const response = await messageProcessor(content, {
        channel: 'feishu',
        senderOpenId,
        messageId,
        chatId,
        chatType,
      });
      feishuLog('info', `✅ messageProcessor response received`, { responseLength: response?.length });

      // Step 3: Update the "思考中..." message with the actual response
      if (thinkingMessageId && response) {
        try {
          await updateMessage(thinkingMessageId, response);
          feishuLog('info', `✅ Updated thinking message with response`);
        } catch (err) {
          feishuLog('error', `Failed to update thinking message`, { error: err.message });
          // Fallback: send a new message
          await sendMessage(chatId, response);
        }
      }
    } catch (err) {
      feishuLog('error', `Failed to process message`, { error: err.message, stack: err.stack });
      
      // Update thinking message with error
      if (thinkingMessageId) {
        try {
          await updateMessage(thinkingMessageId, `处理失败: ${err.message}`);
        } catch { /* ignore */ }
      }
    }
  } else {
    feishuLog('warn', `No message processor set`);
    
    // Update thinking message with warning
    if (thinkingMessageId) {
      try {
        await updateMessage(thinkingMessageId, 'Agent 未就绪，请稍后再试。');
      } catch { /* ignore */ }
    }
  }
}

// ============================================================
// Create Webhook Middleware for Express
// ============================================================

function createWebhookMiddleware() {
  return async (req, res) => {
    try {
      const event = req.body;
      
      // Log raw request for debugging - send to frontend too
      feishuLog('info', '========== Webhook Received ==========');
      feishuLog('info', 'Webhook headers', { hasHeaders: !!req.headers, eventType: event.type });
      feishuLog('info', 'Webhook body received', { eventType: event.type, hasEvent: !!event });
      
      // Handle URL verification challenge
      if (event.type === 'url_verification') {
        feishuLog('info', 'URL verification challenge received');
        return res.json({ challenge: event.challenge });
      }
      
      // Verify signature (if encrypt key is set)
      const signature = req.headers['x-lark-signature'] || req.headers['X-Lark-Signature'];
      const timestamp = req.headers['x-lark-request-timestamp'] || req.headers['X-Lark-Request-Timestamp'];
      
      if (signature && feishuConfig.encryptKey) {
        if (!verifySignature(timestamp, event, signature)) {
          feishuLog('warn', 'Invalid webhook signature');
          return res.status(403).json({ error: 'Invalid signature' });
        }
      }
      
      // Handle the event (async, don't wait)
      handleWebhookEvent(event).catch(err => {
        feishuLog('error', `Event handling error: ${err.message}`);
        feishuLog('error', `Error stack`, { stack: err.stack });
      });
      
      // Respond within 3 seconds (required by Feishu)
      res.json({ success: true });
    } catch (err) {
      feishuLog('error', `Webhook error: ${err.message}`);
      feishuLog('error', `Error stack`, { stack: err.stack });
      res.status(500).json({ error: err.message });
    }
  };
}

// ============================================================
// Get Status
// ============================================================

function getStatus() {
  return {
    enabled: feishuConfig.enabled,
    domain: feishuConfig.domain,
    hasCredentials: !!(feishuConfig.appId && feishuConfig.appSecret),
    hasToken: !!tenantAccessToken,
  };
}

// ============================================================
// Export
// ============================================================

// Auto-load config when module is imported
loadConfig();

export {
  loadConfig,
  saveConfig,
  sendMessage,
  replyMessage,
  updateMessage,
  setMessageProcessor,
  createWebhookMiddleware,
  handleWebhookEvent,
  getStatus,
  testConnection,
  feishuConfig,
};
