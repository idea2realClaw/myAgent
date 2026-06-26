// ============================================================
// Tool Executor — Executes tools requested by the LLM
// Supports: shell commands, web fetch, file operations, search
// Features: execStream for real-time output, OpenAI function calling
// ============================================================

import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { minimatch } from 'minimatch';

const execAsync = promisify(exec);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Security: restrict file operations to workspace only
const WORKSPACE_ROOT = path.join(__dirname, '..');

function sanitizePath(rawPath) {
  // Resolve to absolute path, reject if outside workspace
  const resolved = path.resolve(WORKSPACE_ROOT, rawPath);
  if (!resolved.startsWith(WORKSPACE_ROOT)) {
    throw new Error(`Path traversal denied: ${rawPath}`);
  }
  return resolved;
}

// ============================================================
// execStream — Real-time streaming execution
// Yields { type: 'stdout', data } / { type: 'stderr', data } / { type: 'done', code, stdout, stderr }
// ============================================================

export async function* execStream({ command, workdir, signal }) {
  const cwd = workdir ? sanitizePath(workdir) : WORKSPACE_ROOT;
  
  let stdoutBuffer = '';
  let stderrBuffer = '';
  let resolved = false;
  let resolvePromise;
  const promise = new Promise(resolve => { resolvePromise = resolve; });

  const child = exec(command, {
    cwd,
    shell: true,
    maxBuffer: 1024 * 1024 * 10, // 10MB
  });

  // Handle abort signal
  if (signal) {
    signal.addEventListener('abort', () => {
      child.kill('SIGTERM');
    });
  }

  child.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    stdoutBuffer += text;
    // Yield each chunk as it arrives
    if (!resolved) {
      // Can't yield from event callback, collect and yield in loop
    }
  });

  child.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    stderrBuffer += text;
  });

  child.on('close', (code) => {
    resolved = true;
    resolvePromise({
      success: code === 0,
      stdout: stdoutBuffer,
      stderr: stderrBuffer,
      exitCode: code,
    });
  });

  child.on('error', (err) => {
    resolved = true;
    resolvePromise({
      success: false,
      stdout: stdoutBuffer,
      stderr: stderrBuffer,
      exitCode: -1,
      error: err.message,
    });
  });

  // Wait for completion and yield result
  // For real-time streaming to WebSocket, we need to yield chunks as they arrive
  // This is handled by the caller via stdout/stderr callbacks
  const result = await promise;
  yield { type: 'done', ...result };
}

// ── Tool Implementations ─────────────────────────────────────

async function shellExecute({ command, workdir }) {
  const cwd = workdir ? sanitizePath(workdir) : WORKSPACE_ROOT;
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd,
      timeout: 30000,
      maxbuffer: 1024 * 1024 * 5, // 5MB
      shell: true,
    });
    return {
      success: true,
      stdout: stdout || '',
      stderr: stderr || '',
      exitCode: 0,
    };
  } catch (err) {
    return {
      success: false,
      stdout: err.stdout || '',
      stderr: err.stderr || '',
      exitCode: err.code || -1,
      error: err.message,
    };
  }
}

async function webFetch({ url, prompt }) {
  let controller;
  let timeout;
  
  try {
    // Use node's built-in fetch (Node 18+)
    controller = new AbortController();
    timeout = setTimeout(() => controller.abort(), 15000);

    console.log(`[webFetch] Fetching: ${url}`);
    
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Agent-WebUI/1.0.0',
      },
    });
    
    clearTimeout(timeout);
    console.log(`[webFetch] Response status: ${resp.status}`);

    const contentType = resp.headers.get('content-type') || '';
    let content;

    if (contentType.includes('application/json')) {
      content = await resp.json();
      content = JSON.stringify(content, null, 2);
    } else {
      content = await resp.text();
      // Truncate very long HTML
      if (content.length > 50000) {
        content = content.slice(0, 50000) + '\n\n[Truncated — full length: ' + content.length + ' chars]';
      }
    }

    let result = `URL: ${url}\nStatus: ${resp.status}\nContent-Type: ${contentType}\n\n${content}`;

    // If LLM needs to analyze the content, optionally summarize
    if (prompt) {
      result += `\n\nAnalysis request: ${prompt}`;
    }

    console.log(`[webFetch] Success, content length: ${result.length}`);
    return { success: true, content: result.slice(0, 100000) };
  } catch (err) {
    console.error(`[webFetch] Error: ${err.message}`);
    if (timeout) clearTimeout(timeout);
    return {
      success: false,
      error: `web_fetch failed: ${err.message}`,
    };
  }
}

