"use client";

import { useState } from "react";
import { Button } from "@/ui/Button";
import { Field } from "@/ui/Field";
import { Input } from "@/ui/Input";
import { clock } from "@/lib/ambient/format";
import { en } from "@/i18n/en";
import { interpolate } from "@/i18n";
import { SectionTitle, Title } from "./DayScreen";
import { formatClock, pomodoro, remainingAt, useNow, usePomodoro, type Lengths, type Phase } from "./usePomodoro";

/**
 * The pomodoro screen: the clock as a ring, the three controls, and the lengths beside it.
 *
 * The timer itself lives in `usePomodoro`, outside this screen, so it keeps running while
 * the day or the week is up and the sidebar shows what is left. It is a reminder, nothing
 * more: the day is still measured from the windows, whatever the timer says.
 */

const t = en.ambient.focus;

/** Focus in the day's green; breaks in the quieter second colour, so a glance says which. */
const RING: Record<Phase, string> = { work: "var(--data-1)", shortBreak: "var(--data-2)", longBreak: "var(--data-2)" };

export function FocusScreen() {
  const s = usePomodoro();
  const running = s.endsAt !== null;
  const now = useNow(running);
  const left = remainingAt(s, now);
  const total = s.lengths[s.phase] * 60_000;
  const progress = total > 0 ? 1 - left / total : 0;

  const status = running ? interpolate(t.endsAt, { time: clock(s.endsAt!) }) : s.started ? t.paused : t.ready;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 34 }}>
      <header style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <span className="ambient-eyebrow" style={{ letterSpacing: "0.2em" }}>
          {t.eyebrow}
        </span>
        <Title>{t.phases[s.phase]}</Title>
        <span style={{ fontSize: 14, color: "var(--ink-3)" }}>
          {interpolate(t.round, { done: String(Math.min(s.round + (s.phase === "work" ? 1 : 0), s.lengths.every)), every: String(s.lengths.every) })}
          {" · "}
          {s.doneToday === 1 ? t.todayOne : interpolate(t.today, { count: String(s.doneToday) })}
        </span>
      </header>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 260px", gap: 40, alignItems: "start" }}>
        <section style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 28, paddingTop: 8 }}>
          <Ring progress={progress} color={RING[s.phase]}>
            <span
              className="ui-mono"
              role="timer"
              aria-live="off"
              style={{ fontSize: 64, fontWeight: 600, letterSpacing: "-0.04em", color: "var(--ink-1)", fontVariantNumeric: "tabular-nums" }}
            >
              {formatClock(left)}
            </span>
            <span className="ambient-eyebrow" style={{ fontSize: 11, letterSpacing: "0.16em", color: "var(--ink-3)" }}>
              {status}
            </span>
          </Ring>

          <Rounds done={s.round} every={s.lengths.every} phase={s.phase} />

          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <Button type="button" variant="outline" onClick={pomodoro.reset} disabled={!s.started}>
              {t.reset}
            </Button>
            <Button type="button" variant="primary" size="lg" onClick={running ? pomodoro.pause : pomodoro.start} style={{ minWidth: 132 }}>
              {running ? t.pause : s.started ? t.resume : t.start}
            </Button>
            <Button type="button" variant="outline" onClick={pomodoro.skip}>
              {t.skip}
            </Button>
          </div>
        </section>

        {/* Keyed to the saved lengths, so the fields reset if they change from elsewhere. */}
        <LengthsForm key={JSON.stringify(s.lengths)} lengths={s.lengths} />
      </div>
    </div>
  );
}

const SIZE = 300;
const STROKE = 10;

function Ring({ progress, color, children }: { progress: number; color: string; children: React.ReactNode }) {
  const r = (SIZE - STROKE) / 2;
  const circumference = 2 * Math.PI * r;
  return (
    <div style={{ position: "relative", width: SIZE, height: SIZE }}>
      <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} aria-hidden="true" style={{ transform: "rotate(-90deg)" }}>
        <circle cx={SIZE / 2} cy={SIZE / 2} r={r} fill="none" stroke="var(--data-track)" strokeWidth={STROKE} />
        <circle
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={STROKE}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - Math.min(1, Math.max(0, progress)))}
          style={{ transition: "stroke-dashoffset 1s linear" }}
        />
      </svg>
      <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 6 }}>
        {children}
      </div>
    </div>
  );
}

/** One dot per focus round before the long break; the finished ones filled, the current one ringed. */
function Rounds({ done, every, phase }: { done: number; every: number; phase: Phase }) {
  return (
    <div aria-hidden="true" style={{ display: "flex", gap: 8 }}>
      {Array.from({ length: every }, (_, i) => {
        const filled = i < done || phase === "longBreak";
        const current = phase === "work" && i === done;
        return (
          <span
            key={i}
            style={{
              width: 10,
              height: 10,
              borderRadius: 999,
              background: filled ? "var(--data-1)" : "transparent",
              border: `2px solid ${filled || current ? "var(--data-1)" : "var(--paper-4)"}`,
            }}
          />
        );
      })}
    </div>
  );
}

const LIMITS: Record<keyof Lengths, [number, number]> = { work: [1, 180], shortBreak: [1, 60], longBreak: [1, 120], every: [1, 12] };

function LengthsForm({ lengths }: { lengths: Lengths }) {
  const [draft, setDraft] = useState<Record<keyof Lengths, string>>({
    work: String(lengths.work),
    shortBreak: String(lengths.shortBreak),
    longBreak: String(lengths.longBreak),
    every: String(lengths.every),
  });

  const valid = (key: keyof Lengths) => {
    const n = Number(draft[key]);
    return Number.isInteger(n) && n >= LIMITS[key][0] && n <= LIMITS[key][1];
  };

  // Saved as soon as a field is left with a valid number; an invalid one springs back.
  function commit() {
    const keys = Object.keys(LIMITS) as (keyof Lengths)[];
    const next = Object.fromEntries(keys.map((key) => [key, valid(key) ? Number(draft[key]) : lengths[key]])) as Lengths;
    if (keys.some((key) => next[key] !== lengths[key])) pomodoro.setLengths(next);
    else setDraft(Object.fromEntries(keys.map((key) => [key, String(lengths[key])])) as Record<keyof Lengths, string>);
  }

  const field = (key: keyof Lengths, label: string) => (
    <Field label={label} htmlFor={`focus-${key}`}>
      <Input
        id={`focus-${key}`}
        type="number"
        inputMode="numeric"
        size="sm"
        min={LIMITS[key][0]}
        max={LIMITS[key][1]}
        value={draft[key]}
        invalid={!valid(key)}
        onChange={(event) => setDraft((d) => ({ ...d, [key]: event.target.value }))}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit();
        }}
      />
    </Field>
  );

  return (
    <section
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 14,
        padding: 18,
        border: "1px solid var(--border-soft)",
        borderRadius: 18,
        background: "var(--panel-2)",
      }}
    >
      <SectionTitle style={{ fontSize: 17 }}>{t.settings}</SectionTitle>
      {field("work", t.work)}
      {field("shortBreak", t.shortBreak)}
      {field("longBreak", t.longBreak)}
      {field("every", t.every)}
      <span style={{ fontSize: 12, color: "var(--ink-3)", lineHeight: 1.5 }}>{t.hint}</span>
    </section>
  );
}
