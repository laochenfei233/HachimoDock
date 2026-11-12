"use strict";

/*
 * [Input] Synthetic ZCode daily JSONL lines and a temporary sqlite session store.
 * [Output] Regression coverage for event mapping, subagent exclusion, day-rollover file selection, hashed user receipts, and corrupted-store degradation.
 * [Pos] Unit tests for the managed bridge's ZCode log monitor.
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { test } = require("node:test");

const ZcodeLogMonitor = require("../agents/zcode-log-monitor");
const zcodeDefaults = require("../agents/zcode");
const {
  isSubagentSession,
  isDayLogFileName,
  mapLogEvent,
  dayLogFilePaths,
  userHashForText,
} = ZcodeLogMonitor;
const { SessionMetricsTracker } = require("../packages/clawd-backend-service/src/status-metrics");

let DatabaseSync;
try { ({ DatabaseSync } = require("node:sqlite")); } catch {}

const MAIN_SESSION = "sess_1f0d5a52-2ac1-4a5f-9a30-f67d34f27f12";
const SUBAGENT_SESSION = "sess_subagent_agent_1ec7220f-4774-41f7-aed4-bfbb2945b1ed";
const USER_TEXT = "帮我把宠物状态接入 ZCode 会话";
const FIXTURE_DIRECTORY = "C:\\fixture\\project";

function iso(msAhead = 0) {
  return new Date(Date.now() + msAhead).toISOString();
}

function logLine(event, sessionId, extra = {}) {
  return JSON.stringify({
    timestamp: extra.timestamp || iso(),
    level: "info",
    event,
    module: "core.runtime",
    message: extra.message || event,
    ...(extra.turnId ? { turnId: extra.turnId } : {}),
    ...(extra.durationMs !== undefined ? { durationMs: extra.durationMs } : {}),
    sessionId,
    ...(extra.context && typeof extra.context === "object" ? { context: extra.context } : {}),
  });
}

function createFixtureDb({ corrupt = false } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-log-monitor-db-"));
  const dbPath = path.join(home, "db.sqlite");
  if (corrupt) {
    fs.writeFileSync(dbPath, "this is not a sqlite database, just filler bytes");
    return { home, dbPath };
  }
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY, title TEXT, directory TEXT,
      time_created INTEGER, time_updated INTEGER, time_deleted INTEGER
    );
    CREATE TABLE input_history (
      id TEXT PRIMARY KEY, session_id TEXT, text TEXT,
      kind TEXT, time_created INTEGER
    );
  `);
  db.prepare(
    "INSERT INTO session (id, title, directory, time_created, time_updated, time_deleted) VALUES (?, ?, ?, ?, ?, NULL)",
  ).run(MAIN_SESSION, "接入 ZCode 会话", FIXTURE_DIRECTORY, Date.now() - 60000, Date.now() - 1000);
  db.prepare(
    "INSERT INTO input_history (id, session_id, text, kind, time_created) VALUES (?, ?, ?, 'prompt', ?)",
  ).run("input_fixture", MAIN_SESSION, USER_TEXT, Date.now() - 4000);
  db.close();
  return { home, dbPath };
}

function createMonitor(t, { dbPath, home } = {}) {
  const events = [];
  const logDir = home || fs.mkdtempSync(path.join(os.tmpdir(), "zcode-log-monitor-"));
  const monitor = new ZcodeLogMonitor({
    LOG_DIR: logDir,
    DB_PATH: dbPath || "",
    WATCH_FILES: false,
  }, (sessionId, state, event, extra) => {
    events.push({ sessionId, state, event, extra });
  });
  // stop() closes any cached read-only sqlite handle first so Windows can
  // remove the temporary directories afterwards (after hooks run in order).
  t.after(() => {
    monitor.stop();
    if (!home) fs.rmSync(logDir, { recursive: true, force: true });
  });
  return { monitor, events, logDir, todayFile: monitor.dayFilePaths()[0] };
}

function cleanupFixtureDb(t, home) {
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
}

test("ZCode LOG_EVENT_MAP entries all map through the pure helper", () => {
  const entries = Object.entries(zcodeDefaults.LOG_EVENT_MAP);
  assert.ok(entries.length >= 7);
  for (const [eventName, state] of entries) {
    assert.equal(mapLogEvent(eventName), state, eventName);
  }
  assert.equal(mapLogEvent("tool.call.completed"), "");
  assert.equal(mapLogEvent("zcode_protocol.session.lifecycle_changed"), "");
  assert.equal(mapLogEvent(""), "");
  assert.equal(mapLogEvent(undefined), "");
  assert.equal(mapLogEvent("turn.started", {}), "");
});

test("subagent sessions are excluded by prefix before any state is tracked", (t) => {
  assert.equal(isSubagentSession(SUBAGENT_SESSION), true);
  assert.equal(isSubagentSession(MAIN_SESSION), false);
  assert.equal(isSubagentSession(""), false);
  assert.equal(isSubagentSession(undefined), false);

  const { monitor, events } = createMonitor(t);
  monitor.processLine(logLine("turn.started", SUBAGENT_SESSION, {
    turnId: "turn_sub", context: { inputLength: 48, telemetry: { inputOrigin: "desktop" } },
  }));
  monitor.processLine(logLine("turn.completed", SUBAGENT_SESSION, {
    turnId: "turn_sub", context: { toolCallCount: 3 },
  }));
  assert.equal(events.length, 0);
  assert.equal(monitor.sessions.size, 0);
});

test("day file selection covers today plus yesterday and rejects other names", () => {
  const noon = new Date();
  noon.setHours(12, 0, 0, 0);
  const paths = dayLogFilePaths(path.join("log", "dir"), noon.getTime(), 2);
  assert.equal(paths.length, 2);
  assert.match(paths[0], /zcode-\d{4}-\d{2}-\d{2}\.jsonl$/);
  const [today, yesterday] = paths;
  assert.notEqual(today, yesterday);
  assert.deepEqual(dayLogFilePaths(path.join("log", "dir"), noon.getTime(), 1), [today]);

  const yesterdayDate = new Date(noon);
  yesterdayDate.setDate(yesterdayDate.getDate() - 1);
  assert.equal(
    path.basename(yesterday),
    `zcode-${yesterdayDate.getFullYear()}-${String(yesterdayDate.getMonth() + 1).padStart(2, "0")}-${String(yesterdayDate.getDate()).padStart(2, "0")}.jsonl`,
  );

  assert.equal(isDayLogFileName("zcode-2026-11-12.jsonl"), true);
  assert.equal(isDayLogFileName("zcode-2026-11-12.jsonl.tmp"), false);
  assert.equal(isDayLogFileName("other.txt"), false);
  assert.equal(isDayLogFileName(undefined), false);
});

test("user hashes are plain sha-256 hex digests of the stored input text", () => {
  assert.equal(userHashForText(USER_TEXT), createHash("sha256").update(USER_TEXT).digest("hex"));
  assert.match(userHashForText(USER_TEXT), /^[a-f0-9]{64}$/);
  assert.equal(userHashForText(""), "");
  assert.equal(userHashForText(null), "");
});

if (DatabaseSync) test("turn.started correlates the latest input_history row into a 64-hex user hash", (t) => {
  const { home: dbHome, dbPath } = createFixtureDb();
  const { monitor, events } = createMonitor(t, { dbPath });
  cleanupFixtureDb(t, dbHome);
  monitor.processLine(logLine("turn.started", MAIN_SESSION, {
    timestamp: iso(-2000),
    turnId: "turn_corr",
    context: { inputLength: USER_TEXT.length, telemetry: { inputOrigin: "desktop" } },
  }));

  assert.equal(events.length, 1);
  assert.equal(events[0].state, "thinking");
  assert.equal(events[0].event, "turn.started");
  assert.equal(events[0].extra.taskCorrelation.userHash, userHashForText(USER_TEXT));
  assert.match(events[0].extra.taskCorrelation.userHash, /^[a-f0-9]{64}$/);
  assert.equal(events[0].extra.taskCorrelation.turnId, "turn_corr");
  assert.equal(events[0].extra.taskCorrelation.turnActive, true);
  assert.equal(events[0].extra.sessionTitle, "接入 ZCode 会话");
  assert.equal(events[0].extra.cwd, FIXTURE_DIRECTORY);
  assert.equal(events[0].extra.session.id, MAIN_SESSION);
  // Direct helper agrees with the emitted correlation.
  assert.equal(monitor.lookupUserHash(MAIN_SESSION, Date.now()), userHashForText(USER_TEXT));
  // A query bounded before the input records nothing.
  assert.equal(monitor.lookupUserHash(MAIN_SESSION, Date.now() - 30000), "");
  // Unknown sessions correlate to nothing.
  assert.equal(monitor.lookupUserHash("sess_unknown", Date.now()), "");
});

if (DatabaseSync) test("a corrupted session store degrades to no correlation without stopping state following", (t) => {
  const { home: dbHome, dbPath } = createFixtureDb({ corrupt: true });
  const { monitor, events } = createMonitor(t, { dbPath });
  cleanupFixtureDb(t, dbHome);
  monitor.processLine(logLine("turn.started", MAIN_SESSION, {
    turnId: "turn_bad_db", context: { inputLength: 10 },
  }));
  monitor.processLine(logLine("tool.call.started", MAIN_SESSION, {
    turnId: "turn_bad_db", context: { toolName: "Bash" },
  }));

  assert.equal(events.length, 2);
  assert.equal(events[0].extra.taskCorrelation.userHash, "");
  assert.equal(events[1].state, "working");
  assert.equal(events[1].event, "tool.call.started");
  // The fallback title keeps the card honest without any sqlite access.
  assert.equal(events[1].extra.sessionTitle, "ZCode 会话");
});

test("the full event set flows through one day file in order with completion evidence", (t) => {
  const { monitor, events, logDir, todayFile } = createMonitor(t);
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(todayFile, "");
  monitor.baselineExistingSessions();
  monitor.poll();

  const turnId = "turn_live";
  const lines = [
    logLine("turn.started", MAIN_SESSION, { turnId, timestamp: iso(-9000), context: { inputLength: 20 } }),
    logLine("model.request.started", MAIN_SESSION, { turnId, timestamp: iso(-8500) }),
    logLine("tool.call.started", MAIN_SESSION, { turnId, timestamp: iso(-8000), context: { toolName: "Bash" } }),
    logLine("tool.call.completed", MAIN_SESSION, { turnId, timestamp: iso(-7000), context: { toolName: "Bash" } }),
    logLine("ttft.model.first_content", MAIN_SESSION, { turnId, timestamp: iso(-6000) }),
    logLine("turn.completed", MAIN_SESSION, {
      turnId, timestamp: iso(-5000), durationMs: 4000.5, context: { toolCallCount: 1 },
    }),
  ];
  fs.appendFileSync(todayFile, `${lines.join("\n")}\n`);
  monitor.poll();

  assert.deepEqual(events.map((event) => [event.state, event.event]), [
    ["thinking", "turn.started"],
    ["thinking", "model.request.started"],
    ["working", "tool.call.started"],
    ["speaking", "ttft.model.first_content"],
    ["attention", "turn.completed"],
  ]);
  const completed = events.at(-1);
  assert.equal(completed.extra.turn.completedWork, true);
  assert.equal(completed.extra.turn.completedAt > 0, true);
  assert.equal(completed.extra.turn.durationMs, 4000.5);
  assert.equal(completed.extra.taskCorrelation.turnActive, false);
  // tool.call.completed is evidence only and never its own state event.
  assert.ok(!events.some((event) => event.event === "tool.call.completed"));

  // A turn with no tool evidence completes without completedWork.
  const quietId = "turn_quiet";
  fs.appendFileSync(todayFile, `\n${[
    logLine("turn.started", MAIN_SESSION, { turnId: quietId, timestamp: iso(-2000) }),
    logLine("turn.completed", MAIN_SESSION, {
      turnId: quietId, timestamp: iso(-1000), context: { toolCallCount: 0 },
    }),
  ].join("\n")}\n`);
  monitor.poll();
  const quietCompleted = events.at(-1);
  assert.equal(quietCompleted.state, "attention");
  assert.equal(quietCompleted.extra.turn.completedWork, false);

  // Failure events move the session to error and close the turn.
  fs.appendFileSync(todayFile, `\n${[
    logLine("turn.started", MAIN_SESSION, { turnId: "turn_boom", timestamp: iso(-500) }),
    logLine("model.request.failed", MAIN_SESSION, { turnId: "turn_boom", timestamp: iso(-400) }),
  ].join("\n")}\n`);
  fs.appendFileSync(todayFile, `\n${logLine("turn.started", MAIN_SESSION, { turnId: "turn_boom2", timestamp: iso(-300) })}\n`);
  fs.appendFileSync(todayFile, `\n${logLine("turn.failed", MAIN_SESSION, { turnId: "turn_boom2", timestamp: iso(-200) })}\n`);
  monitor.poll();
  assert.deepEqual(events.slice(-3).map((event) => [event.state, event.event]), [
    ["error", "model.request.failed"],
    ["thinking", "turn.started"],
    ["error", "turn.failed"],
  ]);
  assert.equal(events.at(-1).extra.taskCorrelation.turnActive, false);
});

test("truncated or rotated day files restart their byte cursor without losing live events", (t) => {
  const { monitor, events, logDir, todayFile } = createMonitor(t);
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(todayFile, "");
  monitor.baselineExistingSessions();
  monitor.poll();

  fs.appendFileSync(todayFile, `${logLine("turn.started", MAIN_SESSION, { turnId: "turn_a", timestamp: iso(-5000) })}\n`);
  monitor.poll();
  assert.equal(events.length, 1);

  // A truncation shrinks the file below the cursor; the next poll resets and
  // re-reads only the replacement content.
  fs.writeFileSync(todayFile, `${logLine("turn.failed", MAIN_SESSION, { turnId: "turn_a", timestamp: iso(-4000) })}\n`);
  monitor.poll();
  assert.deepEqual(events.map((event) => event.event), ["turn.started", "turn.failed"]);
  assert.equal(monitor.files.get(todayFile).offset, fs.statSync(todayFile).size);
});

test("startup restores only fresh active states from the bounded tail", (t) => {
  const { monitor, events, logDir, todayFile } = createMonitor(t);
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(todayFile, `${[
    logLine("turn.started", MAIN_SESSION, { turnId: "turn_fresh", timestamp: iso(-2000) }),
    logLine("tool.call.started", MAIN_SESSION, { turnId: "turn_fresh", timestamp: iso(-1000), context: { toolName: "Edit" } }),
    logLine("turn.started", "sess_stale_session_0000", { turnId: "turn_stale", timestamp: iso(-10 * 60_000) }),
  ].join("\n")}\n`);

  monitor.baselineExistingSessions();

  assert.deepEqual(events.map((event) => [event.sessionId, event.state, event.event]), [
    [MAIN_SESSION, "working", "tool.call.started"],
  ]);
  assert.equal(monitor.sessions.get("sess_stale_session_0000").lastState, "thinking");
  // Restored events replay cleanly after the suppressed baseline read.
  assert.equal(events[0].extra.turn.completedWork, false);
});

test("session tracking stays bounded by oldest source activity", (t) => {
  const { monitor } = createMonitor(t);
  for (let index = 0; index < 300; index += 1) {
    monitor.processLine(logLine("turn.started", `sess_${String(index).padStart(4, "0")}`, {
      timestamp: iso(-index * 1000),
    }));
  }
  assert.equal(monitor.sessions.size, 256);
  // Newest inserts always survive; the evicted band is the oldest activity.
  assert.equal(monitor.sessions.has("sess_0299"), true);
  assert.equal(monitor.sessions.has("sess_0000"), true);
  assert.equal(monitor.sessions.has("sess_0255"), false);
});

test("metrics tracker treats zcode events as a new turn with tool evidence and receipts", () => {
  const tracker = new SessionMetricsTracker();
  const base = {
    source: "zcode",
    channel: "zcode-log",
    sessionId: MAIN_SESSION,
    sessionTitle: "接入 ZCode 会话",
    turn: {},
    taskCorrelation: {
      userHash: userHashForText(USER_TEXT),
      turnId: "turn_metrics",
      turnActive: true,
    },
    ts: iso(),
    tsMs: Date.now(),
  };

  // Capture the stream position before the applies so the recorded page
  // contains this test's lifecycle events.
  const baseline = tracker.sessionEvents("zcode");

  // A terminal state followed by the next turn start must not be preserved away.
  const done = tracker.apply({ ...base, state: "done", event: "turn.completed", reason: "zcode.turn.completed", turn: { completedWork: true } });
  assert.equal(done.state, "done");
  const restarted = tracker.apply({ ...base, state: "thinking", event: "turn.started", reason: "zcode.turn.started" });
  assert.equal(restarted.state, "thinking");

  // tool.call.started counts exactly one tool call per distinct tool step.
  const tool = tracker.apply({ ...base, state: "working", event: "tool.call.started", reason: "zcode.tool.call.started" });
  assert.equal(tool.metrics.toolCalls, 1);
  const toolAgain = tracker.apply({ ...base, state: "working", event: "tool.call.started", reason: "zcode.tool.call.started", ts: iso(), tsMs: Date.now() + 1 });
  assert.equal(toolAgain.metrics.toolCalls, 1);

  // The accepted receipt lands on the session record's lifecycle event stream.
  const recorded = tracker.sessionEvents("zcode", { cursor: baseline.cursor, streamId: baseline.streamId });
  assert.ok(recorded.events.some((event) => event.taskCorrelation?.userHash === base.taskCorrelation.userHash));

  // A malformed hash is not accepted as a receipt.
  tracker.apply({ ...base, taskCorrelation: { userHash: "not-a-hash", turnId: "turn_metrics", turnActive: false } });
  const afterBad = tracker.sessionEvents("zcode", { cursor: recorded.cursor, streamId: recorded.streamId });
  const badReceipt = afterBad.events.filter((event) => event.taskCorrelation).at(-1);
  assert.equal(badReceipt.taskCorrelation.userHash, "");
  assert.ok(!badReceipt.taskCorrelation.browserContextNormalized);
});
