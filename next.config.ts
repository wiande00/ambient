import type { NextConfig } from "next";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  // The desktop app ships this output and runs `server.js` from it. `scripts/prepare-standalone.mjs`
  // copies in the static assets and `public/`, which standalone leaves out.
  output: "standalone",
  // Pinned so a lockfile in a parent directory (a git worktree under another checkout) does
  // not make Next trace files from there and nest the standalone output.
  outputFileTracingRoot: root,
  // The trace picks up the project tree itself, which is none of the server's business — and
  // `release/` holds the last build, server and all, so each build nested the one before it.
  // By 0.8.0 that was four levels deep and past MAX_PATH, and the uninstaller an update runs
  // failed on it. `resources/installer.nsh` clears the nest out of installs that have it.
  outputFileTracingExcludes: {
    "*": ["release/**", "dist-electron/**", "src/**", "electron/**", "mcp/**", "collector/**", "scripts/**", "resources/**"],
  },
  turbopack: { root },
};

export default nextConfig;
