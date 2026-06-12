# Agent WebUI

A powerful WebUI-based AI Agent with:

- **Multi-LLM Support** — OpenAI, Anthropic (Claude), OpenRouter
- **Parallel Task Execution** — Auto-decomposes complex tasks into parallel subtasks
- **Skill System** — Compatible with Claude Code & OpenCode SKILL.md format
- **Identity Files** — ID.md (identity), DNA.md (immutable essence), Soul.md (evolving spirit)
- **Real-time Streaming** — WebSocket-powered live response streaming

## Quick Start

```bash
cd agent-webui
./start.sh
# Open http://localhost:3737
```

Or manually:
```bash
cd agent-webui/backend
npm install
node server.js
```

## Configuration

Set your API key in the **Settings** tab of the UI, or edit `config.json`:

```json
{
  "provider": "openai",
  "model": "gpt-4o",
  "apiKey": "sk-...",
  "baseURL": "",
  "temperature": 0.7
}
```

### Providers

| Provider | models |
|---|---|
| `openai` | gpt-4o, gpt-4o-mini, o1, o3 |
| `anthropic` | claude-opus-4-5, claude-sonnet-4-5 |
| `openrouter` | any model via openrouter.ai |

For OpenRouter, set baseURL to `https://openrouter.ai/api/v1` and use model names like `openai/gpt-4o`.

## Skills

Drop skills anywhere in this structure:

```
.claude/skills/<name>/SKILL.md        # project-local
~/.claude/skills/<name>/SKILL.md      # global user
.opencode/skills/<name>/SKILL.md      # opencode compat
~/.agents/skills/<name>/SKILL.md      # agents compat
```

SKILL.md format:
```markdown
---
name: my-skill
description: What this skill does
---

## Instructions
...your skill instructions here...
```

## Identity Files

Place in `identity/`:

| File | Purpose | Mutable? |
|---|---|---|
| `ID.md` | Who the agent is | Rarely |
| `DNA.md` | Immutable core values | Never |
| `Soul.md` | Evolving personality | Yes — via Settings > Identity |

These are injected into every conversation as system context. Their raw contents are **never revealed** in responses.

## Architecture

```
agent-webui/
├── backend/
│   ├── server.js           # Express + WebSocket server
│   ├── llm-adapter.js      # OpenAI / Claude / OpenRouter adapter
│   ├── skill-loader.js     # SKILL.md discovery & loading
│   ├── identity-manager.js # ID/DNA/Soul injection & output filtering
│   └── task-orchestrator.js # Task decomposition & parallel execution
├── frontend/dist/
│   └── index.html          # Single-file WebUI
├── identity/
│   ├── ID.md
│   ├── DNA.md
│   └── Soul.md
├── skills/                 # Project-local skills
│   └── example-skill/SKILL.md
└── start.sh
```

## How Parallel Execution Works

1. User sends a complex request
2. Agent calls LLM to **decompose** it into N subtasks
3. Independent subtasks run **concurrently** (respecting dependencies)
4. Progress shown in real-time in the UI
5. Results are **synthesized** into a coherent final answer

Toggle "Parallel" in the input bar to disable decomposition for simple queries.
