---
name: example-skill
description: An example skill demonstrating the SKILL.md format compatible with Claude Code and OpenCode
license: MIT
compatibility: opencode,claude,agent-webui
---

## What I Do

This is an example skill. When loaded, I provide structured guidance on a specific task.

## When to Use Me

Use me as a template to understand the SKILL.md format, or as a placeholder when building new skills.

## Instructions

1. Create a folder under `.claude/skills/<skill-name>/` or `~/.claude/skills/<skill-name>/`
2. Create a `SKILL.md` file with YAML frontmatter (`name` and `description` required)
3. Write your skill instructions in Markdown below the frontmatter
4. The agent will discover and load your skill automatically

## Example Skills to Create

- `code-review` — review code for quality and bugs
- `git-release` — create consistent release notes
- `api-docs` — generate API documentation
- `test-writer` — write comprehensive tests

## Format Reference

```yaml
---
name: my-skill-name
description: What this skill does (shown in skill list)
---
```

Then add your instructions below.
