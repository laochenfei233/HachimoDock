import test from "node:test";
import assert from "node:assert/strict";
import { deviceVoicePlatformWarning, deviceVoiceTransportReady } from "./agent-voice-capabilities.js";

test("native Mac Codex draft path does not require the CLI transport", () => {
  assert.equal(deviceVoiceTransportReady("codex", "macos", false), true);
  assert.equal(deviceVoiceTransportReady("codex", "windows", false), false);
  assert.equal(deviceVoiceTransportReady("openclaw", "macos", false), false);
  assert.equal(deviceVoiceTransportReady("openclaw", "macos", true), true);
});

test("ZCode visible input box draft path is ready on desktop platforms without a CLI transport", () => {
  assert.equal(deviceVoiceTransportReady("zcode", "macos", false), true);
  assert.equal(deviceVoiceTransportReady("zcode", "windows", false), true);
  assert.equal(deviceVoiceTransportReady("zcode", "other", false), false);
});

test("MiMoCode platform limitations are surfaced before starting voice recognition", () => {
  assert.match(deviceVoicePlatformWarning("mimocode", "windows"), /目前仅支持 macOS/);
  assert.match(deviceVoicePlatformWarning("mimocode", "other"), /目前仅支持 macOS/);
  assert.equal(deviceVoicePlatformWarning("mimocode", "macos"), "");
  for (const id of ["codex", "claude-code", "openclaw", "workbuddy", "zcode"]) {
    assert.equal(deviceVoicePlatformWarning(id, "windows"), "");
    assert.equal(deviceVoicePlatformWarning(id, "macos"), "");
  }
});
