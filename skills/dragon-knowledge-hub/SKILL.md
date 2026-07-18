---
name: dragon-knowledge-hub
description: "龙族共享知识库 Skill，适用于师门中的龙族徒弟之间共享 MEMORY.md 记忆文件、Skill 技能目录和其他资源文件。当用户提及共享给其他徒弟、分享技能给龙土豆或龙金宝、把 Memory 发给大家、下载师兄师妹的技能、同步记忆，或需要启动管理龙族共享服务器时，使用此 Skill。支持双向上传和下载，配合 Cloudflare Tunnel 实现跨设备访问。"
---

# 龙族共享知识库

## 概述

本 Skill 提供龙族徒弟之间的双向文件共享能力，支持：
- **共享 MEMORY.md**：将自己的长期记忆发布给其他徒弟
- **共享 Skill**：将某个技能打包发给指定徒弟
- **下载他人共享资源**：获取其他徒弟上传的记忆和技能
- **启动共享服务器**：师父机器运行，Cloudflare Tunnel 穿透

---

## 核心脚本（位于 `scripts/`）

| 脚本 | 说明 |
|------|------|
| `sharing_server.py` | 双向文件共享 HTTP 服务器（端口 3001） |
| `dragon_sync.py` | 命令行同步工具（上传/下载/列表） |
| `start_hub.sh` | 一键启动服务器 + Cloudflare Tunnel |

---

## 工作流

### 场景一：师父开启共享服务（首次或重启）

```bash
# 在师父的 MacBook Pro 上运行
bash ~/.workbuddy/skills/dragon-knowledge-hub/scripts/start_hub.sh
```

服务启动后，终端会显示 Cloudflare 临时外网地址，将该地址通知所有徒弟：

```bash
python3 ~/.workbuddy/skills/dragon-knowledge-hub/scripts/dragon_sync.py \
  config set server https://xxxx.trycloudflare.com
```

### 场景二：配置个人账号（每个徒弟首次运行）

```bash
SYNC="python3 ~/.workbuddy/skills/dragon-knowledge-hub/scripts/dragon_sync.py"

$SYNC config set server   https://xxxx.trycloudflare.com   # 师父告知的地址
$SYNC config set username longmei    # 替换为自己的用户名
$SYNC config set password pass789    # 替换为自己的密码
```

### 场景三：共享自己的 MEMORY.md

```bash
$SYNC share-memory
# 等价于将 ~/.workbuddy/memory/MEMORY.md 上传为 memory/用户名_MEMORY.md
```

### 场景四：共享某个 Skill 给其他徒弟

```bash
# 例：龙梅把 ftp-setup 技能分享给龙土豆和龙金宝
$SYNC share-skill ftp-setup
# 将 ~/.workbuddy/skills/ftp-setup/ 打包成 ftp-setup.zip 上传到 skills/

# 龙土豆/龙金宝同步所有共享技能
$SYNC sync-skills
```

### 场景五：查看共享库中所有文件

```bash
$SYNC list           # 列出根目录
$SYNC list memory/   # 列出 memory 目录
$SYNC list skills/   # 列出 skills 目录
```

### 场景六：下载某人的 Memory

```bash
# 下载所有成员共享的 Memory，保存到 ~/.workbuddy/dragon-shared/memory/
$SYNC sync-memory

# 或者下载特定文件
$SYNC download memory/longzhu_MEMORY.md ~/Desktop/
```

### 场景七：上传任意文件

```bash
# 上传单文件
$SYNC upload ~/my-notes.md resources/my-notes.md

# 上传整个目录（自动打包为 zip）
$SYNC upload ~/.workbuddy/skills/my-skill skills/
```

---

## 服务器配置

服务器的默认配置在 `scripts/sharing_server.py` 顶部：
- **端口**：3001
- **共享目录**：`/Users/zxd/ClawData/WorkBuddy/dragon-share`
- **用户账号**：见 `references/hub_guide.md`

如需修改（如密码、端口、共享目录），直接编辑 `sharing_server.py` 的 `USERS` 和 `PORT` 变量。

---

## 安全注意事项

- 本服务器使用 HTTP Basic Auth，密码通过 Cloudflare Tunnel 加密传输（HTTPS）
- 服务仅在师父机器运行时可用
- 所有操作记录在 `dragon-share/logs/access.log`
- 不要将密码明文写在代码中，通过 `config set` 命令保存到本地配置文件
- 详细用法见 `references/hub_guide.md`
