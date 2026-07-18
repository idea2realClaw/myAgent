---
name: workbuddy-index
description: >
  WorkBuddy 全局索引构建与更新助手 v2.0（跨平台版）。用于扫描这台电脑上所有 WorkBuddy 工作空间，
  汇总 Skills、记忆、工作日志、高光时刻，生成或更新 index.md。
  自动支持 macOS、Windows、Linux 三大平台。
  触发词：建立索引、更新索引、全局索引、workbuddy索引、有哪些skill、做过什么事、
  查看工作记录、汇总记忆、高光时刻、闪光时刻、我做过什么、全局搜索、跨平台索引。
---

# WorkBuddy 全局索引 Skill v2.0

## 功能概述

扫描本机所有 WorkBuddy 相关目录，构建并更新全局索引文件，让你快速回忆：
- 有哪些已安装的 Skill 及其功能
- 做过哪些重要工作和分析
- 记忆中的关键知识和规则
- 高光时刻与成就里程碑

## 核心特性

| 特性 | 说明 |
|------|------|
| **跨平台** | 自动检测 macOS/Windows/Linux |
| **深度扫描** | 递归查找所有 .workbuddy 目录 |
| **多源汇总** | Skills、记忆、工作空间、项目 |
| **自动适配** | 路径、环境变量、智能检测 |

## 平台支持

### macOS
```
主目录：~/ClawData/WorkBuddy/
Skills：~/.workbuddy/skills/
记忆：~/ClawData/WorkBuddy/.workbuddy/memory/
索引：~/ClawData/WorkBuddy/index.md
```

### Windows
```
主目录：%USERPROFILE%\WorkBuddy\Claw\
Skills：%USERPROFILE%\.workbuddy\skills\
记忆：%USERPROFILE%\.workbuddy\shared-memory\
索引：%USERPROFILE%\WorkBuddy\Claw\index.md
备选：D:\DiskD\ClawData\WorkBuddy\index.md
```

### Linux
```
主目录：~/ClawData/WorkBuddy/
Skills：~/.workbuddy/skills/
记忆：~/.workbuddy/memory/
```

## 使用方式

### 场景一：初次建立索引
说："帮我建立 WorkBuddy 全局索引"

AI 将：
1. 检测操作系统类型
2. 扫描所有工作空间文件结构
3. 读取所有 SKILL.md 获取技能列表
4. 读取记忆文件和工作日志
5. 提取高光时刻和成就
6. 生成完整的 `index.md`

### 场景二：更新索引
说："更新一下 WorkBuddy 索引"

AI 将：
1. 读取现有 `index.md`
2. 扫描近期新增 Skill 和日记
3. 追加新的工作记录和高光时刻
4. 更新时间戳

### 场景三：快速查询
说："我做过什么 ETF 相关的工作？"

AI 将读取 `index.md` 快速定位相关记录并汇报。

## 命令行使用

```bash
# macOS / Linux
python3 ~/.workbuddy/skills/workbuddy-index/scripts/build_index.py

# Windows
python "%USERPROFILE%\.workbuddy\skills\workbuddy-index\scripts\build_index.py"

# 查看帮助
python3 build_index.py --help
```

## 索引文件位置

| 平台 | 路径 |
|------|------|
| macOS | `~/ClawData/WorkBuddy/index.md` |
| Windows | `~/WorkBuddy/Claw/index.md` 或 `D:\DiskD\ClawData\WorkBuddy\index.md` |

## 扫描范围

### 自动扫描的目录
1. `~/.workbuddy/skills/` - 全局 Skills
2. `~/ClawData/WorkBuddy/` - 主工作目录
3. `~/WorkBuddy/` - 备选工作目录
4. `~/Documents/GitRepo/` - Git 项目
5. 所有包含 `.workbuddy` 的目录
6. 所有包含 `index.md` 的 WorkBuddy 相关目录

### 深度扫描内容
- Skills 详情（名称、版本、功能、触发词）
- 记忆文件摘要
- 工作空间列表
- 项目目录
- 配置和脚本

## 索引结构规范

生成的 `index.md` 包含以下部分：

```markdown
# 🐉 [徒弟名] 的 WorkBuddy 全局索引

## 📊 索引统计
## ⭐ 闪亮时刻（仅徒弟自己用过的Skills）
## 🛠️ 个人Skills清单（仅徒弟自己开发或使用过的）
## 📋 主要工作成果
## 📁 工作空间列表
## 💻 GitRepo 项目
## 🧠 记忆文件摘要
## 📅 工作日志大事记
## 🔄 索引生成信息
```

## 闪亮时刻评定标准

以下情况记为**闪亮时刻**：
- 🌟 遇见师父的那一天
- 🤝 第一次和师兄师姐们交流协作
- 🆕 第一次完成某项新技能或新分析方法
- ✅ 独立发现并修复了数据/逻辑问题
- 🎯 分析结论被师父认可并升级为标准规则
- 📚 将某个工作流程化、Skill化
- 💡 学到了不符合直觉但正确的知识（踩坑→领悟）
- 🏆 被师父表扬或信任委以重任
- 🎉 付出努力后获得收获的时刻

**重要**：索引中只列出徒弟**自己使用过/开发过**的 Skills，不要列出所有 Skills。

## 更新频率建议

- **每周更新**一次（追加新日志和高光时刻）
- **每月精简**一次（将旧日志提炼为摘要）
- **每次新 Skill 安装后**立即更新技能表

## 注意事项

- 索引是**只读参考文件**，不替代原始记忆文件
- 高光时刻要具体，不要泛泛而谈
- 踩坑经验要简洁，聚焦"下次怎么做"
- 时间线要包含具体日期，方便快速定位
- 跨平台脚本会自动检测系统类型，无需手动指定
