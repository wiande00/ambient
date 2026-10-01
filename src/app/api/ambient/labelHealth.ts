import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import type { AmbientLabelProblem } from "@/lib/ambient/types";

/**
 * Whether labelling can work at all right now, as the last call found it.
 *
 * A failed call is otherwise silent: the tick that made it answers with the labels it
 * already had, and the stretch just stays "Not labelled", for days if nobody looks at the
 * log. Most failures pass on their own — a rate limit, an overloaded model, the network —
 * and are worth no more than the next tick trying again. Two do not, and only the person
 * can fix them: the account is out of credit, or the key is refused. Those are kept here so
 * every chunks response can say so, and so the background stops asking the API the same
 * question every tick in the meantime.
 *
 * Held in memory only. A restart forgets it, and the first call after finds it again.
 */

/** How long the background leaves a blocked key alone before trying once more. "Label now" always tries. */
const BLOCKED_RETRY_MS = 10 * 60_000;

type Blocked = AmbientLabelProblem & { keyHash: string };

let blocked: Blocked | null = null;

function keyHash(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex").slice(0, 16);
}

/** The kind of failure only the person can fix, or null for one the next tick may get past. */
export function classifyFailure(error: unknown): AmbientLabelProblem["kind"] | null {
  if (!(error instanceof Anthropic.APIError)) return null;
  const body = error.error as { error?: { type?: string; message?: string } } | undefined;
  const type = body?.error?.type ?? "";
  const message = body?.error?.message ?? error.message;
  // Running out arrives as a 400 invalid_request_error whose message names the balance;
  // newer API versions use 402 / billing_error. Both are the same thing to the person.
  if (error.status === 402 || type === "billing_error" || /credit balance/i.test(message)) return "credits";
  if (error.status === 401 || error.status === 403) return "auth";
  return null;
}

export function recordFailure(apiKey: string, error: unknown): AmbientLabelProblem | null {
  const kind = classifyFailure(error);
  if (!kind) return null;
  const hash = keyHash(apiKey);
  const now = new Date().toISOString();
  // `since` stays where the problem started, so a banner dismissed for it stays dismissed.
  const since = blocked && blocked.kind === kind && blocked.keyHash === hash ? blocked.since : now;
  blocked = { kind, since, lastTried: now, keyHash: hash };
  return { kind, since, lastTried: now };
}

export function recordSuccess(): void {
  blocked = null;
}

/** The problem with this key, if the last call with it found one. A new key starts clean. */
export function labelProblem(apiKey: string): AmbientLabelProblem | null {
  if (!blocked || !apiKey || blocked.keyHash !== keyHash(apiKey)) return null;
  return { kind: blocked.kind, since: blocked.since, lastTried: blocked.lastTried };
}

/** Whether a background call with this key should wait: it failed for good reason a moment ago. */
export function backgroundBlocked(apiKey: string, nowMs: number): boolean {
  const problem = labelProblem(apiKey);
  return problem !== null && nowMs - new Date(problem.lastTried).getTime() < BLOCKED_RETRY_MS;
}
