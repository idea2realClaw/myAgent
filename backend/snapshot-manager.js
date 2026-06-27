// ============================================================
// Snapshot Manager — Undo / Redo for file edits
// Inspired by OpenCode's undo/redo system
// ============================================================

import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = path.join(__dirname, '..');
const SNAPSHOT_DIR = path.join(WORKSPACE_ROOT, '.workbuddy', 'snapshots');

// Ensure snapshot directory exists
if (!fsSync.existsSync(SNAPSHOT_DIR)) {
  fsSync.mkdirSync(SNAPSHOT_DIR, { recursive: true });
}

function sanitizePath(rawPath) {
  const resolved = path.resolve(WORKSPACE_ROOT, rawPath);
  if (!resolved.startsWith(WORKSPACE_ROOT)) {
    throw new Error(`Path traversal denied: ${rawPath}`);
  }
  return resolved;
}

export class SnapshotManager {
  constructor() {
    this.history = []; // { id, filePath, before, after, timestamp, action }
    this.redoStack = [];
  }

  /**
   * Create a snapshot of a file before it is modified.
   * Returns snapshot id or null if file doesn't exist yet.
   */
  async snapshotBefore(filePath, action = 'edit') {
    const resolved = sanitizePath(filePath);
    let before = null;

    try {
      before = await fs.readFile(resolved, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      // File doesn't exist yet, snapshot as null
      before = null;
    }

    const snapshot = {
      id: `snap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      filePath,
      resolved,
      before,
      after: null,
      timestamp: new Date().toISOString(),
      action,
    };

    this.history.push(snapshot);
    this.redoStack = []; // Clear redo stack on new action
    return snapshot.id;
  }

  /**
   * Record the after-state of a file after modification.
   */
  async snapshotAfter(snapshotId) {
    const snapshot = this.history.find(s => s.id === snapshotId);
    if (!snapshot) return false;

    try {
      snapshot.after = await fs.readFile(snapshot.resolved, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      snapshot.after = null; // File was deleted
    }

    return true;
  }

  /**
   * Undo the last file modification.
   * Returns { success, filePath, message, snapshot }
   */
  async undo() {
    if (this.history.length === 0) {
      return { success: false, message: 'Nothing to undo' };
    }

    const snapshot = this.history.pop();
    const resolved = snapshot.resolved;

    try {
      if (snapshot.before === null) {
        // File didn't exist before, so delete it
        try {
          await fs.unlink(resolved);
        } catch (err) {
          if (err.code !== 'ENOENT') throw err;
        }
      } else {
        await fs.writeFile(resolved, snapshot.before, 'utf8');
      }

      snapshot.restored = snapshot.before;
      this.redoStack.push(snapshot);

      return {
        success: true,
        filePath: snapshot.filePath,
        message: `Undo ${snapshot.action} on ${snapshot.filePath}`,
        snapshot,
      };
    } catch (err) {
      this.history.push(snapshot); // Rollback the pop
      return { success: false, message: `Undo failed: ${err.message}` };
    }
  }

  /**
   * Redo the last undone action.
   */
  async redo() {
    if (this.redoStack.length === 0) {
      return { success: false, message: 'Nothing to redo' };
    }

    const snapshot = this.redoStack.pop();
    const resolved = snapshot.resolved;

    try {
      if (snapshot.after === null) {
        // File was deleted, so delete it
        try {
          await fs.unlink(resolved);
        } catch (err) {
          if (err.code !== 'ENOENT') throw err;
        }
      } else {
        const dir = path.dirname(resolved);
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(resolved, snapshot.after, 'utf8');
      }

      this.history.push(snapshot);

      return {
        success: true,
        filePath: snapshot.filePath,
        message: `Redo ${snapshot.action} on ${snapshot.filePath}`,
        snapshot,
      };
    } catch (err) {
      this.redoStack.push(snapshot);
      return { success: false, message: `Redo failed: ${err.message}` };
    }
  }

  /**
   * List all snapshots for display.
   */
  list() {
    return this.history.map(s => ({
      id: s.id,
      filePath: s.filePath,
      action: s.action,
      timestamp: s.timestamp,
    })).reverse();
  }

  /**
   * Save snapshots to disk for persistence.
   */
  async save() {
    const file = path.join(SNAPSHOT_DIR, 'history.json');
    await fs.writeFile(file, JSON.stringify({ history: this.history, redoStack: this.redoStack }, null, 2));
  }

  /**
   * Load snapshots from disk.
   */
  async load() {
    const file = path.join(SNAPSHOT_DIR, 'history.json');
    try {
      const data = JSON.parse(await fs.readFile(file, 'utf8'));
      if (data.history) this.history = data.history;
      if (data.redoStack) this.redoStack = data.redoStack;
    } catch { /* ignore */ }
  }
}
