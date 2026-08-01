// ============================================================
// Tool Executor — Executes tools requested by the LLM
// Supports: shell commands, web fetch, file operations, search
// Features: execStream for real-time output, OpenAI function calling
// Enhanced: Now uses ToolRegistry for structured execution
// ============================================================

import { exec } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

import registry from './tool-registry.js';
import { decodeShell } from './shell-decode.js';

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

  // Collect raw buffers (NOT strings) so multi-byte chars are never split across chunks.
  const stdoutChunks = [];
  const stderrChunks = [];

  child.stdout.on('data', (chunk) => {
    stdoutChunks.push(Buffer.from(chunk));
    // Yield each chunk as it arrives
    if (!resolved) {
      // Can't yield from event callback, collect and yield in loop
    }
  });

  child.stderr.on('data', (chunk) => {
    stderrChunks.push(Buffer.from(chunk));
  });

  child.on('close', (code) => {
    resolved = true;
    resolvePromise({
      success: code === 0,
      stdout: decodeShell(Buffer.concat(stdoutChunks)),
      stderr: decodeShell(Buffer.concat(stderrChunks)),
      exitCode: code,
    });
  });

  child.on('error', (err) => {
    resolved = true;
    resolvePromise({
      success: false,
      stdout: decodeShell(Buffer.concat(stdoutChunks)),
      stderr: decodeShell(Buffer.concat(stderrChunks)),
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

// ============================================================
// Main dispatch — Now uses ToolRegistry for structured execution
// ============================================================

export async function executeTool(toolCall) {
  const { name, arguments: args } = toolCall;
  
  try {
    // Use the structured registry for execution
    const result = await registry.execute({ name, arguments: args });
    
    if (result.success) {
      // Format result for LLM consumption
      return {
        success: true,
        output: JSON.stringify(result.result, null, 2),
        metadata: result.metadata,
      };
    } else {
      // Structured error response
      return {
        success: false,
        output: `Error [${result.errorCode}]: ${result.error}\n\n[Do not retry this tool call. Please provide an answer or try a different approach.]`,
        errorCode: result.errorCode,
        errors: result.errors || [],
      };
    }
  } catch (err) {
    return {
      success: false,
      output: `Tool execution error: ${err.message}\n\n[Do not retry this tool call.]`,
      errorCode: 'UNEXPECTED_ERROR',
    };
  }
}

// ============================================================
// Tool Schema (for LLM prompt) — Generated from registry
// ============================================================

export const TOOL_SCHEMAS = {};
for (const tool of registry.getAllTools()) {
  TOOL_SCHEMAS[tool.name] = {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  };
}

// ============================================================
// OpenAI Native Function Calling Schema
// ============================================================

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

// ============================================================
// Known tools whitelist (for legacy parsing)
// ============================================================

export const KNOWN_TOOLS = new Set(Object.keys(TOOL_SCHEMAS));

// ============================================================
// Build tool instructions for system prompt
// ============================================================

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
  lines.push('- Use \`web_search\` to search the web for current events, documentation, or research.');
  lines.push('- Use \`python_execute\` for calculations, data analysis, or running Python code.');
  lines.push('- Use \`http_request\` to call REST APIs or interact with web services.');
  lines.push('- Use \`file_read\` before editing files to understand their current content.');
  lines.push('- Keep tool call responses concise. Only call tools that are necessary.');
  lines.push('');
  
  return lines.join('\n');
}

// ============================================================
// Export
// ============================================================

export default { executeTool, TOOL_SCHEMAS, TOOL_SCHEMAS_OPENAI, KNOWN_TOOLS, buildToolInstructions, execStream, registry };
