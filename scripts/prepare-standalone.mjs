import { cpSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * Finishes a `next build` with `output: "standalone"` for the desktop app. Standalone
 * deliberately leaves out `.next/static` and `public/` (a CDN is expected to serve them);
 * here the Next server inside the app serves everything itself, so both are copied in.
 */

const root = process.cwd();
const standalone = join(root, ".next", "standalone");

if (!existsSync(join(standalone, "server.js"))) {
  console.error(
    `prepare-standalone: ${join(standalone, "server.js")} is missing. Run \`next build\` first, and make sure ` +
      "node_modules is installed inside this checkout — Next nests the output when it resolves packages from a parent directory.",
  );
  process.exit(1);
}

const staticTarget = join(standalone, ".next", "static");
rmSync(staticTarget, { recursive: true, force: true });
cpSync(join(root, ".next", "static"), staticTarget, { recursive: true });

const publicTarget = join(standalone, "public");
rmSync(publicTarget, { recursive: true, force: true });
cpSync(join(root, "public"), publicTarget, { recursive: true });

console.log(`prepare-standalone: static assets and public/ copied into ${standalone}`);
