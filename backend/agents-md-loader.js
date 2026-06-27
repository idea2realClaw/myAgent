// ============================================================
// AGENTS.md Loader — Project-specific rules for the agent
// Inspired by OpenCode's /init command and AGENTS.md support
// ============================================================

import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = path.join(__dirname, '..');
const AGENTS_MD_PATH = path.join(WORKSPACE_ROOT, 'AGENTS.md');

const AGENTS_MD_TEMPLATE = `# AGENTS.md — Project Rules for AI Agents

## Project Overview

This project is a custom AI agent built on Node.js + Express + WebSocket.

## Tech Stack

- Backend: Node.js ESM, Express, WebSocket (ws)
- Frontend: Single-file HTML, vanilla JS, marked.js
- Architecture: Multi-provider LLM, parallel task decomposition, tool execution

## Coding Conventions

- Use English for code and comments
- Use Chinese for user-facing documentation and UI labels
- Prefer clear, direct implementations over clever abstractions
- Add error handling for all async operations
- Keep functions focused and modular

## Common Commands

- Start server: \`./start.sh start\`
- Restart server: \`./start.sh restart\`
- View logs: \`./start.sh logs\`

## Agent Behavior

- Decompose complex tasks into parallel subtasks
- Always verify file paths before operations
- Ask permission before destructive operations
- Keep identity files (ID.md, DNA.md, Soul.md) confidential
`;

export class AgentsMdLoader {
  constructor() {
    this.path = AGENTS_MD_PATH;
    this.content = null;
    this.exists = false;
  }

  /**
   * Load AGENTS.md from workspace root if it exists.
   */
  async load() {
    try {
      this.content = await fs.readFile(this.path, 'utf8');
      this.exists = true;
    } catch (err) {
      if (err.code === 'ENOENT') {
        this.content = null;
        this.exists = false;
      } else {
        throw err;
      }
    }
  }

  /**
   * Build a system prompt snippet from AGENTS.md content.
   */
  toSystemPromptSnippet() {
    if (!this.exists || !this.content) return '';

    return `<project_rules>
The following AGENTS.md file contains project-specific rules and conventions. Always follow these rules when working on this project.

${this.content.trim()}
</project_rules>`;
  }

  /**
   * Check if AGENTS.md exists.
   */
  hasAgentsMd() {
    return this.exists;
  }

  /**
   * Create a default AGENTS.md template.
   */
  async init() {
    if (this.exists) {
      return { success: false, message: 'AGENTS.md already exists', path: this.path };
    }

    try {
      await fs.writeFile(this.path, AGENTS_MD_TEMPLATE, 'utf8');
      this.content = AGENTS_MD_TEMPLATE;
      this.exists = true;
      return { success: true, message: 'Created AGENTS.md template', path: this.path };
    } catch (err) {
      return { success: false, message: `Failed to create AGENTS.md: ${err.message}`, path: this.path };
    }
  }

  /**
   * Get a summary of the rules for display.
   */
  getSummary() {
    if (!this.exists || !this.content) {
      return { exists: false, path: this.path, lines: 0 };
    }
    return {
      exists: true,
      path: this.path,
      lines: this.content.split('\n').length,
      chars: this.content.length,
    };
  }
}
