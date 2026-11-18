/**
 * [Input] A finished Tauri Windows bundle under the cargo target dir (CARGO_TARGET_DIR or src-tauri/target).
 * [Output] Installers (NSIS *.exe, MSI *.msi) copied into <repo>/artifacts/windows so builds live inside the project; always exits 0 when no bundle exists yet.
 * [Pos] Post-build helper for the Windows installers.
 * [Sync] If this file changes, update scripts/.folder.md and pc/package.json.
 */

import { cp, mkdir, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pcRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(pcRoot, "..");
const targetDir = process.env.CARGO_TARGET_DIR
  ? resolve(process.env.CARGO_TARGET_DIR)
  : join(pcRoot, "src-tauri", "target");
const bundleRoot = join(targetDir, "x86_64-pc-windows-msvc", "release", "bundle");
const outDir = join(repoRoot, "artifacts", "windows");

if (!existsSync(bundleRoot)) {
  console.error(`No Windows bundle found under ${bundleRoot}. Run "npm run build:win" first.`);
  process.exit(0);
}

await mkdir(outDir, { recursive: true });
let copied = 0;
for (const sub of ["nsis", "msi"]) {
  const dir = join(bundleRoot, sub);
  if (!existsSync(dir)) continue;
  for (const name of await readdir(dir)) {
    if (!/\.(exe|msi)$/i.test(name)) continue;
    const source = join(dir, name);
    if (!(await stat(source)).isFile()) continue;
    await cp(source, join(outDir, name));
    console.log(`copied ${name}`);
    copied += 1;
  }
}
console.log(copied > 0 ? `Installers collected in ${outDir}` : `No installers in ${bundleRoot}`);