async function fileRead({ path: filePath }) {
  try {
    const resolved = sanitizePath(filePath);
    const content = await fs.readFile(resolved, 'utf8');
    return { success: true, content, path: filePath };
  } catch (err) {
    return { success: false, error: `file_read failed: ${err.message}` };
  }
}

async function fileWrite({ path: filePath, content, append }) {
  try {
    const resolved = sanitizePath(filePath);
    const dir = path.dirname(resolved);
    await fs.mkdir(dir, { recursive: true });

    if (append) {
      await fs.appendFile(resolved, content, 'utf8');
    } else {
      await fs.writeFile(resolved, content, 'utf8');
    }
    return { success: true, path: filePath, bytes: content.length };
  } catch (err) {
    return { success: false, error: `file_write failed: ${err.message}` };
  }
}

async function fileList({ path: dirPath }) {
  try {
    const resolved = sanitizePath(dirPath || '.');
    const entries = await fs.readdir(resolved, { withFileTypes: true });
    const result = entries.map(e => ({
      name: e.name,
      type: e.isDirectory() ? 'dir' : 'file',
    }));
    return { success: true, path: dirPath || '.', entries: result };
  } catch (err) {
    return { success: false, error: `file_list failed: ${err.message}` };
  }
}

// ── New Tools (OpenCode style) ─────────────────────────────

async function fileEdit({ path: filePath, old_string, new_string, replace_all }) {
  try {
    const resolved = sanitizePath(filePath);
    const content = await fs.readFile(resolved, 'utf8');

    let newContent;
    if (replace_all) {
      newContent = content.split(old_string).join(new_string);
    } else {
      const idx = content.indexOf(old_string);
      if (idx === -1) {
        return { success: false, error: `old_string not found in ${filePath}` };
      }
      newContent = content.slice(0, idx) + new_string + content.slice(idx + old_string.length);
    }

    await fs.writeFile(resolved, newContent, 'utf8');
    return { success: true, path: filePath, changed: true };
  } catch (err) {
    return { success: false, error: `file_edit failed: ${err.message}` };
  }
}

async function fileGlob({ pattern, path: searchPath }) {
  try {
    const root = sanitizePath(searchPath || '.');
    const results = [];

    async function walk(dir) {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        const full = path.join(dir, e.name);
        const rel = path.relative(root, full);
        if (minimatch(rel, pattern, { matchBase: true })) {
          results.push(rel);
        }
        if (e.isDirectory() && !e.name.startsWith('.')) {
          await walk(full);
        }
      }
    }

    await walk(root);
    return { success: true, pattern, matches: results.slice(0, 200) };
  } catch (err) {
    return { success: false, error: `file_glob failed: ${err.message}` };
  }
}

