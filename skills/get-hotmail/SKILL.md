---
name: get-hotmail
description: "GetHotmail 邮件收取 Skill，专用于读取 tuishoudao@hotmail.com 的最近邮件。当用户提及收取推手道邮件、查看tuishoudao邮箱、读取Hotmail邮件、看推手道有没有新邮件等操作时使用此 Skill。基于 Outlook/Hotmail IMAP 协议，使用账号密码认证。"
---

# GetHotmail 邮件收取工具

## 概述

专用于收取 `tuishoudao@hotmail.com` 的邮件，支持查看最近邮件列表、阅读正文、搜索邮件。

基于 Outlook/Hotmail IMAP 协议（`imap-mail.outlook.com:993`）。

## 脚本路径

```
~/.workbuddy/skills/get-hotmail/scripts/get_hotmail.py
```

## 前置配置（OAuth2 授权）

首次使用需要进行 OAuth2 授权：

1. 运行任意命令（如 `inbox`），脚本会显示设备授权链接和代码：
   ```bash
   python3 ~/.workbuddy/skills/get-hotmail/scripts/get_hotmail.py inbox 10
   ```

2. 在浏览器中打开显示的授权链接：https://login.microsoft.com/device

3. 输入显示的设备码（如 `HMRM3HBAF`）

4. 登录 `tuishoudao@hotmail.com` 并授予邮件访问权限

5. 授权成功后，脚本会自动保存 refresh_token，之后无需重复授权

> **注意**：微软已禁用 IMAP Basic Auth，必须使用 OAuth2 认证。

配置保存在 `~/.workbuddy/hotmail.conf`，权限 600。如需重新授权，删除该文件后重试。

---

## 命令参考

### 查看最近邮件（默认10封）

```bash
python3 ~/.workbuddy/skills/get-hotmail/scripts/get_hotmail.py inbox
python3 ~/.workbuddy/skills/get-hotmail/scripts/get_hotmail.py inbox 20
```

### 阅读指定邮件正文

```bash
# 先从 inbox 获取邮件 ID，然后：
python3 ~/.workbuddy/skills/get-hotmail/scripts/get_hotmail.py read <邮件ID>
```

### 搜索邮件

```bash
python3 ~/.workbuddy/skills/get-hotmail/scripts/get_hotmail.py search <关键词>
python3 ~/.workbuddy/skills/get-hotmail/scripts/get_hotmail.py search "师父" 20
```

### 查看配置

```bash
python3 ~/.workbuddy/skills/get-hotmail/scripts/get_hotmail.py config
```

---

## 使用流程（SOP）

1. 运行 `inbox` 命令获取最近邮件列表
2. 记录需要阅读的邮件 ID
3. 运行 `read <ID>` 查看正文
4. 将重要内容汇报给师父

## 注意事项

- 固定账号：`tuishoudao@hotmail.com`，无需在命令中指定
- 如开启两步验证，需在微软账号安全页面生成应用密码
- 正文超过 3000 字符会自动截断
- 配置文件 `~/.workbuddy/hotmail.conf` 权限为 600，保护密码安全
