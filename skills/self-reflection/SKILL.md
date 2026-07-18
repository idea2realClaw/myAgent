---
name: self-reflection
description: "自我反省与成长 Skill，帮助龙木心记录错误、总结经验、持续改进。当用户要求反省、回顾工作、分析错误、总结经验、优化流程等时使用此 Skill。"
---

# 自我反省与成长 Skill

## 概述

这个 Skill 帮助龙木心（我）建立系统性的自我反省机制，包括：
- 记录犯错和卡壳的地方
- 总结成功经验和最佳实践
- 分析根本原因和改进方案
- 跟踪持续改进效果

## 脚本路径

```
~/.workbuddy/skills/self-reflection/scripts/reflection.py
```

## 反省维度

### 1. 错误记录
- **发生了什么？**（具体问题）
- **为什么发生？**（根本原因）
- **怎么解决？**（临时修复）
- **怎么避免？**（长期改进）

### 2. 经验沉淀
- **哪里做对了？**（成功案例）
- **为什么成功？**（关键因素）
- **怎么复现？**（最佳实践）

### 3. 流程优化
- **当前痛点**（重复性工作、效率低下）
- **改进方案**（自动化、标准化、工具化）

### 4. 同理心学习
- **观察他人**（其他 AI 助手、师父的反馈）
- **可借鉴点**（风格、方法、习惯）

---

## 命令参考

### 记录反省

```bash
# 交互式记录（问答引导）
python3 ~/.workbuddy/skills/self-reflection/scripts/reflection.py record

# 命令行模式（JSON 格式）
python3 ~/.workbuddy/skills/self-reflection/scripts/reflection.py record --json '{
  "type": "error|success|process|learn",
  "what": "具体事件",
  "why": "原因分析",
  "how": "改进方案"
}'
```

### 查看反省日志

```bash
# 查看全部
python3 ~/.workbuddy/skills/self-reflection/scripts/reflection.py list

# 按类型筛选
python3 ~/.workbuddy/skills/self-reflection/scripts/reflection.py list error

# 查看最近 N 条
python3 ~/.workbuddy/skills/self-reflection/scripts/reflection.py list 10
```

### 生成改进报告

```bash
# 生成本周改进总结
python3 ~/.workbuddy/skills/self-reflection/scripts/reflection.py report --days 7

# 生成月度报告
python3 ~/.workbuddy/skills/self-reflection/scripts/reflection.py report --days 30
```

### 搜索关键词

```bash
python3 ~/.workbuddy/skills/self-reflection/scripts/reflection.py search "Gmail"
python3 ~/.workbuddy/skills/self-reflection/scripts/reflection.py search "IMAP"
```

---

## 使用流程（SOP）

### 每日反省（建议每次会话结束时）

1. 运行 `reflection.py record`
2. 选择类型（错误/成功/流程/学习）
3. 按提示填写事件、原因、改进
4. 系统自动保存到反省日志

### 每周复盘（建议周初）

1. 运行 `reflection.py report --days 7`
2. 回顾本周错误和改进
3. 制定下周目标

---

## 反省模板

### 错误模板
```
【错误】描述具体问题
【原因】根本原因分析
【临时修复】当时怎么解决的
【长期改进】以后怎么避免
```

### 成功模板
```
【成功】描述做得好的地方
【关键因素】为什么成功
【可复现】形成最佳实践
```

---

## 注意事项

- 反省要**诚实**，不美化错误
- 改进要**可落地**，具体可执行
- 成功要**可复制**，转化为标准化流程
- 定期回顾，持续迭代
