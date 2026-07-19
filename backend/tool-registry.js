// ============================================================
// Tool Registry — Structured Tool Definitions and Execution
// Enhanced from OpenCode's approach for strict structured execution
// ============================================================

import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { minimatch } from 'minimatch';
import { exec } from 'child_process';
import { promisify } from 'util';
import { load } from 'cheerio';

const execAsync = promisify(exec);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Security: restrict file operations to workspace only
const WORKSPACE_ROOT = path.join(__dirname, '..');

// ============================================================
// Utility Functions
// ============================================================

function sanitizePath(rawPath) {
  const resolved = path.resolve(WORKSPACE_ROOT, rawPath);
  if (!resolved.startsWith(WORKSPACE_ROOT)) {
    throw new Error(`Path traversal denied: ${rawPath}`);
  }
  return resolved;
}

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ============================================================
// JSON Schema Validation (Lightweight)
// ============================================================

function validateParameters(args, schema) {
  const errors = [];
  
  // Check required parameters
  for (const [param, desc] of Object.entries(schema.parameters)) {
    if (desc.required && (args[param] === undefined || args[param] === null)) {
      errors.push(`Missing required parameter: ${param}`);
    }
  }
  
  // Check parameter types
  for (const [param, value] of Object.entries(args)) {
    const desc = schema.parameters[param];
    if (!desc) {
      errors.push(`Unknown parameter: ${param}`);
      continue;
    }
    
    if (desc.type === 'string' && typeof value !== 'string') {
      errors.push(`Parameter ${param} must be a string, got ${typeof value}`);
    } else if (desc.type === 'number' && typeof value !== 'number') {
      errors.push(`Parameter ${param} must be a number, got ${typeof value}`);
    } else if (desc.type === 'boolean' && typeof value !== 'boolean') {
      errors.push(`Parameter ${param} must be a boolean, got ${typeof value}`);
    } else if (desc.type === 'object' && (typeof value !== 'object' || value === null)) {
      errors.push(`Parameter ${param} must be an object, got ${typeof value}`);
    }
  }
  
  return errors;
}

// ============================================================
// Tool Registry
// ============================================================

class ToolRegistry {
  constructor() {
    this.tools = new Map();
    this.registerDefaultTools();
  }
  
  register(toolDefinition) {
    const { name, description, parameters, handler } = toolDefinition;
    
    if (!name || !handler) {
      throw new Error('Tool must have name and handler');
    }
    
    this.tools.set(name, {
      name,
      description: description || '',
      parameters: parameters || {},
      handler,
      aliases: toolDefinition.aliases || [],
    });
    
    // Register aliases
    if (toolDefinition.aliases) {
      for (const alias of toolDefinition.aliases) {
        this.tools.set(alias, this.tools.get(name));
      }
    }
  }
  
  getTool(name) {
    return this.tools.get(name);
  }
  
  getAllTools() {
    // Return unique tools (exclude aliases)
    const unique = new Map();
    for (const [name, tool] of this.tools) {
      if (!tool.aliases || tool.aliases.includes(name)) continue;
      if (!unique.has(tool.name)) {
        unique.set(tool.name, tool);
      }
    }
    return Array.from(unique.values());
  }
  
  async execute(toolCall) {
    const { name, arguments: args } = toolCall;
    
    const tool = this.getTool(name);
    if (!tool) {
      return {
        success: false,
        error: `Unknown tool: ${name}`,
        errorCode: 'TOOL_NOT_FOUND',
      };
    }
    
    // Validate parameters
    const validationErrors = validateParameters(args, tool);
    if (validationErrors.length > 0) {
      return {
        success: false,
        error: `Parameter validation failed: ${validationErrors.join(', ')}`,
        errorCode: 'VALIDATION_ERROR',
        errors: validationErrors,
      };
    }
    
    // Execute with metadata
    const startTime = Date.now();
    try {
      const result = await tool.handler(args);
      const endTime = Date.now();
      
      return {
        success: true,
        result,
        metadata: {
          tool: name,
          executionTime: endTime - startTime,
          timestamp: new Date().toISOString(),
        },
      };
    } catch (err) {
      const endTime = Date.now();
      
      return {
        success: false,
        error: err.message,
        errorCode: 'EXECUTION_ERROR',
        metadata: {
          tool: name,
          executionTime: endTime - startTime,
          timestamp: new Date().toISOString(),
        },
      };
    }
  }
  
