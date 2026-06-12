# Agent WebUI

[![Version](https://img.shields.io/github/v/release/idea2realClaw/myAgent?label=version)](https://github.com/idea2realClaw/myAgent/releases)
[![License: MIT](https://img.shields.io/github/license/idea2realClaw/myAgent)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E18-green)](https://nodejs.org/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen)](https://github.com/idea2realClaw/myAgent/pulls)
[![GitHub Issues](https://img.shields.io/github/issues/idea2realClaw/myAgent)](https://github.com/idea2realClaw/myAgent/issues)

A powerful WebUI-based AI Agent with:

- **Multi-LLM Support** — OpenAI, Anthropic (Claude), OpenRouter
- **Parallel Task Execution** — Auto-decomposes complex tasks into parallel subtasks
- **Skill System** — Compatible with Claude Code & OpenCode SKILL.md format
- **Identity Files** — ID.md (identity), DNA.md (immutable essence), Soul.md (evolving spirit)
- **Real-time Streaming** — WebSocket-powered live response streaming

[🚀 Live Demo](https://idea2realClaw.github.io/myAgent/) | [📖 Documentation](#configuration) | [🐛 Report Bug](https://github.com/idea2realClaw/myAgent/issues)

---

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
  "provider": "openrouter",
  "model": "nvidia/nemotron-3-super-120b-a12b:free",
  "apiKey": "sk-...",
  "baseURL": "https://openrouter.ai/api/v1",
  "temperature": 0.7
}
```

### Providers

| Provider | Models |
|---|---|
| `openai` | gpt-4o, gpt-4o-mini, o1, o3 |
| `anthropic` | claude-opus-4-5, claude-sonnet-4-5 |
| `openrouter` | any model via openrouter.ai |

For OpenRouter, set baseURL to `https://openrouter.ai/api/v1` and use model names like `openai/gpt-4o` or `nvidia/nemotron-3-super-120b-a12b:free`.

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

## Development

```bash
# Clone the repo
git clone https://github.com/idea2realClaw/myAgent.git
cd myAgent

# Install dependencies
cd backend && npm install

# Start development server
npm run dev
```

## Contributing

PRs are welcome! Please:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is licensed under the MIT License — see [LICENSE](LICENSE) for details.

## Star History

If you find this project useful, please consider giving it a star! ⭐

[![Star History Chart](https://api.star-history.com/svg?repos=idea2realClaw/myAgent&type=Date)](https://star-history.com/#idea2realClaw/myAgent&Date)

---

**Built with ❤️ by [idea2realClaw](https://github.com/idea2realClaw)**
