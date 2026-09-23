import type { AmbientChunksResponse, AmbientUnclosedResponse } from "../src/lib/ambient/types";
import type { RotatingLog } from "./log";

/**
 * Finishing yesterday.
 *
 * A day is labelled only when someone opens it: the chunks route pays for the call, and the
 * week screen never does. So a day whose dashboard was last open at lunchtime keeps an
 * afternoon that no chunk covers. Its hours are still in the day's own Active figure — the
 * measuring never needed the model — but they are in no project's total, and nothing on the
 * screen says a number is short. Across one September that came to 8.6% of all active time,
 * and one day was missing two hours and forty minutes.
 *
 * So the shell finishes each day once, on its own: it asks the server which past days still
 * have a stretch the model has never seen, and opens each of them the way a person would.
 * One at a time and waiting for each (`close=1`), so a fortnight of neglect is a queue
 * rather than a burst of calls. Today is never closed — it is still being lived.
 *
 * Nothing here decides anything about a day. It only makes the call that would have happened
 * anyway, at the point where the day is finally over rather than whenever someone next looks.
 */

/** Long enough after start that the server is warm and the person's own day is on screen first. */
const FIRST_PASS_MS = 45_000;
/** A machine left running crosses midnight without restarting; an hourly look catches that. */
const PASS_INTERVAL_MS = 60 * 60_000;
/** Days back to consider. A day older than this has had many chances to be opened. */
const WINDOW_DAYS = 7;
/** Between two days, so a backlog trickles rather than floods. */
const BETWEEN_DAYS_MS = 5_000;
/** A day that will not close is left for the next pass rather than retried in this one. */
const REQUEST_TIMEOUT_MS = 120_000;

export class DayCloser {
  private timer: NodeJS.Timeout | null = null;
  private first: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;

  constructor(
    private readonly log: RotatingLog,
    private readonly baseUrl: () => string,
  ) {}

  start(): void {
    this.first = setTimeout(() => void this.run(), FIRST_PASS_MS);
    this.timer = setInterval(() => void this.run(), PASS_INTERVAL_MS);
  }

  stop(): void {
    this.stopped = true;
    if (this.first) clearTimeout(this.first);
    if (this.timer) clearInterval(this.timer);
    this.first = null;
    this.timer = null;
  }

  /** One pass. Overlapping passes are dropped rather than queued: the next hour will do. */
  private async run(): Promise<void> {
    if (this.running || this.stopped) return;
    const base = this.baseUrl();
    if (!base) return;
    this.running = true;
    try {
      const found = await this.get<AmbientUnclosedResponse>(`${base}/api/ambient/unclosed?days=${WINDOW_DAYS}`);
      if (!found || found.status !== "ready") {
        if (found) this.log.write(`[close] could not look: ${found.message}`);
        return;
      }
      if (found.dates.length === 0) return;
      if (!found.labellingConfigured) {
        this.log.write(`[close] ${found.dates.length} day(s) unlabelled, but no API key is set`);
        return;
      }

      const summary = found.dates.map((d) => `${d.date} (${d.candidates}, ${d.minutes}m)`).join(", ");
      this.log.write(`[close] ${found.dates.length} day(s) to finish: ${summary}`);
      for (const day of found.dates) {
        if (this.stopped) return;
        const answer = await this.get<AmbientChunksResponse>(`${base}/api/ambient/chunks?date=${day.date}&close=1`);
        if (!answer) this.log.write(`[close] ${day.date} did not finish; leaving it for the next pass`);
        else if (answer.status === "ready") this.log.write(`[close] ${day.date} closed: ${answer.chunks.length} chunk(s), ${answer.pending} still unlabelled`);
        else this.log.write(`[close] ${day.date}: ${answer.status === "error" ? answer.message : answer.status}`);
        await sleep(BETWEEN_DAYS_MS);
      }
    } catch (error) {
      this.log.write(`[close] pass failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.running = false;
    }
  }

  /** Loopback only, and a failure is never worth more than a line in the log. */
  private async get<T>(url: string): Promise<T | null> {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (!response.ok) {
        this.log.write(`[close] ${url} answered ${response.status}`);
        return null;
      }
      return (await response.json()) as T;
    } catch (error) {
      this.log.write(`[close] ${url} failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
