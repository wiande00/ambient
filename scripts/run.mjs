import { spawnSync } from "node:child_process";

/**
 * Runs each argument as a command, in order, stopping at the first failure. npm's script
 * shell on this machine is PowerShell 5.1, which has no `&&`, so package.json scripts chain
 * through this instead: `node scripts/run.mjs "tsc --noEmit" "tsc -p electron/tsconfig.json"`.
 */
for (const command of process.argv.slice(2)) {
  console.log(`\n> ${command}`);
  const result = spawnSync(command, { stdio: "inherit", shell: true });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
