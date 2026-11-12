"use strict";

/*
 * [Input] ZCode structured daily JSONL logs (one file per local day) and the read-only CLI session store (~/.zcode/cli/db/db.sqlite).
 * [Output] Per-session live states with SHA-256 user receipts from input_history; subagent sessions never reach the main state and no assistant text or token usage exists to publish.
 * [Pos] ZCode live-state monitor worker used by the managed status bridge.
 * [Sync] If ZCode log discovery or receipt correlation changes, update `pc/.folder.md`.
 */

const fs = require("fs");
const path = require("path");
const { createHash } = require("node:crypto");
const defaults = require("./zcode");

const MAX_TRACKED_SESSIONS = 256;
const MAX_SESSION_TITLE = 120;
const DB_RETRY_COOLDOWN_MS = 60000;
const DAY_FILE_PATTERN = /^zcode-(\d{4})-(\d{2})-(\d{2})\.jsonl$/;

const TEXT_SESSION_FALLBACK = "ZCode \u4f1a\u8bdd";
// Only live progress states are restored from a bounded tail on startup.
// Terminal history stays silent, exactly like the Codex monitor.
const RESTORABLE_ACTIVE_STATES = new Set(["working", "thinking", "speaking"]);

const SUBAGENT_SESSION_PREFIX = "sess_subagent";
// Evidence events carry no state change; completion evidence must never be
// mistaken for a user-visible transition.
const EVIDENCE_EVENTS = new Set(["tool.call.completed"]);
const LIKE_ESCAPE = "#";

const USER_INPUT_SQL = `
  SELECT text FROM input_history
  WHERE session_id = ? AND time_created <= ?
  ORDER BY time_created DESC LIMIT 1
`;
const SESSION_ROW_SQL = `
  SELECT id, title, directory, time_updated FROM session
  WHERE id = ? LIMIT 1
`;

function readNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readTimestampMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value <= 0) return 0;
    return value < 1_000_000_000_000 ? value * 1000 : value;
  }
  if (typeof value !== "string" || !value.trim()) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function localDayKey(value = Date.now()) {
  const date = new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function compactText(value, max = MAX_SESSION_TITLE) {
  if (typeof value !== "string") return "";
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  return normalized.length > max ? `${normalized.slice(0, Math.max(0, max - 1))}...` : normalized;
}

// Subagent sessions (sess_subagent…) are tool-driven noise; they must never
// masquerade as a desktop/CLI main session on the device.
function isSubagentSession(sessionId) {
  return typeof sessionId === "string" && sessionId.startsWith(SUBAGENT_SESSION_PREFIX);
}

function isDayLogFileName(fileName) {
  return DAY_FILE_PATTERN.test(String(fileName || ""));
}

// Pure map lookup so tests can cover every LOG_EVENT_MAP entry without
// spawning the worker or touching the filesystem.
function mapLogEvent(eventName, logEventMap = defaults.LOG_EVENT_MAP) {
  if (typeof eventName !== "string" || !eventName) return "";
  const mapped = logEventMap ? logEventMap[eventName] : undefined;
  return typeof mapped === "string" ? mapped : "";
}

function dayLogFilePaths(logDir, now = Date.now(), lookbackDays = defaults.LOOKBACK_DAYS) {
  const days = Math.max(1, Number(lookbackDays) || 2);
  const paths = [];
  const date = new Date(now);
  for (let daysAgo = 0; daysAgo < days; daysAgo += 1) {
    const dayKey = localDayKey(date.getTime());
    paths.push(path.join(logDir, `zcode-${dayKey}.jsonl`));
    date.setDate(date.getDate() - 1);
  }
  return paths;
}

function userHashForText(text) {
  if (typeof text !== "string" || !text) return "";
  return createHash("sha256").update(text).digest("hex");
}

class ZcodeLogMonitor {
  constructor(agentConfig, onState) {
    this.config = { ...defaults, ...(agentConfig || {}) };
    this.onState = typeof onState === "function" ? onState : () => {};
    this.timer = null;
    this.files = new Map();
    this.sessions = new Map();
    this.watchers = new Map();
    this.dirtyFiles = new Set();
    this.suppressEmit = false;
    this.zcodeDb = null;
    this.dbRetryNotBefore = 0;
    this.userInputStmt = null;
    this.userInputStmtDb = null;
    this.sessionRowStmt = null;
    this.sessionRowStmtDb = null;
  }

  start() {
    if (this.timer) return;
    this.refreshWatchers();
    this.baselineExistingSessions();
    this.timer = setInterval(() => this.poll(), this.config.POLL_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const watcher of this.watchers.values()) {
      try {
        watcher.close();
      } catch {}
    }
    this.watchers.clear();
    this.dirtyFiles.clear();
    this.closeDb();
  }

  dayFilePaths(now = Date.now()) {
    return dayLogFilePaths(this.config.LOG_DIR, now, this.config.LOOKBACK_DAYS);
  }

  refreshWatchers() {
    if (this.config.WATCH_FILES === false || this.watchers.size > 0) return;
    const root = this.config.LOG_DIR;
    try {
      const watcher = fs.watch(root, { persistent: false }, (_eventType, rawFileName) => {
        const fileName = Buffer.isBuffer(rawFileName)
          ? rawFileName.toString("utf8")
          : String(rawFileName || "");
        if (!isDayLogFileName(fileName)) return;
        this.dirtyFiles.add(path.join(root, fileName));
      });
      watcher.on("error", () => {
        try {
          watcher.close();
        } catch {}
        this.watchers.delete(root);
      });
      this.watchers.set(root, watcher);
    } catch {
      // The periodic poll remains the fallback on unsupported filesystems.
    }
  }

  baselineExistingSessions() {
    const staleTimeoutMs = Math.max(
      1_000,
      Number(this.config.STALE_TIMEOUT_MS) || 300_000,
    );
    const now = Date.now();
    this.suppressEmit = true;
    try {
      for (const filePath of this.dayFilePaths(now)) {
        let stat;
        try {
          stat = fs.statSync(filePath);
        } catch {
          continue;
        }
        if (stat.size <= 0) continue;
        const initialTailBytes = Math.max(0, Number(this.config.INITIAL_TAIL_BYTES) || 0);
        const offset = initialTailBytes > 0 && stat.size > initialTailBytes
          ? stat.size - initialTailBytes
          : 0;
        this.files.set(filePath, { offset, partial: "", dropFirstLine: offset > 0 });
        this.pollFile(filePath);
      }
    } finally {
      this.suppressEmit = false;
    }
    // A bounded tail cannot distinguish a two-hour-old finished turn from a
    // live one by position alone; the source event time decides, exactly as
    // in restoreFileState of the Codex monitor.
    for (const entry of this.sessions.values()) {
      if (!RESTORABLE_ACTIVE_STATES.has(entry.lastState)) continue;
      if (!Number.isFinite(entry.lastSourceEventTime)
          || entry.lastSourceEventTime <= 0
          || entry.lastSourceEventTime < now - staleTimeoutMs
          || entry.lastSourceEventTime > now + staleTimeoutMs) {
        continue;
      }
      entry.lastEmitFingerprint = "";
      this.emit(entry, entry.lastState, entry.lastEvent || "zcode.session.restore");
    }
  }

  poll() {
    const dayFiles = new Set(this.dayFilePaths());

    for (const filePath of this.dirtyFiles) {
      this.dirtyFiles.delete(filePath);
      if (!dayFiles.has(filePath)) continue;
      if (!this.files.has(filePath)) this.trackFileCursor(filePath);
      else this.pollFile(filePath);
    }

    for (const filePath of this.files.keys()) {
      if (!dayFiles.has(filePath)) {
        this.files.delete(filePath);
        continue;
      }
      this.pollFile(filePath);
    }

    // Day rollover: attach the new day's file and only ever read appends from
    // it, never its pre-existing history.
    for (const filePath of dayFiles) {
      if (!this.files.has(filePath)) this.trackFileCursor(filePath);
    }
  }

  trackFileCursor(filePath) {
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return;
    }
    // A cursor that starts at the current end only sees live appends.
    this.files.set(filePath, { offset: stat.size, partial: "", dropFirstLine: false });
  }

  pollFile(filePath) {
    const cursor = this.files.get(filePath);
    if (!cursor) return;

    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return;
    }
    // Tolerate rotation/truncation: a shrunken file restarts from zero.
    if (stat.size < cursor.offset) {
      cursor.offset = 0;
      cursor.partial = "";
      cursor.dropFirstLine = false;
    }
    if (stat.size <= cursor.offset) return;

    let buffer;
    try {
      const fd = fs.openSync(filePath, "r");
      const readLen = stat.size - cursor.offset;
      buffer = Buffer.alloc(readLen);
      fs.readSync(fd, buffer, 0, readLen, cursor.offset);
      fs.closeSync(fd);
    } catch {
      return;
    }
    cursor.offset = stat.size;

    const text = cursor.partial + buffer.toString("utf8");
    const lines = text.split("\n");
    cursor.partial = lines.pop() || "";
    if (cursor.dropFirstLine) {
      lines.shift();
      cursor.dropFirstLine = false;
    }

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      this.processLine(line);
    }
  }

  processLine(line) {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      return;
    }
    if (!obj || typeof obj !== "object") return;

    const sessionId = typeof obj.sessionId === "string" ? obj.sessionId : "";
    if (!sessionId || isSubagentSession(sessionId)) return;

    const eventName = typeof obj.event === "string" ? obj.event : "";
    const state = mapLogEvent(eventName, this.config.LOG_EVENT_MAP);
    if (!state && !EVIDENCE_EVENTS.has(eventName)) return;

    const entry = this.ensureSession(sessionId);
    const timestampMs = readTimestampMs(obj.timestamp) || Date.now();
    const context = obj.context && typeof obj.context === "object" ? obj.context : null;
    const turnId = typeof obj.turnId === "string" ? obj.turnId : "";
    entry.lastSourceEventTime = timestampMs;

    if (eventName === "turn.started") {
      entry.turnActive = true;
      if (turnId) entry.turnId = turnId;
      entry.startedAt = timestampMs;
      entry.completedAt = undefined;
      entry.durationMs = undefined;
      entry.completedWork = false;
      // ZCode logs carry no user text; the latest input_history row before
      // this turn is hashed for receipt correlation. context.inputLength is
      // diagnostic-only and never participates in the decision, and any
      // sqlite problem degrades to no correlation.
      entry.lastUserHash = this.lookupUserHash(sessionId, timestampMs);
    } else if (eventName === "tool.call.completed") {
      if (entry.turnActive && entry.turnId && turnId === entry.turnId) {
        entry.completedWork = true;
      }
      return;
    } else if (eventName === "turn.completed") {
      entry.turnActive = false;
      if (turnId) entry.turnId = turnId;
      entry.completedAt = timestampMs;
      entry.durationMs = readNumber(obj.durationMs) ?? readNumber(context?.durationMs);
      if (readNumber(context?.toolCallCount) > 0) entry.completedWork = true;
    } else if (eventName === "turn.failed" || eventName === "model.request.failed") {
      entry.turnActive = false;
    } else if (eventName === "tool.call.started") {
      const toolName = typeof context?.toolName === "string" ? context.toolName : "";
      if (toolName) entry.lastToolName = compactText(toolName, 80);
    }

    if (!state) return;
    entry.lastState = state;
    entry.lastEvent = eventName;
    entry.lastEventTime = Date.now();
    this.emit(entry, state, eventName);
  }

  ensureSession(sessionId) {
    let entry = this.sessions.get(sessionId);
    if (entry) {
      this.sessions.delete(sessionId);
      this.sessions.set(sessionId, entry);
      return entry;
    }
    entry = {
      sessionId,
      cwd: "",
      sessionTitle: "",
      lastState: null,
      lastEvent: "",
      lastEventTime: Date.now(),
      lastSourceEventTime: 0,
      lastEmitFingerprint: "",
      turnActive: false,
      turnId: "",
      startedAt: undefined,
      completedAt: undefined,
      durationMs: undefined,
      completedWork: false,
      lastToolName: "",
      lastUserHash: "",
    };
    while (this.sessions.size >= MAX_TRACKED_SESSIONS) {
      const oldest = [...this.sessions.values()]
        .sort((a, b) => (a.lastSourceEventTime || 0) - (b.lastSourceEventTime || 0))[0];
      if (!oldest) break;
      this.sessions.delete(oldest.sessionId);
    }
    this.sessions.set(sessionId, entry);
    return entry;
  }

  ensureTitle(entry) {
    if (entry.sessionTitle) return entry.sessionTitle;
    const row = this.querySessionRow(entry.sessionId);
    if (row) {
      if (typeof row.directory === "string" && row.directory && !entry.cwd) {
        entry.cwd = row.directory;
      }
      const title = compactText(row.title, MAX_SESSION_TITLE);
      if (title) {
        entry.sessionTitle = title;
        return title;
      }
    }
    entry.sessionTitle = TEXT_SESSION_FALLBACK;
    return entry.sessionTitle;
  }

  ensureDb() {
    if (this.zcodeDb) return this.zcodeDb;
    if (Date.now() < this.dbRetryNotBefore) return null;
    const dbPath = this.config.DB_PATH;
    if (!dbPath || !fs.existsSync(dbPath)) return null;
    try {
      // Node 22+ ships this module. A missing optional API keeps the
      // log-following path alive with correlation disabled.
      const { DatabaseSync } = require("node:sqlite");
      this.zcodeDb = new DatabaseSync(dbPath, { readOnly: true });
      return this.zcodeDb;
    } catch {
      this.dbRetryNotBefore = Date.now() + DB_RETRY_COOLDOWN_MS;
      return null;
    }
  }

  closeDb() {
    if (this.zcodeDb) {
      try { this.zcodeDb.close(); } catch {}
    }
    this.zcodeDb = null;
    this.userInputStmt = null;
    this.userInputStmtDb = null;
    this.sessionRowStmt = null;
    this.sessionRowStmtDb = null;
  }

  noteDbFailure() {
    this.closeDb();
    this.dbRetryNotBefore = Date.now() + DB_RETRY_COOLDOWN_MS;
  }

  preparedStatement(kind, sql) {
    const db = this.zcodeDb;
    if (!db) return null;
    const stmtKey = `${kind}Stmt`;
    const stmtDbKey = `${kind}StmtDb`;
    if (this[stmtDbKey] !== db) {
      try {
        this[stmtKey] = db.prepare(sql);
      } catch {
        this.noteDbFailure();
        return null;
      }
      this[stmtDbKey] = db;
    }
    return this[stmtKey];
  }

  lookupUserHash(sessionId, timestampMs) {
    try {
      if (!this.ensureDb()) return "";
      const stmt = this.preparedStatement("userInput", USER_INPUT_SQL);
      if (!stmt) return "";
      const row = stmt.get(sessionId, timestampMs);
      return userHashForText(typeof row?.text === "string" ? row.text : "");
    } catch {
      this.noteDbFailure();
      return "";
    }
  }

  querySessionRow(sessionId) {
    try {
      if (!this.ensureDb()) return null;
      const stmt = this.preparedStatement("sessionRow", SESSION_ROW_SQL);
      if (!stmt) return null;
      return stmt.get(sessionId) || null;
    } catch {
      this.noteDbFailure();
      return null;
    }
  }

  buildExtra(entry, state, event) {
    const sessionTitle = this.ensureTitle(entry);
    return {
      cwd: entry.cwd || "",
      sessionTitle,
      session: {
        id: entry.sessionId,
        title: sessionTitle,
        cwd: entry.cwd || "",
      },
      turn: {
        turnId: entry.turnId || "",
        startedAt: entry.startedAt || undefined,
        completedAt: entry.completedAt || undefined,
        durationMs: entry.durationMs || undefined,
        completedWork: entry.completedWork === true,
      },
      // Correlate voice delegation without exporting any user text.
      taskCorrelation: {
        userHash: entry.lastUserHash || "",
        turnId: entry.turnId || "",
        turnActive: entry.turnActive === true,
      },
    };
  }

  emit(entry, state, event) {
    if (this.suppressEmit) return;
    const extra = this.buildExtra(entry, state, event);
    const fingerprint = JSON.stringify({
      state,
      event,
      taskCorrelation: extra.taskCorrelation,
      completedWork: extra.turn.completedWork,
    });
    if (entry.lastEmitFingerprint === fingerprint) return;
    entry.lastEmitFingerprint = fingerprint;

    try {
      this.onState(entry.sessionId, state, event, extra);
    } catch {}
  }
}

module.exports = ZcodeLogMonitor;
module.exports.isSubagentSession = isSubagentSession;
module.exports.isDayLogFileName = isDayLogFileName;
module.exports.mapLogEvent = mapLogEvent;
module.exports.dayLogFilePaths = dayLogFilePaths;
module.exports.userHashForText = userHashForText;
