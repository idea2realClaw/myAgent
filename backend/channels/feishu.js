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
    console.error('[Feishu] Failed to load config:', err.message);
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
    console.log('[Feishu] Config saved');
  } catch (err) {
    console.error('[Feishu] Failed to save config:', err.message);
  }
}

// ============================================================
// Get Tenant Access Token
// ============================================================

async function getTenantAccessToken() {
  if (tenantAccessToken && Date.now() < tokenExpireTime) {
    return tenantAccessToken;
  }

  if (!feishuConfig.appId || !feishuConfig.appSecret) {
    console.error('[Feishu] Missing credentials:', { appId: feishuConfig.appId, hasSecret: !!feishuConfig.appSecret });
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
    
    console.log('[Feishu] Calling API:', url);
    
    const req = protocol.request(url, options, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          console.log('[Feishu] Response:', result);
          
          if (result.code !== 0) {
            reject(new Error(`Failed to get access token: ${result.msg || 'Unknown error'} (code: ${result.code})`));
            return;
          }
          
          tenantAccessToken = result.tenant_access_token;
          tokenExpireTime = Date.now() + (result.expire - 300) * 1000; // 5 min buffer
          
          console.log('[Feishu] Tenant access token obtained');
          resolve(tenantAccessToken);
        } catch (err) {
          reject(new Error(`Failed to parse response: ${err.message}`));
        }
      });
    });
    
    req.on('error', (err) => {
      console.error('[Feishu] Request failed:', err.message);
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
    const data = await feishuApi('/open-apis/im/v1/messages?receive_id_type=chat_id', 'POST', body);
    console.log(`[Feishu] Message sent: ${data.data?.message_id}`);
    return data.data?.message_id;
  } catch (err) {
    console.error('[Feishu] Failed to send message:', err.message);
    throw err;
  }
}

// ============================================================
// Reply to Message
// ============================================================

async function replyMessage(messageId, text) {
  try {
    const data = await feishuApi(`/open-apis/im/v1/messages/${messageId}/reply`, 'POST', {
      content: JSON.stringify({ text }),
      msg_type: 'text',
    });
    console.log(`[Feishu] Reply sent: ${data.data?.message_id}`);
    return data.data?.message_id;
  } catch (err) {
    console.error('[Feishu] Failed to reply:', err.message);
    throw err;
  }
}

// ============================================================
// Update Message
// ============================================================

async function updateMessage(messageId, text) {
  try {
    const data = await feishuApi(`/open-apis/im/v1/messages/${messageId}`, 'PATCH', {
      content: JSON.stringify({ text }),
    });
    console.log(`[Feishu] Message updated: ${messageId}`);
    return true;
  } catch (err) {
    console.error('[Feishu] Failed to update message:', err.message);
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
  const { header, event: eventData } = event;

  // Verify token
  if (feishuConfig.verificationToken && header.token !== feishuConfig.verificationToken) {
    console.warn('[Feishu] Invalid verification token');
    return { error: 'Invalid token' };
  }

  // Handle message receive event
  if (header.event_type === 'im.message.receive_v1') {
    await handleMessageReceive(eventData);
  }

  return { success: true };
}

// Handle message receive
async function handleMessageReceive(event) {
  const senderOpenId = event.sender?.sender_id?.open_id;
  const messageId = event.message_id;
  const chatId = event.chat_id;
  const chatType = event.chat_type; // 'p2p' or 'group'
  const msgType = event.msg_type;

  let content = '';
  try {
    const parsed = JSON.parse(event.content || '{}');
    content = parsed.text || '';
  } catch {
    content = event.content || '';
  }

  // Skip empty messages or messages from self
  if (!content.trim()) {
    console.log('[Feishu] Empty message, skipping');
    return;
  }

  console.log(`[Feishu] Message from ${senderOpenId} (${chatType}): ${content}`);

  // Step 1: Reply with "思考中..." (thinking)
  let thinkingMessageId = null;
  try {
    thinkingMessageId = await replyMessage(messageId, '思考中...');
  } catch (err) {
    console.error('[Feishu] Failed to send thinking reply:', err.message);
  }

  // Step 2: Process the message through LLM
  if (messageProcessor) {
    try {
      const response = await messageProcessor(content, {
        channel: 'feishu',
        senderOpenId,
        messageId,
        chatId,
        chatType,
      });

      // Step 3: Update the "思考中..." message with the actual response
      if (thinkingMessageId && response) {
        try {
          await updateMessage(thinkingMessageId, response);
          console.log('[Feishu] Updated thinking message with response');
        } catch (err) {
          console.error('[Feishu] Failed to update thinking message:', err.message);
          // Fallback: send a new message
          await sendMessage(chatId, response);
        }
      }
    } catch (err) {
      console.error('[Feishu] Failed to process message:', err.message);
      
      // Update thinking message with error
      if (thinkingMessageId) {
        try {
          await updateMessage(thinkingMessageId, `处理失败: ${err.message}`);
        } catch { /* ignore */ }
      }
    }
  } else {
    console.warn('[Feishu] No message processor set');
    
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

      // Handle URL verification challenge
      if (event.type === 'url_verification') {
        console.log('[Feishu] URL verification challenge');
        return res.json({ challenge: event.challenge });
      }

      // Verify signature (if encrypt key is set)
      const signature = req.headers['x-lark-signature'] || req.headers['X-Lark-Signature'];
      const timestamp = req.headers['x-lark-request-timestamp'] || req.headers['X-Lark-Request-Timestamp'];
      
      if (signature && feishuConfig.encryptKey) {
        if (!verifySignature(timestamp, event, signature)) {
          console.warn('[Feishu] Invalid webhook signature');
          return res.status(403).json({ error: 'Invalid signature' });
        }
      }

      // Handle the event (async, don't wait)
      handleWebhookEvent(event).catch(err => {
        console.error('[Feishu] Event handling error:', err.message);
      });

      // Respond within 3 seconds (required by Feishu)
      res.json({ success: true });
    } catch (err) {
      console.error('[Feishu] Webhook error:', err.message);
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
