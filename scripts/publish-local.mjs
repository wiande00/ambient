import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Publishes the installer `npm run dist` just built to the update channel: the folder the
 * running desktop app watches (`~/.ambient/updates/`, or `AMBIENT_UPDATE_DIR`). The exe is
 * copied under a temporary name and renamed into place, then `latest.json` is written the
 * same way, so the app never reads a manifest that points at a half-copied file. Older
 * installers are pruned down to the two newest, which leaves one to roll back to.
 */

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const version = pkg.version;
const file = `Ambient-Setup-${version}.exe`;
const source = join("release", file);
if (!existsSync(source)) {
  console.error(`publish-local: ${source} is missing. Run \`npm run dist\` first, or bump the version in package.json.`);
  process.exit(1);
}

const channel = process.env.AMBIENT_UPDATE_DIR || join(homedir(), ".ambient", "updates");
mkdirSync(channel, { recursive: true });

const target = join(channel, file);
copyFileSync(source, `${target}.tmp`);
renameSync(`${target}.tmp`, target);

const hash = createHash("sha512").update(readFileSync(target)).digest("base64");
const manifest = {
  version,
  file,
  size: statSync(target).size,
  sha512: hash,
  publishedAt: new Date().toISOString(),
  notes: process.env.AMBIENT_RELEASE_NOTES || undefined,
};
const manifestPath = join(channel, "latest.json");
writeFileSync(`${manifestPath}.tmp`, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
renameSync(`${manifestPath}.tmp`, manifestPath);

const installers = readdirSync(channel)
  .filter((name) => /^Ambient-Setup-.+\.exe$/.test(name) && name !== file)
  .map((name) => ({ name, mtimeMs: statSync(join(channel, name)).mtimeMs }))
  .sort((a, b) => b.mtimeMs - a.mtimeMs);
for (const old of installers.slice(1)) rmSync(join(channel, old.name), { force: true });

console.log(`publish-local: ${file} (${(manifest.size / 1024 / 1024).toFixed(1)} MB) published to ${channel}`);
