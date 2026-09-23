/* eslint-disable @typescript-eslint/no-require-imports -- electron-builder loads hooks as CommonJS */
const { cpSync, rmSync } = require("node:fs");
const { join } = require("node:path");

/**
 * electron-builder afterPack hook. The standalone Next server is copied into
 * `resources/server` here rather than through `extraResources`, because that matcher strips
 * every `node_modules` directory and the server cannot start without its own.
 */
module.exports = async function afterPack(context) {
  const source = join(context.packager.projectDir, ".next", "standalone");
  const target = join(context.appOutDir, "resources", "server");
  rmSync(target, { recursive: true, force: true });
  cpSync(source, target, { recursive: true });
  console.log(`  • after-pack: copied ${source} → ${target}`);
};
