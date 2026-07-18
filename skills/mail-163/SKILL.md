---
name: mail-163
description: "163 邮箱邮件处理 Skill，支持通过 Python 脚本收发邮件、查看收件箱、读取邮件、搜索邮件和回复邮件。当用户提及 163 邮箱、网易邮箱、imap.163.com、smtp.163.com、收 163 邮件、读 163 邮件、发送 163 邮件，或给出加密后的 163 授权码让助手先解密再使用时，使用此 Skill。"
---

# 163 邮箱邮件工具

## 概述

通过 163 邮箱的 IMAP / SMTP 协议，在命令行中收邮件、读正文、发邮件、搜索和回复邮件。

默认使用 `imap.163.com:993` 与 `smtp.163.com:465` 的 SSL 连接，并兼容“临时凭证直传”与“本地配置文件”两种使用方式。

## 适用场景

当出现以下需求时，触发本 Skill：

- 用户要查看 163 邮箱最近邮件
- 用户要打开某封 163 邮件正文
- 用户要搜索、回复或发送 163 邮件
- 用户给出 `@163.com` 邮箱和授权码，要求直接收邮件
- 用户给出加密后的 163 授权码，要求先解密再读取邮箱

## 工作流程

### 1. 确认认证方式

优先区分当前属于哪一种：

1. **临时使用**
   - 用户直接给邮箱地址和授权码
   - 或用户给邮箱地址和加密后的授权码
   - 优先走命令行参数：不落盘，用完即止

2. **长期配置**
   - 用户明确要求把邮箱地址和授权码写入本地配置
   - 使用 `config set` 保存到 `~/.workbuddy/mail163.conf`

### 2. 若用户给的是加密后的授权码

先调用共享密钥加解密流程处理，再立即执行 163 邮件脚本。

推荐做法：

1. 先用 `shared-secret-crypto` 解密密文
2. 不在普通回复中回显完整明文
3. 优先把明文作为命令行参数 `--auth-code` 传给脚本
4. 除非用户明确要求，否则不要把明文写入 `mail163.conf`

### 3. 调用脚本

主脚本：`C:\Users\zhuxi\.workbuddy\skills\mail-163\scripts\mail163_tool.py`

#### 临时凭证模式（推荐）

```bash
python mail163_tool.py --email yourname@163.com --auth-code xxxxx inbox
python mail163_tool.py --email yourname@163.com --auth-code xxxxx read 1234
python mail163_tool.py --email yourname@163.com --auth-code xxxxx send someone@example.com "主题" "正文"
```

#### 本地配置模式

```bash
python mail163_tool.py config set email yourname@163.com
python mail163_tool.py config set auth_code xxxxxxxxxxxxxxxx
python mail163_tool.py inbox
```

## 命令参考

### 查看收件箱

```bash
python mail163_tool.py inbox
python mail163_tool.py inbox 20
```

### 阅读邮件

```bash
python mail163_tool.py read <邮件ID>
```

### 搜索邮件

```bash
python mail163_tool.py search <关键词>
python mail163_tool.py search "发票" 20
```

### 回复邮件

```bash
python mail163_tool.py reply <邮件ID> <回复内容>
python mail163_tool.py reply <邮件ID> /path/to/reply.txt
```

### 发送邮件

```bash
python mail163_tool.py send someone@example.com "主题" "正文"
python mail163_tool.py send someone@example.com "资料" "请查收附件" /path/to/file.zip
```

### 查看或设置配置

```bash
python mail163_tool.py config
python mail163_tool.py config set email yourname@163.com
python mail163_tool.py config set auth_code xxxxxxxxxxxxxxxx
```

## 注意事项

- 163 邮箱第三方客户端登录应使用“客户端授权码”，不要直接使用网页登录密码
- IMAP 推荐用于收件箱同步；脚本默认使用 IMAP
- 默认优先采用临时凭证模式，减少明文落盘风险
- 邮件正文超过 3000 字符时会自动截断显示
- 若搜索中文关键词失败，可改为先列出收件箱再按邮件 ID 阅读

## 资源

- `scripts/mail163_tool.py`
  - 163 邮箱 Python 脚本，支持 `send / inbox / read / search / reply / config`
- `references/workflow.md`
  - 收录官方服务器配置、授权码要求、与共享密钥解密流程配合方式、常见故障排查
