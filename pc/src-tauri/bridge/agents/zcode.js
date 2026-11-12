"use strict";

/*
 * [Input] ZCode structured daily JSONL logs, optionally pinned by CLAWD_ZCODE_HOME.
 * [Output] Polling defaults and path resolution consumed by zcode-log-monitor and the bus adapter.
 * [Pos] Agent-specific monitor config for the headless bridge.
 * [Sync] If ZCode log discovery changes, update `pc/.folder.md`.
 */

const os = require("os");
const path = require("path");

const POLL_INTERVAL_MS = 1500;

function envValue(env, name) {
  const value = env ? env[name] : undefined;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : "";
}

/**
 * Resolve ZCode installation paths. `CLAWD_ZCODE_HOME` pins the ZCode home
 * directory (normally `~/.zcode`); `home` overrides the user home for tests.
 * The desktop app dirs are install probes only — activity always comes from
 * the CLI-owned log/db files under the home directory.
 */
function resolveZcodePaths({ env = process.env, home, platform = process.platform } = {}) {
  const explicit = envValue(env, "CLAWD_ZCODE_HOME");
  const baseHome = home || envValue(env, "HOME") || envValue(env, "USERPROFILE") || os.homedir();
  const zcodeHome = explicit || path.join(baseHome, ".zcode");
  const apps = platform === "darwin"
    ? ["/Applications/ZCode.app"]
    : platform === "win32"
      ? [
          envValue(env, "LOCALAPPDATA")
            && path.join(envValue(env, "LOCALAPPDATA"), "Programs", "ZCode", "ZCode.exe"),
          envValue(env, "ProgramFiles")
            && path.join(envValue(env, "ProgramFiles"), "ZCode", "ZCode.exe"),
        ].filter(Boolean)
      : [];
  return {
    home: zcodeHome,
    logDir: path.join(zcodeHome, "cli", "log"),
    dbPath: path.join(zcodeHome, "cli", "db", "db.sqlite"),
    apps,
  };
}

const resolved = resolveZcodePaths({ env: process.env });

module.exports = {
  ZCODE_HOME: resolved.home,
  LOG_DIR: resolved.logDir,
  DB_PATH: resolved.dbPath,
  APP_PATHS: resolved.apps,
  POLL_INTERVAL_MS,
  WATCH_FILES: true,
  // ZCode writes one JSONL per local day. Keep yesterday attached so a turn
  // that straddles midnight keeps its correlation context.
  LOOKBACK_DAYS: 2,
  STALE_TIMEOUT_MS: 300000,
  INITIAL_TAIL_BYTES: 1048576,
  LOG_EVENT_MAP: {
    "turn.started": "thinking",
    "model.request.started": "thinking",
    "tool.call.started": "working",
    "ttft.model.first_content": "speaking",
    "turn.completed": "attention",
    "turn.failed": "error",
    "model.request.failed": "error",
  },
  resolveZcodePaths,
};
