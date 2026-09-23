import type { ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, openSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { dirname } from "node:path";

/**
 * An append-only log with one rotation: past `maxBytes` the file becomes `<name>.1` and a
 * fresh one starts. The collector writes a line per focus change all day and the Next
 * server logs every request, so an unbounded file would be a slow leak. Writes are
 * synchronous and swallowed on failure; logging must never take the app down.
 */
export class RotatingLog {
  private fd: number | null = null;
  private size = 0;

  constructor(
    readonly path: string,
    private readonly maxBytes = 2 * 1024 * 1024,
  ) {}

  write(text: string): void {
    const body = text.endsWith("\n") ? text : `${text}\n`;
    const line = `${new Date().toISOString()} ${body}`;
    try {
      if (this.fd === null) this.open();
      if (this.size > this.maxBytes) this.rotate();
      writeSync(this.fd as number, line);
      this.size += Buffer.byteLength(line);
    } catch {
      // Nothing to do: a log that cannot be written is not worth crashing over.
    }
  }

  /** Copies a child's stdout and stderr into this log, line by line, with a tag. */
  attach(child: ChildProcess, tag: string): void {
    const pipe = (stream: NodeJS.ReadableStream | null, prefix: string) => {
      if (!stream) return;
      let pending = "";
      stream.setEncoding("utf8");
      stream.on("data", (chunk: string) => {
        pending += chunk;
        let index = pending.indexOf("\n");
        while (index >= 0) {
          const line = pending.slice(0, index).replace(/\r$/, "");
          pending = pending.slice(index + 1);
          if (line.trim()) this.write(`${prefix} ${line}`);
          index = pending.indexOf("\n");
        }
      });
      stream.on("end", () => {
        if (pending.trim()) this.write(`${prefix} ${pending}`);
        pending = "";
      });
    };
    pipe(child.stdout, `[${tag}]`);
    pipe(child.stderr, `[${tag} err]`);
  }

  close(): void {
    if (this.fd !== null) {
      try {
        closeSync(this.fd);
      } catch {
        // Already gone.
      }
      this.fd = null;
    }
  }

  private open(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    this.fd = openSync(this.path, "a");
    try {
      this.size = statSync(this.path).size;
    } catch {
      this.size = 0;
    }
  }

  private rotate(): void {
    this.close();
    const previous = `${this.path}.1`;
    rmSync(previous, { force: true });
    renameSync(this.path, previous);
    this.open();
  }
}
