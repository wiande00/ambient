import { mkdirSync, watch, type FSWatcher } from "node:fs";
import type { RotatingLog } from "./log";
import { ambientDir } from "./paths";

/**
 * Tells the dashboard when there is something new to read. The collector writes a block to
 * today's log every time focus moves on, the off-computer switch, the chunk edits and the
 * projects editor rewrite their files, and the MCP server does the same from Claude — all
 * straight to disk, none of it through the dashboard. So the shell watches `~/.ambient/`
 * and pokes the page, which refetches whatever it has on screen. The poke goes over IPC,
 * which reaches a hidden or covered window when a renderer timer would not, so the numbers
 * are already right the moment the window is brought back.
 *
 * A burst of writes is one poke: the debounce lets the collector's write-then-rename finish
 * and folds a run of blocks into a single refetch. Pokes are also kept apart, because each
 * one has the server re-measure the whole day, and quick switching between windows writes a
 * block every few seconds. `live.json`, rewritten every 15 s, pokes nothing: the page's own
 * one-minute refresh picks it up.
 */

const DEBOUNCE_MS = 750;
const MIN_GAP_MS = 10_000;

/** Files whose change means the day, the week, or the switch on screen may have moved. */
const DAY_LOG = /^\d{4}-\d{2}-\d{2}\.jsonl$/;
const OTHER_INPUTS = new Set(["offcomputer.json", "edits.json", "projects.json", "config.json"]);

export function isDashboardInput(name: string): boolean {
  return DAY_LOG.test(name) || OTHER_INPUTS.has(name);
}

export class DataWatcher {
  private watcher: FSWatcher | null = null;
  private debounce: NodeJS.Timeout | null = null;
  private lastPokeAt = 0;

  constructor(
    private readonly log: RotatingLog,
    private readonly onChange: () => void,
  ) {}

  start(): void {
    const dir = ambientDir();
    try {
      mkdirSync(dir, { recursive: true });
      this.watcher = watch(dir, { persistent: false }, (_event, filename) => {
        // Windows reports the entry's name; a missing name is a change somewhere in the
        // directory, which is worth a refetch rather than a miss.
        const name = filename === null || filename === undefined ? "" : String(filename);
        if (name && !isDashboardInput(name)) return;
        this.schedule();
      });
      this.watcher.on("error", (error) => this.log.write(`[data] watcher stopped: ${String(error)}`));
    } catch (error) {
      this.log.write(`[data] cannot watch ${dir}: ${String(error)}`);
    }
  }

  stop(): void {
    if (this.debounce) clearTimeout(this.debounce);
    this.watcher?.close();
    this.debounce = null;
    this.watcher = null;
  }

  private schedule(): void {
    if (this.debounce) clearTimeout(this.debounce);
    const wait = Math.max(DEBOUNCE_MS, this.lastPokeAt + MIN_GAP_MS - Date.now());
    this.debounce = setTimeout(() => {
      this.debounce = null;
      this.lastPokeAt = Date.now();
      this.onChange();
    }, wait);
  }
}
