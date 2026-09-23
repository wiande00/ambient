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
  turbopack: { root },
};

export default nextConfig;