  registerDefaultTools() {
    // ── Shell Execute ──
    this.register({
      name: 'shell_execute',
      description: 'Execute a shell command and return stdout/stderr. Use for git, npm, ls, grep, and any CLI tool.',
      parameters: {
        command: { type: 'string', description: 'Shell command to execute', required: true },
        workdir: { type: 'string', description: 'Working directory (relative to workspace root)', required: false },
      },
      aliases: ['bash', 'bash_exec', 'exec', 'shell'],
      handler: async ({ command, workdir }) => {
        const cwd = workdir ? sanitizePath(workdir) : WORKSPACE_ROOT;
        try {
          const { stdout, stderr } = await execAsync(command, {
            cwd,
            timeout: 30000,
            maxbuffer: 1024 * 1024 * 5,
            shell: true,
          });
          return {
            stdout: stdout || '',
            stderr: stderr || '',
            exitCode: 0,
          };
        } catch (err) {
          return {
            stdout: err.stdout || '',
            stderr: err.stderr || '',
            exitCode: err.code || -1,
            error: err.message,
          };
        }
      },
    });
    
    // ── Web Fetch ──
    this.register({
      name: 'web_fetch',
      description: 'Fetch content from a URL. Use for reading web pages, APIs, or downloading content.',
      parameters: {
        url: { type: 'string', description: 'URL to fetch', required: true },
        prompt: { type: 'string', description: 'Optional: what to extract or analyze from the page', required: false },
      },
      aliases: ['fetch', 'fetch_url', 'http_get'],
      handler: async ({ url, prompt }) => {
        let controller;
        let timeout;
        
        try {
          controller = new AbortController();
          timeout = setTimeout(() => controller.abort(), 15000);
          
          const resp = await fetch(url, {
            signal: controller.signal,
            headers: {
              'User-Agent': 'Agent-WebUI/1.0.0',
            },
          });
          
          clearTimeout(timeout);
          
          const contentType = resp.headers.get('content-type') || '';
          let content;
          
          if (contentType.includes('application/json')) {
            content = await resp.json();
            content = JSON.stringify(content, null, 2);
          } else {
            content = await resp.text();
            if (content.length > 50000) {
              content = content.slice(0, 50000) + '\n\n[Truncated]';
            }
          }
          
          let result = `URL: ${url}\nStatus: ${resp.status}\nContent-Type: ${contentType}\n\n${content}`;
          if (prompt) {
            result += `\n\nAnalysis request: ${prompt}`;
          }
          
          return { content: result.slice(0, 100000) };
        } catch (err) {
          if (timeout) clearTimeout(timeout);
          throw new Error(`web_fetch failed: ${err.message}`);
        }
      },
    });
    
    // ── Web Search（基于 Cheerio 的网页解析搜索）──
    this.register({
      name: 'web_search',
      description: 'Search the web for information using DuckDuckGo. Use for current events, documentation, research, or any question that needs up-to-date information from the internet. Returns title, URL, and snippet for each result.',
      parameters: {
        query: { type: 'string', description: 'Search query', required: true },
        count: { type: 'number', description: 'Number of results (max 10, default 5)', required: false },
        search_lang: { type: 'string', description: 'Search language (default: zh-CN for Chinese, en-US for English)', required: false },
      },
      aliases: ['search', 'search_web', 'webSearch'],
      handler: async ({ query, count = 5, search_lang = 'zh-CN' }) => {
        if (!query) throw new Error('query is required');

        const maxResults = Math.min(count || 5, 10);

        // Try DuckDuckGo HTML search
        const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=${search_lang}`;

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);

        try {
          const resp = await fetch(url, {
            signal: controller.signal,
            headers: {
              'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
              'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
              'Accept-Language': search_lang,
            },
          });

          clearTimeout(timeout);

          if (!resp.ok) {
            throw new Error(`DuckDuckGo returned ${resp.status}`);
          }

          const html = await resp.text();
          const $ = load(html);

          const results = [];

          // Parse DuckDuckGo search results
          $('.result').each((i, el) => {
            if (results.length >= maxResults) return false;

            const $el = $(el);
            const $titleLink = $el.find('.result__a').first();
            const title = $titleLink.text().trim();
            let resultUrl = $titleLink.attr('href') || '';

            // DuckDuckGo uses redirect URLs, extract the actual URL
            if (resultUrl.includes('uddg=')) {
              const match = resultUrl.match(/uddg=([^&]+)/);
              if (match) {
                resultUrl = decodeURIComponent(match[1]);
              }
            }

            const $snippet = $el.find('.result__snippet').first();
            const snippet = $snippet.text().trim();

            if (title && resultUrl) {
              results.push({
                title,
                url: resultUrl,
                snippet: snippet || '',
              });
            }
          });

          // If no results found with .result, try alternative selectors
          if (results.length === 0) {
            $('a.result__a').each((i, el) => {
              if (results.length >= maxResults) return false;

              const $el = $(el);
              const title = $el.text().trim();
              let resultUrl = $el.attr('href') || '';

              if (resultUrl.includes('uddg=')) {
                const match = resultUrl.match(/uddg=([^&]+)/);
                if (match) {
                  resultUrl = decodeURIComponent(match[1]);
                }
              }

              if (title && resultUrl) {
                results.push({
                  title,
                  url: resultUrl,
                  snippet: '',
                });
              }
            });
          }

          return {
            query,
            results,
            count: results.length,
            provider: 'DuckDuckGo',
          };
        } catch (err) {
          if (timeout) clearTimeout(timeout);
          throw new Error(`web_search failed: ${err.message}`);
        }
      },
    });
    
    // ── Python Execute ──
    this.register({
      name: 'python_execute',
      description: 'Execute Python code and return stdout. Use for calculations, data analysis, or running Python scripts.',
      parameters: {
        code: { type: 'string', description: 'Python code to execute', required: true },
        args: { type: 'string', description: 'Command-line arguments (passed to script)', required: false },
      },
      aliases: ['python', 'run_python'],
      handler: async ({ code, args = '' }) => {
        if (!code) throw new Error('code is required');
        
        const tmpFile = `/tmp/py_exec_${Date.now()}.py`;
        fsSync.writeFileSync(tmpFile, code, 'utf8');
        
        try {
          const { execSync } = await import('child_process');
          // Find project venv Python (cross-platform)
          const venvPy = process.platform === 'win32'
            ? path.join(WORKSPACE_ROOT, 'venv', 'Scripts', 'python.exe')
            : path.join(WORKSPACE_ROOT, 'venv', 'bin', 'python3');
          const pythonCmd = fsSync.existsSync(venvPy) ? venvPy : 'python3';
          const result = execSync(`"${pythonCmd}" ${tmpFile} ${args}`, {
            timeout: 30000,
            maxBuffer: 1024 * 1024,
            encoding: 'utf8',
          });
          return { stdout: result.trim() };
        } finally {
          try { fsSync.unlinkSync(tmpFile); } catch {}
        }
      },
    });
    
    // ── HTTP Request ──
    this.register({
      name: 'http_request',
      description: 'Make an HTTP request to any URL. Use for calling REST APIs, fetching data, or submitting forms.',
      parameters: {
        url: { type: 'string', description: 'URL to request', required: true },
        method: { type: 'string', description: 'HTTP method (GET/POST/PUT/DELETE, default GET)', required: false },
        headers: { type: 'object', description: 'HTTP headers as key-value pairs', required: false },
        body: { type: 'string', description: 'Request body (for POST/PUT)', required: false },
      },
      aliases: ['api_call', 'rest_api'],
      handler: async ({ url, method = 'GET', headers = {}, body = '' }) => {
        if (!url) throw new Error('url is required');
        
        const fetchOptions = {
          method,
          headers: { 'User-Agent': 'Mozilla/5.0', ...headers },
        };
        
        if (body && method !== 'GET') {
          fetchOptions.body = body;
        }
        
        const resp = await fetch(url, fetchOptions);
        const contentType = resp.headers.get('content-type') || '';
        
        let data;
        if (contentType.includes('application/json')) {
          data = await resp.json();
        } else {
          data = await resp.text();
        }
        
        return {
          status: resp.status,
          statusText: resp.statusText,
          headers: Object.fromEntries(resp.headers.entries()),
          data: typeof data === 'string' ? data.slice(0, 5000) : JSON.stringify(data).slice(0, 5000),
        };
      },
    });
    
    // ── File Read ──
    this.register({
      name: 'file_read',
      description: 'Read the contents of a file. Use to examine code, configs, or any text file.',
      parameters: {
        path: { type: 'string', description: 'File path (relative to workspace)', required: true },
      },
      aliases: ['read_file', 'read'],
      handler: async ({ path: filePath }) => {
        const resolved = sanitizePath(filePath);
        const content = await fs.readFile(resolved, 'utf8');
        return { content, path: filePath };
      },
    });
    
    // ── File Write ──
    this.register({
      name: 'file_write',
      description: 'Write content to a file. Creates the file if it does not exist.',
      parameters: {
        path: { type: 'string', description: 'File path (relative to workspace)', required: true },
        content: { type: 'string', description: 'Content to write', required: true },
        append: { type: 'boolean', description: 'Append instead of overwrite', required: false },
      },
      aliases: ['write_file', 'write'],
      handler: async ({ path: filePath, content, append }) => {
        const resolved = sanitizePath(filePath);
        const dir = path.dirname(resolved);
        await fs.mkdir(dir, { recursive: true });
        
        if (append) {
          await fs.appendFile(resolved, content, 'utf8');
        } else {
          await fs.writeFile(resolved, content, 'utf8');
        }
        
        return { path: filePath, bytes: content.length };
      },
    });
    
    // ── File Edit ──
    this.register({
      name: 'file_edit',
      description: 'Edit a file by replacing specific text. Use to make targeted changes without rewriting the entire file.',
      parameters: {
        path: { type: 'string', description: 'File path (relative to workspace)', required: true },
        old_string: { type: 'string', description: 'Exact text to replace (must match exactly)', required: true },
        new_string: { type: 'string', description: 'New text to insert', required: true },
        replace_all: { type: 'boolean', description: 'Replace all occurrences (default: false)', required: false },
      },
      aliases: ['edit_file', 'replace_text'],
      handler: async ({ path: filePath, old_string, new_string, replace_all }) => {
        const resolved = sanitizePath(filePath);
        const content = await fs.readFile(resolved, 'utf8');
        
        let newContent;
        if (replace_all) {
          newContent = content.split(old_string).join(new_string);
        } else {
          const idx = content.indexOf(old_string);
          if (idx === -1) {
            throw new Error(`old_string not found in ${filePath}`);
          }
          newContent = content.slice(0, idx) + new_string + content.slice(idx + old_string.length);
        }
        
        await fs.writeFile(resolved, newContent, 'utf8');
        return { path: filePath, changed: true };
      },
    });
    
    // ── File List ──
    this.register({
      name: 'file_list',
      description: 'List files and directories in a path. Use to explore the project structure.',
      parameters: {
        path: { type: 'string', description: 'Directory path (relative to workspace), defaults to root', required: false },
      },
      aliases: ['list_directory', 'list_dir', 'ls'],
      handler: async ({ path: dirPath }) => {
        const resolved = sanitizePath(dirPath || '.');
        const entries = await fs.readdir(resolved, { withFileTypes: true });
        const result = entries.map(e => ({
          name: e.name,
          type: e.isDirectory() ? 'dir' : 'file',
        }));
        return { path: dirPath || '.', entries: result };
      },
    });
    
    // ── File Glob ──
    this.register({
      name: 'file_glob',
      description: 'Search for files matching a pattern (e.g., "**/*.js"). Use to find files by name.',
      parameters: {
        pattern: { type: 'string', description: 'Glob pattern (e.g., "**/*.js", "src/**/*.ts")', required: true },
        path: { type: 'string', description: 'Root directory to search (relative to workspace)', required: false },
      },
      aliases: ['glob', 'find_files'],
      handler: async ({ pattern, path: searchPath }) => {
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
        return { pattern, matches: results.slice(0, 200) };
      },
    });
    
    // ── File Grep ──
    this.register({
      name: 'file_grep',
      description: 'Search for text patterns inside files. Use to find where a function, variable, or string is used.',
      parameters: {
        pattern: { type: 'string', description: 'Regex pattern to search for', required: true },
        path: { type: 'string', description: 'Directory to search (relative to workspace)', required: false },
        include: { type: 'string', description: 'File pattern to include (e.g., "*.js")', required: false },
        literal_text: { type: 'boolean', description: 'Treat pattern as literal text, not regex', required: false },
      },
      aliases: ['grep', 'search_files', 'search_in_files'],
      handler: async ({ pattern, path: searchPath, include, literal_text }) => {
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
        return { pattern, matches: results.slice(0, 100) };
      },
    });
  }
}

// ============================================================
// Export
// ============================================================

const registry = new ToolRegistry();

export { ToolRegistry, registry };

export default registry;
