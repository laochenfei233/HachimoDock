// Windows 上的 `cargo test` 启动器。tauri-build 的 comctl32 v6 manifest 只链进 bin 目标
// （embed-resource 走 rustc-link-arg-bins），lib 测试 harness import 的 TaskDialogIndirect
// 是 comctl32 v6 独有导出——没有 manifest 时 harness 加载即崩（STATUS_ENTRYPOINT_NOT_FOUND）。
// 这里在构建后为每个测试 exe 落一份外部 manifest（SxS 优先读取 exe 同名 .manifest），
// 不改构建产物本身；macOS/Linux 直接转发 cargo test。
import { spawnSync } from "node:child_process";
import { readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const crate = resolve(here, "..");
const cargoArgs = process.argv.slice(2).length > 0 ? process.argv.slice(2) : [];
const isWindows = process.platform === "win32";

function run(name, args, env) {
  const result = spawnSync(name, args, { stdio: "inherit", cwd: crate, env: { ...process.env, ...env } });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

if (!isWindows) {
  process.exit(run("cargo", ["test", ...cargoArgs]));
}

// 1) 只构建，不运行（harness 此刻还跑不起来）。
const build = run("cargo", ["test", "--no-run", ...cargoArgs]);
if (build !== 0) process.exit(build);

// 2) 为 deps 下的 pet_manager 测试 exe 补外部 manifest；同名旧文件先删。
const manifest = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <dependency>
    <dependentAssembly>
      <assemblyIdentity type="win32" name="Microsoft.Windows.Common-Controls" version="6.0.0.0"
        processorArchitecture="*" publicKeyToken="6595b64144ccf1df" language="*"/>
    </dependentAssembly>
  </dependency>
</assembly>
`;
const targetDir = resolve(crate, process.env.CARGO_TARGET_DIR || "target", "debug", "deps");
let armed = 0;
for (const name of readdirSync(targetDir)) {
  if (!/^pet_manager.*\.exe$/i.test(name)) continue;
  const side = join(targetDir, `${name}.manifest`);
  rmSync(side, { force: true });
  writeFileSync(side, manifest);
  armed += 1;
}
if (armed === 0) {
  console.error(`未在 ${targetDir} 找到测试 exe；请确认构建产物位置。`);
  process.exit(1);
}

// 3) 正常运行测试（外部 manifest 生效，harness 可加载）。
process.exit(run("cargo", ["test", ...cargoArgs]));
