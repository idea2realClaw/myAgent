---
name: shared-secret-crypto
description: "用于处理以共享密钥加密的密码、API Key、Token 等敏感字符串。当用户提供 `crypto.html` 生成的密文、提到 CryptoJS AES、`U2FsdGVkX1` 开头的字符串，或要求先解密密钥再执行 Gmail/API/登录等操作时，应使用此 Skill。"
---

# Shared Secret Crypto

## 概述

封装与 `C:\Users\zhuxi\WorkBuddy\Claw\crypto-tool\crypto.html` 兼容的 CryptoJS AES(passphrase) 加解密流程。

用于在本地安全处理密码、API Key、Token 等敏感信息：先解密，再立即用于后续任务，默认不把明文写入文件、脚本默认值、配置文件或公开回复。

## 适用场景

在以下场景触发本 Skill：

- 用户提供一段密文，并说明是用 `crypto.html` 或 CryptoJS AES 加密的
- 用户提到共享密钥、加密密码、加密后的 API Key、加密后的 Token
- 用户给出以 `U2FsdGVkX1` 开头的字符串，要求解密后继续登录、发请求、读取邮箱或调用接口
- 用户要求先把明文加密，再返回密文以便后续安全传递

## 工作流程

### 1. 确认任务类型

先判断当前任务属于以下哪一类：

- **解密并立即使用**：例如读取 Gmail、调用 API、登录网站、连接服务
- **仅解密查看**：例如师父要确认密码或检查某个密文内容
- **加密后返回**：例如把新的密码、API Key 或 Token 加密给师父保存

### 2. 获取共享密钥

优先读取长期记忆中的共享密钥。

- 若记忆中已有共享密钥，直接使用
- 若没有，再向用户索取
- 除非用户明确要求，否则不要在普通回复中重复输出共享密钥全文

### 3. 优先使用本地脚本处理

优先调用：

`C:\Users\zhuxi\.workbuddy\skills\shared-secret-crypto\scripts\crypto_secret.py`

示例：

```bash
python C:\Users\zhuxi\.workbuddy\skills\shared-secret-crypto\scripts\crypto_secret.py decrypt --cipher "U2FsdGVkX1..." --key "<共享密钥>"
```

```bash
python C:\Users\zhuxi\.workbuddy\skills\shared-secret-crypto\scripts\crypto_secret.py encrypt --text "my-secret-value" --key "<共享密钥>"
```

### 4. 解密后立刻执行后续任务

若用户的真实目标不是“看明文”，而是“用明文做事”，则按以下原则处理：

- 解密后直接继续执行目标操作
- 只在确有必要时展示明文
- 默认只回报任务结果，不回显完整密码、API Key 或 Token
- 若需要写入配置文件或环境变量，先确认用户意图

### 5. 严格遵守安全边界

- 不把明文写入脚本默认值
- 不把明文写入公开帖子、论坛、网页、报告或普通日志
- 不把明文存入长期记忆，除非用户明确要求记住该明文
- 若用户只要求“使用”密钥，则只执行任务，不额外泄露密钥内容

## 快速判断规则

### 看到这些信号时，直接想到本 Skill

- `crypto.html`
- `CryptoJS.AES.encrypt`
- `CryptoJS.AES.decrypt`
- `U2FsdGVkX1`
- “共享密钥”
- “加密后的密码”
- “加密后的 API key”
- “帮我先解密再用”

### 常见工作模式

1. **Gmail 邮件场景**
   - 先解密应用专用密码
   - 立即登录 IMAP/SMTP
   - 返回收件箱摘要或发送结果
   - 不把应用专用密码写入 `gmail.conf`，除非用户明确要求落盘

2. **API 调用场景**
   - 先解密 API Key / Token
   - 立即发起请求
   - 返回接口结果摘要
   - 默认隐藏完整凭证

3. **账号登录场景**
   - 先解密密码
   - 仅用于本次登录或自动化操作
   - 不把密码写回脚本默认值或公开页面

## 资源

### 脚本

- `scripts/crypto_secret.py`
  - 与 `crypto.html` 兼容的 CryptoJS/OpenSSL 风格 AES(passphrase) 加解密脚本
  - 支持 `encrypt` / `decrypt` 两个子命令

### 参考文档

- `references/workflow.md`
  - 收录兼容格式说明、常见调用样例、安全注意事项与故障排查
