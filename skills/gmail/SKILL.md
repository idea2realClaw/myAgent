---
name: gmail
description: "Gmail 邮件处理 Skill，支持通过命令行收发邮件、搜索邮件、回复邮件。当用户提及发邮件、收邮件、查看收件箱、搜索邮件、回复邮件、给某人写邮件、检查邮箱等操作时，使用此 Skill。基于 Gmail SMTP/IMAP 协议，使用应用专用密码认证。"
---

# Gmail 邮件工具

## 概述

通过 Gmail SMTP 和 IMAP 协议，在命令行中收发邮件。无需浏览器，支持附件。

## 前置要求

### 生成 Gmail 应用专用密码

1. 访问 https://myaccount.google.com/apppasswords
2. 登录 Google 账号
3. 应用选择「邮件」，设备选择「其他」，输入名称（如 WorkBuddy）
4. 点击「生成」，复制 16 位密码（去掉空格）

### 首次配置

```bash
GMAIL="python3 ~/.workbuddy/skills/gmail/scripts/gmail_tool.py"

$GMAIL config set email yourname@gmail.com
$GMAIL config set app_password xxxx xxxx xxxx xxxx
```

配置文件保存在 `~/.workbuddy/gmail.conf`，权限设为 600（仅用户可读）。

---

## 命令参考

脚本路径：`~/.workbuddy/skills/gmail/scripts/gmail_tool.py`

### 发送邮件

```bash
# 基本发送
python3 gmail_tool.py send <收件人> <主题> <正文>

# 正文来自文件
python3 gmail_tool.py send someone@example.com "汇报" /path/to/content.txt

# 带附件
python3 gmail_tool.py send someone@example.com "资料" "请查收附件" /path/to/file.pdf /path/to/image.png
```

### 查看收件箱

```bash
# 查看最新 10 封（默认）
python3 gmail_tool.py inbox

# 查看最新 20 封
python3 gmail_tool.py inbox 20
```

### 阅读邮件

```bash
# 先从 inbox 命令获取邮件 ID，然后：
python3 gmail_tool.py read <邮件ID>
```

### 搜索邮件

```bash
# 按关键词搜索（搜索主题和发件人）
python3 gmail_tool.py search <关键词>

python3 gmail_tool.py search "龙族" 20
```

### 回复邮件

```bash
# 回复指定邮件
python3 gmail_tool.py reply <邮件ID> <回复内容>

# 回复内容来自文件
python3 gmail_tool.py reply <邮件ID> /path/to/reply.txt
```

### 查看配置

```bash
python3 gmail_tool.py config
```

---

## 注意事项

- 仅支持 Gmail 邮箱
- 必须使用应用专用密码，不支持普通登录密码
- Google 账号需开启两步验证才能生成应用专用密码
- 附件支持任意文件类型
- 邮件正文超过 3000 字符时会自动截断显示
- 配置文件 `~/.workbuddy/gmail.conf` 权限为 600，保护密码安全
