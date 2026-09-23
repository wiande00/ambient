import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import type { AmbientCollectorStatus } from "../src/types/ambient-bridge";
import type { RotatingLog } from "./log";
import { ambientDir, collectorPidPath, collectorScriptPath, powershellPath, stopFlagPath } from "./paths";

/**
 * Keeps one collector running. The script has no single-instance guard and no way to be
 * signalled except the STOP file, so both are handled here:
 *
 * - Before spawning, STOP is written and watched. A collector already running — an orphan
 *   from a crashed shell, a manual run — sees it within a second, flushes, deletes it and
 *   exits. If nobody takes it within three seconds there was nobody, and it is removed.
 * - Stopping goes the same way: write STOP, wait for the process to exit on its own so its
 *   `finally` block writes the block that was open, and only kill after a timeout.
 *
 * Windows PowerShell 5.1 is spawned explicitly. The script compiles inline C# and loads the
 * WPF UI Automation assemblies, neither of which exists in PowerShell 7.
 */

const RETIRE_WAIT_MS = 3_000;
const RETIRE_FLUSH_MS = 1_500;
const STOP_TIMEOUT_MS = 5_000;
const POLL_MS = 200;
const RESTART_BASE_MS = 2_000;
const RESTART_MAX_MS = 60_000;
const STABLE_AFTER_MS = 5 * 60_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class Collector {
  private child: ChildProcess | null = null;
  private status: AmbientCollectorStatus = { state: "stopped" };
  private desired = false;
  private excludeApps: string[] = [];
  private attempt = 0;
  private startedAt = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  private transition: Promise<void> = Promise.resolve();

  constructor(
    private readonly log: RotatingLog,
    private readonly onChange: (status: AmbientCollectorStatus) => void,
  ) {}

  current(): AmbientCollectorStatus {
    return this.status;
  }

  /** Start with these arguments; a no-op if already running with them. */
  start(excludeApps: string[]): Promise<void> {
    return this.queue(async () => {
      this.desired = true;
      this.excludeApps = [...excludeApps];
      if (this.child) return;
      this.clearRestart();
      await this.retireOthers();
      this.spawnChild();
    });
  }

  stop(): Promise<void> {
    return this.queue(() => this.stopNow());
  }

  restart(excludeApps?: string[]): Promise<void> {
    return this.queue(async () => {
      if (excludeApps) this.excludeApps = [...excludeApps];
      await this.stopNow();
      this.desired = true;
      this.attempt = 0;
      await this.retireOthers();
      this.spawnChild();
    });
  }

  /** Restart only if the arguments changed; used when settings are saved. */
  async applyExcludeApps(excludeApps: string[]): Promise<void> {
    const same = excludeApps.length === this.excludeApps.length && excludeApps.every((app, i) => app === this.excludeApps[i]);
    if (same) return;
    if (this.desired) await this.restart(excludeApps);
    else this.excludeApps = [...excludeApps];
  }

  /** Synchronous best effort for session end: write STOP and give the script a moment to see it. */
  stopSyncBestEffort(waitMs: number): void {
    this.desired = false;
    this.clearRestart();
    if (!this.child) return;
    try {
      writeFileSync(stopFlagPath(), "");
    } catch {
      return;
    }
    const deadline = Date.now() + waitMs;
    const buffer = new Int32Array(new SharedArrayBuffer(4));
    while (Date.now() < deadline && existsSync(stopFlagPath())) Atomics.wait(buffer, 0, 0, 50);
    // The flag is gone: the collector saw it and is flushing. Give the flush its moment.
    if (!existsSync(stopFlagPath())) Atomics.wait(buffer, 0, 0, Math.min(700, Math.max(0, deadline - Date.now())));
  }

  private queue(task: () => Promise<void>): Promise<void> {
    const run = this.transition.then(task, task);
    this.transition = run.catch(() => undefined);
    return run;
  }

  private async stopNow(): Promise<void> {
    this.desired = false;
    this.clearRestart();
    const child = this.child;
    if (!child) {
      this.setStatus({ state: "stopped" });
      return;
    }
    this.log.write("[shell] stopping collector via STOP file");
    try {
      writeFileSync(stopFlagPath(), "");
    } catch (error) {
      this.log.write(`[shell] could not write STOP: ${String(error)}`);
    }
    const exited = await this.waitForExit(child, STOP_TIMEOUT_MS);
    if (!exited) {
      this.log.write("[shell] collector did not stop in time; killing it (the open block is lost)");
      child.kill();
      await this.waitForExit(child, 1_000);
    }
    rmSync(stopFlagPath(), { force: true });
    this.child = null;
    this.setStatus({ state: "stopped" });
  }

  private async retireOthers(): Promise<void> {
    mkdirSync(ambientDir(), { recursive: true });
    const flag = stopFlagPath();
    try {
      writeFileSync(flag, "");
    } catch (error) {
      this.log.write(`[shell] could not write STOP for the handshake: ${String(error)}`);
      return;
    }
    const deadline = Date.now() + RETIRE_WAIT_MS;
    while (Date.now() < deadline) {
      if (!existsSync(flag)) {
        this.log.write("[shell] another collector took the STOP flag; waiting for it to flush");
        await sleep(RETIRE_FLUSH_MS);
        return;
      }
      await sleep(POLL_MS);
    }
    rmSync(flag, { force: true });
  }

  private spawnChild(): void {
    const args = [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-WindowStyle",
      "Hidden",
      "-File",
      collectorScriptPath(),
      "-ExcludeApps",
      this.excludeApps.length > 0 ? this.excludeApps.join(",") : "",
    ];
    let child: ChildProcess;
    try {
      child = spawn(powershellPath(), args, {
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      this.log.write(`[shell] could not spawn the collector: ${String(error)}`);
      this.scheduleRestart();
      return;
    }
    this.child = child;
    this.startedAt = Date.now();
    this.log.attach(child, "collector");
    this.log.write(`[shell] collector started, pid ${child.pid ?? "?"}, excluding ${this.excludeApps.join(", ") || "nothing"}`);
    try {
      writeFileSync(collectorPidPath(), String(child.pid ?? ""));
    } catch {
      // Informational only.
    }
    this.setStatus({ state: "running", pid: child.pid ?? 0, since: new Date(this.startedAt).toISOString() });

    child.on("error", (error) => this.log.write(`[shell] collector process error: ${String(error)}`));
    child.on("exit", (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      rmSync(collectorPidPath(), { force: true });
      this.log.write(`[shell] collector exited (code ${code ?? "null"}, signal ${signal ?? "none"})`);
      if (!this.desired) {
        this.setStatus({ state: "stopped" });
        return;
      }
      if (Date.now() - this.startedAt > STABLE_AFTER_MS) this.attempt = 0;
      this.scheduleRestart();
    });
  }

  private scheduleRestart(): void {
    const delay = Math.min(RESTART_MAX_MS, RESTART_BASE_MS * 2 ** this.attempt);
    this.attempt += 1;
    this.setStatus({ state: "restarting", inSeconds: Math.round(delay / 1000), attempt: this.attempt });
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.queue(async () => {
        if (!this.desired || this.child) return;
        await this.retireOthers();
        this.spawnChild();
      });
    }, delay);
  }

  private clearRestart(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
  }

  private waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  private setStatus(status: AmbientCollectorStatus): void {
    this.status = status;
    this.onChange(status);
  }
}
