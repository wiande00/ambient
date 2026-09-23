import { app, net } from "electron";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { basename, join } from "node:path";
import type { AmbientUpdateState } from "../src/types/ambient-bridge";
import type { RotatingLog } from "./log";
import { cmdPath, installDir, logsDir, powershellPath, updateFeedUrl, updatesDir } from "./paths";

/**
 * Releases are published to GitHub (`npm run release` uploads the setup exe and a
 * `latest.json` naming it). On each check the shell reads the newest release's `latest.json`
 * and, when it names a newer version, downloads the installer into the local update folder —
 * `~/.ambient/updates/` — and writes the manifest beside it. From there on everything reads
 * the folder: it is watched, re-read on a slow timer, and a newer version whose file is
 * present and whose hash matches is offered: the dashboard shows a banner and the tray a
 * menu item.
 *
 * Installing is the shell's job, in this order: quit cleanly so the collector writes the
 * block it has open, hand off to a detached PowerShell that waits for this process to be
 * gone, runs the installer silently, and starts the new build.
 *
 * The folder still works on its own: `AMBIENT_UPDATE_URL=off` stops the GitHub check, and
 * anything that drops an installer plus `latest.json` into the folder is picked up. The
 * update check and the Anthropic API are the app's only network calls; the collector makes
 * none.
 */

const MANIFEST = "latest.json";
const FIRST_CHECK_DELAY_MS = 15_000;
const CHECK_INTERVAL_MS = 15 * 60_000;
const WATCH_DEBOUNCE_MS = 2_000;

type Manifest = {
  version: string;
  file: string;
  sha512: string;
  size: number;
  publishedAt?: string;
  notes?: string;
};

type Verified = { version: string; path: string; mtimeMs: number; size: number; publishedAt?: string; notes?: string };

/** `Omit` over each member of the union, not over the union's common keys. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** A state without the two fields the updater fills in itself. */
type StateInput = DistributiveOmit<AmbientUpdateState, "current" | "channel">;

export class Updater {
  private state: AmbientUpdateState;
  private ready: Verified | null = null;
  private timer: NodeJS.Timeout | null = null;
  private watcher: FSWatcher | null = null;
  private debounce: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;
  private installing = false;

  constructor(
    private readonly log: RotatingLog,
    private readonly onChange: (state: AmbientUpdateState) => void,
  ) {
    this.state = { state: "idle", current: app.getVersion(), channel: updatesDir() };
  }

  current(): AmbientUpdateState {
    return this.state;
  }

  /** First check shortly after start, then on a timer, plus whenever the channel folder changes. */
  start(): void {
    const dir = updatesDir();
    try {
      mkdirSync(dir, { recursive: true });
      this.watcher = watch(dir, { persistent: false }, () => this.scheduleCheck());
      this.watcher.on("error", (error) => this.log.write(`[update] watcher stopped: ${String(error)}`));
    } catch (error) {
      this.log.write(`[update] cannot watch ${dir}: ${String(error)}`);
    }
    this.timer = setInterval(() => void this.check(), CHECK_INTERVAL_MS);
    setTimeout(() => void this.check(), FIRST_CHECK_DELAY_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.debounce) clearTimeout(this.debounce);
    this.watcher?.close();
    this.timer = null;
    this.debounce = null;
    this.watcher = null;
  }

  /** Read the channel now. Concurrent calls share one read. */
  check(): Promise<void> {
    if (this.installing) return Promise.resolve();
    if (!this.inFlight) {
      this.inFlight = this.checkOnce().finally(() => {
        this.inFlight = null;
      });
    }
    return this.inFlight;
  }

