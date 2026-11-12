"use strict";
const fs = require("node:fs");
const { BaseAdapter } = require("./base");
const { resolveZcodePaths } = require("../../../../agents/zcode");

const MAX_SESSIONS_LIMIT = 50;
// LIKE "_" is a single-char wildcard; "#" never appears in session ids and
// keeps the sess_subagent exclusion exact without shell-escaping pain.
const SESSIONS_SQL = `
  SELECT id, title, directory, time_created, time_updated FROM session
  WHERE time_deleted IS NULL AND id NOT LIKE 'sess#_subagent%' ESCAPE '#'
  ORDER BY time_updated DESC LIMIT ?
`;

// ZCode is CLI-owned persistence (its own sqlite store), same as codex-paths
// reading Codex's own store — not a private desktop authentication database.
function normalizeSession(row) {
  if (!row || typeof row !== "object") return null;
  const id = typeof row.id === "string" ? row.id.trim() : "";
  if (!id) return null;
  const title = typeof row.title === "string" && row.title.trim()
    ? row.title.trim()
    : "ZCode 会话";
  const updated = Number(row.time_updated);
  const created = Number(row.time_created);
  return {
    id,
    name: title,
    summary: title,
    cwd: typeof row.directory === "string" && row.directory ? row.directory : undefined,
    lastModified: Number.isFinite(updated)
      ? updated
      : Number.isFinite(created)
        ? created
        : 0,
  };
}

class ZcodeAdapter extends BaseAdapter {
  constructor(options = {}) {
    super({ agentId: "zcode", log: options.log });
    this.paths = resolveZcodePaths(options);
    this._db = null;
  }
  async isAvailable() {
    const installed = this.paths.apps.some(p => fs.existsSync(p)) || fs.existsSync(this.paths.dbPath);
    return { ready: installed, reason: installed ? "支持状态与会话跟随；请打开 ZCode 目标对话使用按键语音输入" : "未检测到 ZCode" };
  }
  // Read-only, bounded listing with graceful degradation; the store is the
  // CLI's own persistence layer. Any failure simply means no sessions.
  async listSessions({ limit = 20 } = {}) {
    let db;
    try {
      const safeLimit = Math.max(1, Math.min(MAX_SESSIONS_LIMIT, Number.parseInt(limit, 10) || 20));
      db = this._openDb();
      if (!db) return [];
      const rows = db.prepare(SESSIONS_SQL).all(safeLimit);
      return rows.map(normalizeSession).filter(Boolean);
    } catch {
      this._closeDb();
      return [];
    }
  }
  async openNew() { throw new Error("请在 ZCode 中新建会话"); }
  async *inject() {
    yield { kind: "error", code: "AGENT_INPUT_UNSUPPORTED", message: "ZCode 语音输入使用桌面客户端的当前可见输入框，不支持后台会话注入；不会转发到其他 Agent。" };
  }
  _openDb() {
    if (this._db) return this._db;
    try {
      const { DatabaseSync } = require("node:sqlite");
      if (!fs.existsSync(this.paths.dbPath)) return null;
      this._db = new DatabaseSync(this.paths.dbPath, { readOnly: true });
      return this._db;
    } catch {
      this._db = null;
      return null;
    }
  }
  _closeDb() {
    if (this._db) {
      try { this._db.close(); } catch {}
    }
    this._db = null;
  }
}
module.exports = { ZcodeAdapter };
