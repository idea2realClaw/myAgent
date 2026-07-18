---
name: qualcomm-ima
description: "在腾讯ima的高通开源资料库中搜索和获取高通官方资料。触发词：高通资料、高通开源、Qualcomm、RADXA、QCS6490、Snapdragon X Elite、AI Hub、ima知识库、Radxa使用、SSH连接Radxa"
---

# Qualcomm IMA 高通开源资料库问答

## 概述

在腾讯ima的高通开源资料库中搜索答案。该知识库包含45个内容，涵盖：
- QAI AppBuilder
- 高通硬件资料
- Qualcomm AI Hub 文档
- AIhub 转模型笔记

## 知识库信息

| 项目 | 内容 |
|------|------|
| **知识库ID** | 7437325709611728 |
| **订阅数** | 18人 |
| **创建者** | 图难于易 |

## 核心方法

### 1. Playwright CLI + 持久化登录

使用Playwright CLI浏览器自动化，通过URL参数传入问题：
```bash
# 通过URL参数传入问题
question_url="${BASE_URL}&question=${encoded_question}"
playwright-cli goto "$question_url"
```

### 2. 持久化浏览器配置

设置 `--user-data-dir` 保存登录状态，首次微信扫码后无需再次登录：
```bash
export PLAYWRIGHT_CHROMIUM_USER_DATA_DIR="$HOME/.workbuddy/playwright-ima-profile"
```

### 3. 微信扫码登录

首次使用需要微信扫码登录，登录状态自动保存到profile目录。

## 使用方法

### 首次使用（初始化）

```bash
# 1. 初始化浏览器并扫码登录
python3 ~/.workbuddy/skills/qualcomm-ima/scripts/ask_ima.sh --setup

# 2. 用微信扫码登录ima.qq.com
```

### 日常使用

```bash
# 提问
python3 ~/.workbuddy/skills/qualcomm-ima/scripts/ask_ima.sh "怎么使用Radxa D6a"
python3 ~/.workbuddy/skills/qualcomm-ima/scripts/ask_ima.sh "QCS6490 NPU Spec"
python3 ~/.workbuddy/skills/qualcomm-ima/scripts/ask_ima.sh "Snapdragon X Elite性能"
python3 ~/.workbuddy/skills/qualcomm-ima/scripts/ask_ima.sh "怎么通过SSH连接Radxa"

# 查看当前页面
python3 ~/.workbuddy/skills/qualcomm-ima/scripts/ask_ima.sh --snapshot

# 截图
python3 ~/.workbuddy/skills/qualcomm-ima/scripts/ask_ima.sh --screenshot
```

## 推荐问题

- QCS6490 NPU Spec？
- Snapdragon X Elite NPU Spec？
- what's QAI Appbuilder
- 怎么使用Radxa D6a？
- 怎么通过SSH连接Radxa板子？
- Qualcomm AI Hub使用方法

## 文件结构

```
qualcomm-ima/
├── SKILL.md                    # 本文档
└── scripts/
    └── ask_ima.sh              # 问答应脚本
```

## 依赖

- [x] playwright-cli: `npm install -g playwright-cli`
- [x] Playwright浏览器驱动: `playwright install chromium`

## 注意事项

1. **首次登录**：必须微信扫码登录一次
2. **登录持久化**：状态保存在 `~/.workbuddy/playwright-ima-profile/`
3. **等待时间**：问题加载后等待约5秒获取回答
4. **网络要求**：需要能访问腾讯ima服务

## 技术要点

### 关键实现

1. **URL参数传问题**：使用 `question=` 参数直接传入问题
2. **持久化profile**：保存浏览器cookie和登录状态
3. **Playwright CLI**：轻量级命令行浏览器自动化工具

### Playwright CLI常用命令

```bash
playwright-cli goto <url>          # 访问页面
playwright-cli snapshot             # 获取页面快照
playwright-cli screenshot           # 截图
playwright-cli click <selector>     # 点击元素
playwright-cli fill <selector> <text>  # 填写表单
```

---

> 龙木心整理 | 2026-04-19