  /**
   * Hand the install to a detached PowerShell. The caller quits the app right after; the
   * script waits for that, so the collector's flush is never raced. Returns false when
   * nothing verified is ready or this is not the installed app.
   */
  launchInstaller(): boolean {
    const ready = this.ready;
    if (!ready || this.installing) return false;
    if (!app.isPackaged) {
      this.log.write("[update] refusing to install from a development build");
      return false;
    }
    this.installing = true;
    this.setState({ state: "installing", version: ready.version });

    const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;
    const exe = join(installDir(), basename(process.execPath));
    const updateLog = join(logsDir(), "update.log");
    const scriptPath = join(updatesDir(), "install.ps1");
    const script = [
      "$ErrorActionPreference = 'Continue'",
      `$log = ${quote(updateLog)}`,
      'function Note($m) { Add-Content -Path $log -Value ("{0} {1}" -f (Get-Date -Format o), $m) }',
      `Note ('updating ${this.state.current} -> ${ready.version} from ' + ${quote(ready.path)})`,
      `Wait-Process -Id ${process.pid} -Timeout 60 -ErrorAction SilentlyContinue`,
      "Note 'app exited; running installer'",
      `$p = Start-Process -FilePath ${quote(ready.path)} -ArgumentList '/S' -PassThru -Wait`,
      "Note ('installer exit code ' + $p.ExitCode)",
      "Start-Sleep -Seconds 1",
      `if (Test-Path ${quote(exe)}) { Start-Process -FilePath ${quote(exe)}; Note 'started Ambient' } else { Note 'Ambient.exe missing after install' }`,
    ].join("\n");

    try {
      writeFileSync(scriptPath, `${script}\n`, "utf8");
      // PowerShell needs a console and exits at once without one, which is exactly what a
      // detached spawn (DETACHED_PROCESS) gives it. `start` from cmd hands it a fresh,
      // minimised console instead, and the detached cmd breaks out of the job that would
      // otherwise take the script down with this process.
      const child = spawn(
        cmdPath(),
        ["/d", "/c", "start", '""', "/min", powershellPath(), "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", scriptPath],
        { detached: true, stdio: "ignore", windowsHide: true },
      );
      child.unref();
      this.log.write(`[update] installer handed off (pid ${child.pid ?? "?"}): ${ready.path}`);
      return true;
    } catch (error) {
      this.installing = false;
      this.setState({ state: "error", message: `Could not start the installer: ${String(error)}` });
      return false;
    }
  }

  private scheduleCheck(): void {
    if (this.debounce) clearTimeout(this.debounce);
    // The publish script writes the exe first and the manifest last; the debounce lets a
    // burst of file events settle into one read.
    this.debounce = setTimeout(() => {
      this.debounce = null;
      void this.check();
    }, WATCH_DEBOUNCE_MS);
  }

  private async checkOnce(): Promise<void> {
    this.setState({ state: "checking" });
    const dir = updatesDir();
    await this.fetchRemote(dir);
    const manifestPath = join(dir, MANIFEST);
    const checkedAt = new Date().toISOString();

    let manifest: Manifest | null;
    try {
      manifest = existsSync(manifestPath) ? parseManifest(readFileSync(manifestPath, "utf8")) : null;
    } catch (error) {
      this.setState({ state: "error", message: `${MANIFEST} could not be read: ${String(error)}`, checkedAt });
      return;
    }
    if (manifest === null) {
      if (existsSync(manifestPath)) {
        this.setState({ state: "error", message: `${MANIFEST} is not a release manifest.`, checkedAt });
        return;
      }
      this.ready = null;
      this.setState({ state: "up-to-date", checkedAt });
      return;
    }

    if (compareVersions(manifest.version, app.getVersion()) <= 0) {
      this.ready = null;
      this.setState({ state: "up-to-date", checkedAt });
      return;
    }

    const path = join(dir, basename(manifest.file));
    let size: number;
    let mtimeMs: number;
    try {
      const stat = statSync(path);
      size = stat.size;
      mtimeMs = stat.mtimeMs;
    } catch {
      this.setState({ state: "error", message: `${manifest.version} is announced but ${basename(manifest.file)} is missing.`, checkedAt });
      return;
    }
    if (size !== manifest.size) {
      this.setState({ state: "error", message: `${basename(manifest.file)} is ${size} bytes, expected ${manifest.size}.`, checkedAt });
      return;
    }

    // Hash once per file; a re-check with the same file is free.
    const already = this.ready;
    if (!already || already.path !== path || already.mtimeMs !== mtimeMs || already.size !== size) {
      const digest = await sha512(path);
      if (digest !== manifest.sha512) {
        this.ready = null;
        this.setState({ state: "error", message: `${basename(manifest.file)} does not match its published hash.`, checkedAt });
        return;
      }
      this.log.write(`[update] ${manifest.version} verified at ${path}`);
    }
    this.ready = { version: manifest.version, path, mtimeMs, size, publishedAt: manifest.publishedAt, notes: manifest.notes };
    this.setState({ state: "ready", version: manifest.version, publishedAt: manifest.publishedAt, notes: manifest.notes, checkedAt });
  }

