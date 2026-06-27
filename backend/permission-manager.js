// ============================================================
// Permission Manager — Approval system for dangerous operations
// Inspired by OpenCode's plan mode and safety checks
// ============================================================

import { KNOWN_TOOLS } from './tool-executor.js';

const DANGEROUS_COMMANDS = [
  'rm -rf', 'rm -r /', 'rm -f /', 'rm /', 'rmdir /',
  'mkfs', 'dd if=', '>/dev/sda', 'of=/dev/sda',
  'pkill -9', 'killall -9', 'shutdown', 'reboot', 'halt',
  ':(){ :|:& };:', 'chmod -R 777 /', 'chown -R /',
  'curl .*\| *bash', 'curl .*\| *sh', 'wget .*\| *bash', 'wget .*\| *sh',
  'mv .* /dev/null', '> /etc/passwd', 'rm -rf /*', 'rm -rf /.*',
  'curl -fsSL .* | bash', 'curl -fsSL .* | sh',
];

const DANGEROUS_TOOL_COMBINATIONS = [
  { tool: 'file_write', path: '.*\.key' },
  { tool: 'file_write', path: '.*\.pem' },
  { tool: 'file_write', path: '.*id_rsa' },
  { tool: 'file_write', path: '.*\.env' },
];

export class PermissionManager {
  constructor() {
    this.pendingApprovals = new Map(); // id -> { resolve, reject, details, timeout }
    this.approvalId = 0;
  }

  /**
   * Check if a tool call requires approval based on mode and danger.
   * Returns { required: true, reason } or { required: false }.
   */
  checkRequiresApproval(toolName, args, mode = 'build') {
    // In plan mode, writing files or editing files is blocked
    if (mode === 'plan') {
      if (toolName === 'file_write' || toolName === 'file_edit') {
        return { required: true, reason: 'Plan mode is read-only. Switch to Build mode to modify files.' };
      }
    }

    // Shell commands require approval in plan mode, and dangerous ones in any mode
    if (toolName === 'shell_execute') {
      const command = (args.command || '').toLowerCase();

      if (mode === 'plan') {
        return { required: true, reason: `Plan mode requires approval before running shell command: ${args.command}` };
      }

      for (const pattern of DANGEROUS_COMMANDS) {
        const regex = new RegExp(pattern.replace(/\//g, '\\/').replace(/\./g, '\\.'), 'i');
        if (regex.test(command)) {
          return { required: true, reason: `Dangerous command detected: ${args.command}` };
        }
      }
    }

    // Check for sensitive file writes
    if (toolName === 'file_write' || toolName === 'file_edit') {
      const filePath = (args.path || '').toLowerCase();
      for (const combo of DANGEROUS_TOOL_COMBINATIONS) {
        const regex = new RegExp(combo.path, 'i');
        if (regex.test(filePath)) {
          return { required: true, reason: `Sensitive file operation detected: ${args.path}` };
        }
      }
    }

    return { required: false };
  }

  /**
   * Request approval from the user via callback.
   * Returns a Promise that resolves to { approved, reason }.
   */
  requestApproval(details, onRequest) {
    return new Promise((resolve, reject) => {
      const id = `approval-${++this.approvalId}-${Date.now()}`;

      const timeout = setTimeout(() => {
        this.pendingApprovals.delete(id);
        resolve({ approved: false, reason: 'Approval timeout (60s)' });
      }, 60000);

      this.pendingApprovals.set(id, { resolve, reject, details, timeout });

      if (onRequest) {
        onRequest({ id, ...details });
      }
    });
  }

  /**
   * Respond to an approval request.
   */
  respondToApproval(id, approved) {
    const request = this.pendingApprovals.get(id);
    if (!request) return false;

    clearTimeout(request.timeout);
    this.pendingApprovals.delete(id);
    request.resolve({ approved, reason: approved ? 'Approved by user' : 'Denied by user' });
    return true;
  }

  /**
   * Cancel all pending approvals (e.g., on stop).
   */
  cancelAll() {
    for (const [id, request] of this.pendingApprovals) {
      clearTimeout(request.timeout);
      request.resolve({ approved: false, reason: 'Cancelled' });
    }
    this.pendingApprovals.clear();
  }
}
