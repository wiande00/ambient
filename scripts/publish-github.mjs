import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Publishes the installer `npm run dist` just built as a GitHub release, which is where
 * every installed copy of Ambient looks for updates. The release is tagged `v<version>` on
 * the current commit and carries two assets: the setup exe and `latest.json` (version,
 * file, size, SHA-512). The app reads
 * `https://github.com/<repo>/releases/latest/download/latest.json`, so the newest release is
 * the one that is offered.
 *
 * The commit must be pushed and the tree clean, so the tag points at exactly what was built.
 * `AMBIENT_RELEASE_NOTES` becomes the release text and the note in the app's update banner.
 */

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.status !== 0) {
    console.error(`publish-github: ${command} ${args.join(" ")} failed\n${result.stderr ?? ""}`);
    process.exit(result.status ?? 1);
  }
  return (result.stdout ?? "").trim();
};

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const version = pkg.version;
const tag = `v${version}`;
const file = `Ambient-Setup-${version}.exe`;
const exe = join("release", file);
if (!existsSync(exe)) {
  console.error(`publish-github: ${exe} is missing. Run \`npm run dist\` first, or bump the version in package.json.`);
  process.exit(1);
}

if (run("git", ["status", "--porcelain"])) {
  console.error("publish-github: the working tree has uncommitted changes. Commit them first, so the release matches its tag.");
  process.exit(1);
}
const head = run("git", ["rev-parse", "HEAD"]);
run("git", ["fetch", "--quiet", "origin"]);
if (!run("git", ["branch", "-r", "--contains", head])) {
  console.error("publish-github: HEAD is not on GitHub yet. Push it first (git push).");
  process.exit(1);
}
if (spawnSync("gh", ["release", "view", tag], { stdio: "ignore" }).status === 0) {
  console.error(`publish-github: ${tag} is already released. Bump the version in package.json.`);
  process.exit(1);
}

const notes = process.env.AMBIENT_RELEASE_NOTES || undefined;
const manifest = {
  version,
  file,
  size: statSync(exe).size,
  sha512: createHash("sha512").update(readFileSync(exe)).digest("base64"),
  publishedAt: new Date().toISOString(),
  notes,
};
const manifestPath = join("release", "latest.json");
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

run("gh", ["release", "create", tag, exe, manifestPath, "--target", head, "--title", `Ambient ${version}`, "--notes", notes ?? `Ambient ${version}.`], { stdio: ["ignore", "inherit", "pipe"] });
console.log(`publish-github: ${tag} released with ${file} (${(manifest.size / 1024 / 1024).toFixed(1)} MB)`);
