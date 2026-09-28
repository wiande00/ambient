"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { en } from "@/i18n/en";

/**
 * The pomodoro timer: one module-level store, so it keeps time while other screens are up.
 *
 * The timer is a timestamp, not a countdown. A running phase stores when it ends, and the
 * remaining time is always that minus now — so a throttled tab, a window hidden in the tray
 * or a reload cannot make it drift. Paused, it stores what was left instead. The whole state
 * sits in localStorage, so a reload or a restart of the app picks up where it was; a phase
 * that ended while nothing was open is finished the moment the page reads it back.
 *
 * Only the end of a phase needs an event of its own. It is one timeout, set for the end,
 * that plays a chime, raises a notification and moves on to the next phase — paused, so a
 * break never starts behind the person's back. Anything that draws the clock asks for a
 * re-render once a second through `useNow`, which keeps the rest of the dashboard still.
 */

export type Phase = "work" | "shortBreak" | "longBreak";

export type Lengths = { work: number; shortBreak: number; longBreak: number; every: number };

export type PomodoroState = {
  phase: Phase;
  /** Epoch ms the running phase ends at; null while paused or not started. */
  endsAt: number | null;
  /** Ms left in the phase while paused or not started. */
  remaining: number;
  /** Whether the current phase has been started at all, for the Start/Resume wording. */
  started: boolean;
  /** Focus rounds finished since the last long break. */
  round: number;
  /** Focus rounds finished on `day`. */
  doneToday: number;
  day: string;
  lengths: Lengths;
};

const KEY = "ambient.pomodoro";
const MINUTE = 60_000;

export const DEFAULT_LENGTHS: Lengths = { work: 25, shortBreak: 5, longBreak: 15, every: 4 };

function today(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function fresh(lengths: Lengths = DEFAULT_LENGTHS): PomodoroState {
  return { phase: "work", endsAt: null, remaining: lengths.work * MINUTE, started: false, round: 0, doneToday: 0, day: today(), lengths };
}

const SERVER_STATE = fresh();

let state: PomodoroState | null = null;
let timer: number | undefined;
const listeners = new Set<() => void>();

function load(): PomodoroState {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const saved = JSON.parse(raw) as PomodoroState;
      if (saved && typeof saved.remaining === "number" && saved.lengths) return { ...fresh(saved.lengths), ...saved };
    }
  } catch {
    // Unreadable or blocked storage: start clean.
  }
  return fresh();
}

function read(): PomodoroState {
  if (state === null) {
    state = load();
    // A phase that ran out while the app was closed ends now, quietly.
    if (state.endsAt !== null && state.endsAt <= Date.now()) state = advance(state);
    schedule();
  }
  // Keep the "today" count to today, for a dashboard left open overnight.
  if (state.day !== today()) state = { ...state, day: today(), doneToday: 0 };
  return state;
}

function write(next: PomodoroState): void {
  state = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Storage is a convenience here; the timer still runs for this session.
  }
  schedule();
  for (const listener of listeners) listener();
}

function schedule(): void {
  window.clearTimeout(timer);
  timer = undefined;
  if (state?.endsAt == null) return;
  timer = window.setTimeout(finish, Math.max(0, state.endsAt - Date.now()));
}

/** The phase after this one, paused at its full length. Counts a finished focus round. */
function advance(current: PomodoroState): PomodoroState {
  const { lengths } = current;
  if (current.phase === "work") {
    const round = current.round + 1;
    const long = round >= lengths.every;
    const phase: Phase = long ? "longBreak" : "shortBreak";
    const doneToday = (current.day === today() ? current.doneToday : 0) + 1;
    return { ...current, phase, endsAt: null, remaining: lengths[phase] * MINUTE, started: false, round: long ? 0 : round, doneToday, day: today() };
  }
  return { ...current, phase: "work", endsAt: null, remaining: lengths.work * MINUTE, started: false };
}

function finish(): void {
  const current = read();
  if (current.endsAt === null) return;
  const wasWork = current.phase === "work";
  write(advance(current));
  chime();
  notify(wasWork);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function usePomodoro(): PomodoroState {
  return useSyncExternalStore(subscribe, read, () => SERVER_STATE);
}

/** The clock, re-read once a second while `running`; frozen otherwise. */
export function useNow(running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const tick = () => setNow(Date.now());
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [running]);
  return now;
}

/** "24:59" — minutes and seconds, rounded up so the clock never shows 0:00 before the end. */
export function formatClock(ms: number): string {
  const total = Math.ceil(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** The time left in the phase, in ms, as of `now`. */
export function remainingAt(s: PomodoroState, now: number): number {
  return s.endsAt === null ? s.remaining : Math.max(0, s.endsAt - now);
}

export const pomodoro = {
  start(): void {
    const s = read();
    if (s.endsAt !== null) return;
    askToNotify();
    write({ ...s, endsAt: Date.now() + s.remaining, started: true });
  },
  pause(): void {
    const s = read();
    if (s.endsAt === null) return;
    write({ ...s, endsAt: null, remaining: Math.max(0, s.endsAt - Date.now()) });
  },
  /** Back to the start of the current phase, paused. */
  reset(): void {
    const s = read();
    write({ ...s, endsAt: null, remaining: s.lengths[s.phase] * MINUTE, started: false });
  },
  /** On to the next phase without counting this one. */
  skip(): void {
    const s = read();
    // A skipped focus round is not a finished one: it goes to a short break and counts nothing.
    write(
      s.phase === "work"
        ? { ...s, phase: "shortBreak", endsAt: null, remaining: s.lengths.shortBreak * MINUTE, started: false }
        : advance(s),
    );
  },
  setLengths(lengths: Lengths): void {
    const s = read();
    // A phase that has not started takes the new length at once; one in progress keeps its own.
    write({ ...s, lengths, remaining: s.started ? s.remaining : lengths[s.phase] * MINUTE, round: Math.min(s.round, lengths.every - 1) });
  },
};

/** Ask for notification permission on the first Start in a browser. Electron grants it already. */
function askToNotify(): void {
  if (typeof Notification !== "undefined" && Notification.permission === "default") {
    Notification.requestPermission().catch(() => undefined);
  }
}

function notify(wasWork: boolean): void {
  const copy = en.ambient.focus.notify;
  try {
    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      new Notification(wasWork ? copy.workDone : copy.breakDone, {
        body: wasWork ? copy.workDoneBody : copy.breakDoneBody,
        icon: "/brand/ambient-mark.png",
        silent: true,
      });
    }
  } catch {
    // No notifications here; the chime and the screen still say it.
  }
}

/** Two soft sine notes, a fifth apart. Synthesised, so there is no audio file to ship. */
function chime(): void {
  try {
    const ctx = new AudioContext();
    const notes = [659.25, 987.77];
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const at = ctx.currentTime + i * 0.22;
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(0.18, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 1.1);
      osc.connect(gain).connect(ctx.destination);
      osc.start(at);
      osc.stop(at + 1.2);
    });
    window.setTimeout(() => void ctx.close(), 2000);
  } catch {
    // No audio device; the notification still says it.
  }
}