  /**
   * Bring the newest GitHub release into the local folder when it is newer than both the
   * running build and what the folder already holds. Failing here (offline, rate-limited)
   * only means the folder is read as it is.
   */
  private async fetchRemote(dir: string): Promise<void> {
    const feed = updateFeedUrl();
    if (!feed) return;
    try {
      const response = await net.fetch(feed, { headers: { "Cache-Control": "no-cache" } });
      if (response.status === 404) return; // no release published yet
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const remote = parseManifest(await response.text());
      if (!remote) throw new Error("the release has no valid latest.json");
      if (compareVersions(remote.version, app.getVersion()) <= 0) return;

      const manifestPath = join(dir, MANIFEST);
      const local = existsSync(manifestPath) ? safeParse(readFileSync(manifestPath, "utf8")) : null;
      const file = basename(remote.file);
      const target = join(dir, file);
      if (local && local.version === remote.version && existsSync(target) && statSync(target).size === remote.size) return;

      const url = new URL(file, feed).toString();
      this.log.write(`[update] downloading ${remote.version} from ${url}`);
      const download = await net.fetch(url);
      if (!download.ok || !download.body) throw new Error(`download failed: HTTP ${download.status}`);
      mkdirSync(dir, { recursive: true });
      const part = `${target}.part`;
      await pipeline(Readable.fromWeb(download.body as import("node:stream/web").ReadableStream), createWriteStream(part));
      if ((await sha512(part)) !== remote.sha512) {
        rmSync(part, { force: true });
        throw new Error(`${file} does not match its published hash`);
      }
      renameSync(part, target);
      writeFileSync(`${manifestPath}.tmp`, `${JSON.stringify(remote, null, 2)}\n`, "utf8");
      renameSync(`${manifestPath}.tmp`, manifestPath);
      for (const name of readdirSync(dir)) {
        if (/^Ambient-Setup-.+\.exe$/.test(name) && name !== file) rmSync(join(dir, name), { force: true });
      }
    } catch (error) {
      this.log.write(`[update] GitHub check failed: ${String(error)}`);
    }
  }

  private setState(next: StateInput): void {
    const checkedAt = next.checkedAt ?? this.state.checkedAt;
    this.state = { ...next, current: app.getVersion(), channel: updatesDir(), ...(checkedAt ? { checkedAt } : {}) };
    this.onChange(this.state);
  }
}

function safeParse(raw: string): Manifest | null {
  try {
    return parseManifest(raw);
  } catch {
    return null;
  }
}

function parseManifest(raw: string): Manifest | null {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) return null;
  const m = parsed as Record<string, unknown>;
  if (typeof m.version !== "string" || typeof m.file !== "string" || typeof m.sha512 !== "string" || typeof m.size !== "number") return null;
  return {
    version: m.version,
    file: m.file,
    sha512: m.sha512,
    size: m.size,
    publishedAt: typeof m.publishedAt === "string" ? m.publishedAt : undefined,
    notes: typeof m.notes === "string" ? m.notes : undefined,
  };
}

/** Numeric dotted versions; a pre-release suffix sorts below the plain version. */
export function compareVersions(a: string, b: string): number {
  const split = (v: string) => {
    const [core, pre] = v.trim().split("-", 2);
    return { parts: core.split(".").map((n) => Number.parseInt(n, 10) || 0), pre: pre ?? "" };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < Math.max(x.parts.length, y.parts.length); i++) {
    const d = (x.parts[i] ?? 0) - (y.parts[i] ?? 0);
    if (d !== 0) return d;
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

function sha512(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha512");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("base64")))
      .on("error", reject);
  });
}
