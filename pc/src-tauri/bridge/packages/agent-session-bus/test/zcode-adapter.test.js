"use strict";

/*
 * [Input] A temporary ZCode home with either a real sqlite session store, a corrupted one, or none at all.
 * [Output] Regression coverage for install detection, bounded read-only session listing, and the voice-input unsupported contract.
 * [Pos] Node tests for the agent-session-bus ZCode adapter.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { ZcodeAdapter } = require("../src/adapters/zcode");
const { resolveZcodePaths } = require("../../../agents/zcode");

let DatabaseSync;
try { ({ DatabaseSync } = require("node:sqlite")); } catch {}

const UNSUPPORTED_INPUT = {
  kind: "error",
  code: "AGENT_INPUT_UNSUPPORTED",
  message: "ZCode 语音输入使用桌面客户端的当前可见输入框，不支持后台会话注入；不会转发到其他 Agent。",
};

function fakeHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bus-zcode-test-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

function adapterFor(home, extraOptions = {}) {
  return new ZcodeAdapter({ home, env: {}, platform: process.platform, log: () => {}, ...extraOptions });
}

test("resolveZcodePaths pins CLAWD_ZCODE_HOME ahead of the user home", () => {
  const pinned = resolveZcodePaths({ env: { CLAWD_ZCODE_HOME: "D:\\zcode-home" }, home: "C:\\users\\x" });
  assert.equal(pinned.home, "D:\\zcode-home");
  assert.equal(pinned.dbPath, path.join("D:\\zcode-home", "cli", "db", "db.sqlite"));

  const defaults = resolveZcodePaths({ env: {}, home: path.join("base", "home") });
  assert.equal(defaults.home, path.join(path.join("base", "home"), ".zcode"));
  assert.equal(defaults.logDir, path.join(defaults.home, "cli", "log"));

  const win = resolveZcodePaths({
    env: { LOCALAPPDATA: "/local", ProgramFiles: "/programs" },
    home: "/fixture",
    platform: "win32",
  });
  assert.deepEqual(win.apps, [
    path.join("/local", "Programs", "ZCode", "ZCode.exe"),
    path.join("/programs", "ZCode", "ZCode.exe"),
  ]);
  assert.deepEqual(resolveZcodePaths({ env: {}, home: "/fixture", platform: "darwin" }).apps, ["/Applications/ZCode.app"]);
});

test("isAvailable reports not ready for an empty fake home", async (t) => {
  const empty = fakeHome(t);
  const probe = await adapterFor(empty).isAvailable();
  assert.deepEqual(probe, { ready: false, reason: "未检测到 ZCode" });
});

test("isAvailable accepts the CLI activity store as installation evidence", async (t) => {
  const home = fakeHome(t);
  const dbPath = resolveZcodePaths({ env: {}, home, platform: process.platform }).dbPath;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.writeFileSync(dbPath, "");
  const probe = await adapterFor(home).isAvailable();
  assert.equal(probe.ready, true);
  assert.match(probe.reason, /请打开 ZCode 目标对话/);
});

test("isAvailable accepts a Windows app install without any activity store", async (t) => {
  const home = fakeHome(t);
  const local = path.join(home, "local");
  const exe = path.join(local, "Programs", "ZCode", "ZCode.exe");
  fs.mkdirSync(path.dirname(exe), { recursive: true });
  fs.writeFileSync(exe, "");
  const probe = await adapterFor(home, {
    env: { LOCALAPPDATA: local },
    platform: "win32",
  }).isAvailable();
  assert.equal(probe.ready, true);
});

test("inject always yields the exact AGENT_INPUT_UNSUPPORTED error and never forwards", async (t) => {
  const adapter = adapterFor(fakeHome(t));
  const iterator = adapter.inject({ sessionId: "auto", text: "语音内容" });
  const first = await iterator.next();
  assert.equal(first.done, false);
  assert.deepEqual(first.value, UNSUPPORTED_INPUT);
  const second = await iterator.next();
  assert.equal(second.done, true);
  assert.equal(second.value, undefined);
});

test("openNew refuses with the client-side guidance message", async (t) => {
  await assert.rejects(
    adapterFor(fakeHome(t)).openNew({ cwd: "/tmp" }),
    /请在 ZCode 中新建会话/,
  );
});

if (DatabaseSync) test("listSessions returns [] when the activity store is missing", async (t) => {
  const adapter = adapterFor(fakeHome(t));
  assert.deepEqual(await adapter.listSessions(), []);
});

if (DatabaseSync) test("listSessions maps main sessions newest-first, excluding subagents and deleted rows", async (t) => {
  const home = fakeHome(t);
  const dbPath = resolveZcodePaths({ env: {}, home, platform: process.platform }).dbPath;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY, title TEXT, directory TEXT,
      time_created INTEGER, time_updated INTEGER, time_deleted INTEGER
    );
  `);
  const insert = db.prepare(
    "INSERT INTO session (id, title, directory, time_created, time_updated, time_deleted) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const now = Date.now();
  insert.run("sess_aaa_main", "主会话 A", "C:\\proj", now - 9000, now - 1000, null);
  insert.run("sess_bbb_main", "", "C:\\proj2", now - 8000, now - 2000, null);
  insert.run("sess_subagent_agent_fff", "子代理", "C:\\proj", now - 500, now - 500, null);
  insert.run("sess_ccc_deleted", "已删除", "C:\\proj", now - 100, now - 100, now - 90);
  db.close();

  const adapter = adapterFor(home);
  const sessions = await adapter.listSessions();
  assert.deepEqual(sessions.map((session) => session.id), ["sess_aaa_main", "sess_bbb_main"]);
  assert.equal(sessions[0].name, "主会话 A");
  assert.equal(sessions[0].summary, "主会话 A");
  assert.equal(sessions[0].cwd, "C:\\proj");
  assert.equal(sessions[0].lastModified, now - 1000);
  // Untitled rows keep an honest placeholder title.
  assert.equal(sessions[1].name, "ZCode 会话");
  assert.equal(sessions[1].lastModified, now - 2000);

  // Bounded: limit is honored and clamped.
  assert.deepEqual((await adapter.listSessions({ limit: 1 })).map((session) => session.id), ["sess_aaa_main"]);
  const all = await adapter.listSessions({ limit: 999 });
  assert.equal(all.length, 2);
  // Release the read-only handle before the temporary home is removed.
  adapter._closeDb();
});

if (DatabaseSync) test("listSessions stays bounded at 50 rows and degrades on corruption", async (t) => {
  const home = fakeHome(t);
  const dbPath = resolveZcodePaths({ env: {}, home, platform: process.platform }).dbPath;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY, title TEXT, directory TEXT,
      time_created INTEGER, time_updated INTEGER, time_deleted INTEGER
    );
  `);
  const insert = db.prepare(
    "INSERT INTO session (id, title, directory, time_created, time_updated, time_deleted) VALUES (?, ?, ?, ?, ?, NULL)",
  );
  for (let index = 0; index < 60; index += 1) {
    insert.run(`sess_${String(index).padStart(3, "0")}_main`, `会话 ${index}`, "C:\\proj", index, index);
  }
  db.close();

  const adapter = adapterFor(home);
  t.after(() => adapter._closeDb());
  assert.equal((await adapter.listSessions({ limit: 200 })).length, 50);
  assert.equal((await adapter.listSessions())[0].id, "sess_059_main");
  adapter._closeDb();

  // Corruption: the next listing degrades to [] instead of throwing.
  fs.writeFileSync(dbPath, "not a database at all, with enough filler bytes to be convincing");
  const broken = adapterFor(home);
  assert.deepEqual(await broken.listSessions(), []);
});
