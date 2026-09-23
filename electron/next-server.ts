import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { get as httpGet } from "node:http";
import { createServer } from "node:net";
import { dirname } from "node:path";
import type { RotatingLog } from "./log";
import { standaloneServerPath } from "./paths";

/**
 * The Next.js standalone server as a child process, run by Electron's own binary in Node
 * mode so the installer needs no Node on the machine. It binds to loopback only; the window
 * loads it over `http://127.0.0.1:<port>` because the page fetches root-relative URLs and
 * the icons are served from `public/`.
 *
 * Settings are not passed through the environment: the routes read `config.json` per
 * request, so a save on the Settings screen needs no restart here.
 */

const PREFERRED_PORT = 47821;
const READY_TIMEOUT_MS = 30_000;
const RESTART_BASE_MS = 1_000;
const RESTART_MAX_MS = 30_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class NextServer {
  private child: ChildProcess | null = null;
  private port = PREFERRED_PORT;
  private stopping = false;
  private attempt = 0;

  constructor(
    private readonly log: RotatingLog,
    private readonly onReady: (url: string) => void,
  ) {}

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async start(): Promise<string> {
    const script = standaloneServerPath();
    if (!existsSync(script)) throw new Error(`The dashboard server is missing at ${script}.`);
    this.port = await freePort(this.port);
    await this.spawnAndWait(script);
    return this.url;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const child = this.child;
    if (!child) return;
    child.kill();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 2_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    this.child = null;
  }

  private async spawnAndWait(script: string): Promise<void> {
    const child = spawn(process.execPath, [script], {
      cwd: dirname(script),
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        NODE_ENV: "production",
        PORT: String(this.port),
        HOSTNAME: "127.0.0.1",
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    this.log.attach(child, "server");
    this.log.write(`[shell] dashboard server starting on ${this.url}, pid ${child.pid ?? "?"}`);

    child.on("exit", (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      this.log.write(`[shell] dashboard server exited (code ${code ?? "null"}, signal ${signal ?? "none"})`);
      if (this.stopping) return;
      const delay = Math.min(RESTART_MAX_MS, RESTART_BASE_MS * 2 ** this.attempt);
      this.attempt += 1;
      setTimeout(() => {
        void this.spawnAndWait(script)
          .then(() => {
            this.attempt = 0;
            this.onReady(this.url);
          })
          .catch((error) => this.log.write(`[shell] dashboard server restart failed: ${String(error)}`));
      }, delay);
    });

    await this.waitUntilReady(child);
  }

  private async waitUntilReady(child: ChildProcess): Promise<void> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`The dashboard server exited with code ${child.exitCode} while starting.`);
      if (await this.responds()) return;
      await sleep(250);
    }
    throw new Error(`The dashboard server did not answer on ${this.url} within ${READY_TIMEOUT_MS / 1000} s.`);
  }

  private responds(): Promise<boolean> {
    return new Promise((resolve) => {
      const request = httpGet(`${this.url}/api/ambient/settings`, { timeout: 2_000 }, (response) => {
        response.resume();
        resolve((response.statusCode ?? 500) < 500);
      });
      request.on("error", () => resolve(false));
      request.on("timeout", () => {
        request.destroy();
        resolve(false);
      });
    });
  }
}

/** The preferred port if free, else whatever the OS hands out. */
function freePort(preferred: number): Promise<number> {
  return new Promise((resolve) => {
    const tryPort = (port: number, fallback: boolean) => {
      const server = createServer();
      server.unref();
      server.once("error", () => {
        if (fallback) tryPort(0, false);
        else resolve(preferred);
      });
      server.listen(port, "127.0.0.1", () => {
        const address = server.address();
        const chosen = typeof address === "object" && address ? address.port : port;
        server.close(() => resolve(chosen));
      });
    };
    tryPort(preferred, true);
  });
}
