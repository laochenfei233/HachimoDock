import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (relativePath) => readFileSync(new URL(relativePath, import.meta.url), "utf8");

test("AppUpdateCard auto-checks on mount and renders the check/download/install flow", () => {
  const card = read("AppUpdateCard.jsx");
  assert.match(card, /invoke\("app_update_check"\)/);
  assert.match(card, /invoke\("app_update_download"\)/);
  assert.match(card, /invoke\("app_update_install", \{ path: downloadedPath \}\)/);
  assert.match(card, /invoke\("open_external_url", \{ url: status\.release_url \}\)/);
  assert.match(card, /listen\("app-update-download-progress"/);
  // Web preview (no Tauri) keeps the placeholder copy instead of failing.
  assert.match(card, /window\.__TAURI_INTERNALS__/);
  assert.match(card, /暂无发布版本/);
  // Download owns exit protection and clamps progress to 0..100.
  assert.match(card, /useExitProtection\(downloading/);
  assert.match(card, /Math\.min\(100, Number\(event\?\.payload\?\.percent\)/);
  // Asset fallback (no matching asset / macOS) degrades to the release page.
  assert.match(card, /downloadInApp = updateAvailable && installable/);
  assert.match(card, /发布于 \$\{status\.published_at\.slice\(0, 10\)\}/);
});

test("ApiSettings renders the update card below the appearance group", () => {
  const source = read("ApiSettings.jsx");
  assert.match(source, /import AppUpdateCard from "\.\/AppUpdateCard\.jsx";/);
  assert.match(source, /<AppearanceCard \/>\n      <AppUpdateCard active=\{active\} \/>/);
});

test("update commands are registered with the local-only capability", () => {
  const permissions = JSON.parse(
    readFileSync(new URL("../src-tauri/permissions/local-app-commands.json", import.meta.url), "utf8"),
  );
  const allow = permissions.permission[0].commands.allow;
  for (const command of ["app_update_check", "app_update_download", "app_update_install"]) {
    assert.ok(allow.includes(command), `${command} must be allow-listed`);
  }
  const lib = read("../src-tauri/src/lib.rs");
  assert.match(lib, /mod app_update;/);
  assert.match(lib, /app_update::app_update_check,/);
  assert.match(lib, /app_update::app_update_download,/);
  assert.match(lib, /app_update::app_update_install,/);
});