async function fileGrep({ pattern, path: searchPath, include, literal_text }) {
  try {
    const root = sanitizePath(searchPath || '.');
    const regex = literal_text ? new RegExp(escapeRegExp(pattern), 'i') : new RegExp(pattern, 'i');
    const results = [];

    async function walk(dir) {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        const full = path.join(dir, e.name);
        const rel = path.relative(root, full);

        if (e.isDirectory()) {
          if (!e.name.startsWith('.')) await walk(full);
        } else if (e.isFile()) {
          if (include && !minimatch(e.name, include)) continue;

          try {
            const content = await fs.readFile(full, 'utf8');
            const lines = content.split('\n');
            for (let i = 0; i < lines.length; i++) {
              if (regex.test(lines[i])) {
                results.push({ file: rel, line: i + 1, content: lines[i].trim() });
              }
            }
          } catch { /* skip binary files */ }
        }
      }
    }

    await walk(root);
    return { success: true, pattern, matches: results.slice(0, 100) };
  } catch (err) {
    return { success: false, error: `file_grep failed: ${err.message}` };
  }
}

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── Tool Schema (for LLM prompt) ────────────────────────────

export const TOOL_SCHEMAS = {
  shell_execute: {
    name: 'shell_execute',
    description: 'Execute a shell command and return stdout/stderr. Use for git, npm, ls, grep, and any CLI tool.',
    parameters: {
      command: { type: 'string', description: 'Shell command to execute', required: true },
      workdir: { type: 'string', description: 'Working directory (relative to workspace root)', required: false },
    },
  },
  web_fetch: {
    name: 'web_fetch',
    description: 'Fetch content from a URL. Use for reading web pages, APIs, or downloading content.',
    parameters: {
      url: { type: 'string', description: 'URL to fetch', required: true },
      prompt: { type: 'string', description: 'Optional: what to extract or analyze from the page', required: false },
    },
  },
  file_read: {
    name: 'file_read',
    description: 'Read the contents of a file. Use to examine code, configs, or any text file.',
    parameters: {
      path: { type: 'string', description: 'File path (relative to workspace)', required: true },
    },
  },
  file_write: {
    name: 'file_write',
    description: 'Write content to a file. Creates the file if it does not exist.',
    parameters: {
      path: { type: 'string', description: 'File path (relative to workspace)', required: true },
      content: { type: 'string', description: 'Content to write', required: true },
      append: { type: 'boolean', description: 'Append instead of overwrite', required: false },
    },
  },
  file_edit: {
    name: 'file_edit',
    description: 'Edit a file by replacing specific text. Use to make targeted changes without rewriting the entire file.',
    parameters: {
      path: { type: 'string', description: 'File path (relative to workspace)', required: true },
      old_string: { type: 'string', description: 'Exact text to replace (must match exactly)', required: true },
      new_string: { type: 'string', description: 'New text to insert', required: true },
      replace_all: { type: 'boolean', description: 'Replace all occurrences (default: false)', required: false },
    },
  },
  file_list: {
    name: 'file_list',
    description: 'List files and directories in a path. Use to explore the project structure.',
    parameters: {
      path: { type: 'string', description: 'Directory path (relative to workspace), defaults to root', required: false },
    },
  },
  file_glob: {
    name: 'file_glob',
    description: 'Search for files matching a pattern (e.g., "**/*.js"). Use to find files by name.',
    parameters: {
      pattern: { type: 'string', description: 'Glob pattern (e.g., "**/*.js", "src/**/*.ts")', required: true },
      path: { type: 'string', description: 'Root directory to search (relative to workspace)', required: false },
    },
  },
  file_grep: {
    name: 'file_grep',
    description: 'Search for text patterns inside files. Use to find where a function, variable, or string is used.',
    parameters: {
      pattern: { type: 'string', description: 'Regex pattern to search for', required: true },
      path: { type: 'string', description: 'Directory to search (relative to workspace)', required: false },
      include: { type: 'string', description: 'File pattern to include (e.g., "*.js")', required: false },
      literal_text: { type: 'boolean', description: 'Treat pattern as literal text, not regex', required: false },
    },
  },
};

// ── OpenAI Native Function Calling Schema ────────────────────
// Standard OpenAI function calling format for tools parameter

export const TOOL_SCHEMAS_OPENAI = Object.entries(TOOL_SCHEMAS).map(([name, schema]) => ({
  type: 'function',
  function: {
    name: schema.name,
    description: schema.description,
    parameters: {
      type: 'object',
      properties: Object.fromEntries(
        Object.entries(schema.parameters).map(([param, desc]) => [
          param,
          {
            type: desc.type,
            description: desc.description,
          }
        ])
      ),
      required: Object.entries(schema.parameters)
        .filter(([, desc]) => desc.required)
        .map(([param]) => param),
    },
  },
}));

// ── Known tools whitelist (for legacy parsing) ──────────────
export const KNOWN_TOOLS = new Set([
  'shell_execute',
  'web_fetch',
  'file_read',
  'file_write',
  'file_edit',
  'file_list',
  'file_glob',
  'file_grep',
]);

// ── Main dispatch ────────────────────────────────────────────

export async function executeTool(toolCall) {
  const { name, arguments: args } = toolCall;

  try {
    let result;
    switch (name) {
      case 'shell_execute':
        result = await shellExecute(args);
        break;
      case 'web_fetch':
        result = await webFetch(args);
        break;
      case 'file_read':
        result = await fileRead(args);
        break;
      case 'file_write':
        result = await fileWrite(args);
        break;
      case 'file_edit':
        result = await fileEdit(args);
        break;
      case 'file_list':
        result = await fileList(args);
        break;
      case 'file_glob':
        result = await fileGlob(args);
        break;
      case 'file_grep':
        result = await fileGrep(args);
        break;
      default:
        return { success: false, error: `Unknown tool: ${name}` };
    }

    // Format result for LLM consumption
    if (result.success) {
      return {
        success: true,
        output: JSON.stringify(result, null, 2),
      };
    } else {
      // Add hint to not retry
      return {
        success: false,
        output: `Error: ${result.error}\n\n[Do not retry this tool call. Please provide an answer or try a different approach.]`,
      };
    }
  } catch (err) {
    return {
      success: false,
      output: `Tool execution error: ${err.message}\n\n[Do not retry this tool call.]`,
    };
  }
}

// ── Build tool instructions for system prompt ────────────────
// forNativeFunctionCalling: if true, only inject short prompt (avoid double injection)

export function buildToolInstructions(forNativeFunctionCalling = false) {
  if (forNativeFunctionCalling) {
    // Short prompt for native function calling mode
    return `\n\n## Tool Usage\nYou have access to tools via function calling. When you need to use a tool, the system will automatically call it. Do not generate tool_call blocks manually.`;
  }

  // Full prompt for legacy mode (text-based tool calls)
  const lines = [
    '',
    '## Available Tools',
    'You have access to the following tools. To use a tool, respond with a JSON code block in this exact format:',
    '',
    '```tool_call',
    JSON.stringify({ tool: 'tool_name', arguments: { /* ... */ } }, null, 2),
    '```',
    '',
    'After I execute the tool, I will send you the result. You can then make additional tool calls or provide a final answer.',
    '',
    '### Tool Definitions:',
    '',
  ];

  for (const [name, schema] of Object.entries(TOOL_SCHEMAS)) {
    lines.push(`**${name}** — ${schema.description}`);
    for (const [param, desc] of Object.entries(schema.parameters)) {
      const req = desc.required ? '(required)' : '(optional)';
      lines.push(`  - \`${param}\` ${req}: ${desc.description}`);
    }
    lines.push('');
  }

  lines.push('### Important Notes:');
  lines.push('- Always use \`shell_execute\` for Git operations, npm/yarn commands, or any CLI tool.');
  lines.push('- Use \`web_fetch\` to get current information from URLs (the LLM training data has a cutoff).');
  lines.push('- Use \`file_read\` before editing files to understand their current content.');
  lines.push('- Keep tool call responses concise. Only call tools that are necessary.');
  lines.push('');
  
  return lines.join('\n');
}

export default { executeTool, TOOL_SCHEMAS, TOOL_SCHEMAS_OPENAI, KNOWN_TOOLS, buildToolInstructions, execStream };
