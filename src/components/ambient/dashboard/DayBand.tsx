"use client";

import type { CSSProperties, ReactNode } from "react";
import { Tooltip } from "@/ui/Tooltip";
import type { AmbientChunk, AmbientDaySegment } from "@/lib/ambient/chunks";
import type { AmbientAwayKind } from "@/lib/ambient/intervals";
import { clock, formatDuration } from "@/lib/ambient/format";
import type { AmbientTimeline } from "@/lib/ambient/timeline";
import { en } from "@/i18n/en";
import { interpolate } from "@/i18n";
import { GAP_FILL, HATCH, IDLE_FILL, OTHER_FILL, type FillFor } from "./palette";

/**
 * The day as one band: every tracked stretch drawn in proportion and coloured by the
 * project it went to, every break and idle stretch hatched, every absence left as bare
 * track. Hover any piece and it says what it was.
 *
 * The gaps are the point. A band that closed up its gaps would render an untracked hour as
 * though the person had been in some app the whole time. Bare track reads as absence, its
 * tooltip says why in words (locked, asleep, not observed), and the note under the band
 * says it again.
 *
 * Two rendering passes stand between the measured spans and what is drawn. First, every
 * span joins a group — the chunk covering it, the break it falls in, a gap, or a run of
 * consecutive stretches nothing labels — and takes that group's fill, so one chunk is one
 * block however many windows it was made of. Second, anything too narrow to draw is
 * absorbed into its neighbour: a two-second credential prompt is a fraction of a pixel
 * across a two-hour band, and left in it splits the stretch around it in two. Absorbed
 * pieces keep their width, handed to the neighbour they interrupted, so no time is lost and
 * no gap is invented.
 */

const t = en.ambient.band;

/**
 * A segment narrower than this is absorbed rather than drawn. Both conditions have to hold:
 * the absolute cap keeps a genuinely long day from swallowing a real multi-minute gap just
 * because it is a small fraction of twelve hours.
 */
const MIN_DRAWN_SHARE = 0.005;
const MIN_DRAWN_SECONDS = 60;
/** A stretch idle for at least this share of its length is hatched. */
const QUIET_SHARE = 0.5;

type Group =
  | { kind: "gap"; why: AmbientAwayKind }
  | { kind: "break" }
  | { kind: "chunk"; chunk: AmbientChunk }
  | { kind: "unlabelled"; run: number };

type Segment = {
  startMs: number;
  endMs: number;
  activeMs: number;
  idleMs: number;
  group: Group;
  fill: string;
  hatched: boolean;
};

export function DayBand({
  band,
  segments,
  chunks,
  fillFor,
  style,
}: {
  band: AmbientTimeline;
  /** The day's cut: candidates, breaks and away gaps. */
  segments: AmbientDaySegment[];
  /** Labelled chunks. Empty until the read lands — the band still draws. */
  chunks: AmbientChunk[];
  fillFor: FillFor;
  style?: CSSProperties;
}) {
  const startMs = new Date(band.start).getTime();
  const endMs = new Date(band.end).getTime();
  const totalMs = endMs - startMs;
  if (!(totalMs > 0)) return null;

  const breaks = segments.filter((s) => s.kind === "break").map((s) => ({ startMs: ms(s.from), endMs: ms(s.to) }));
  const aways = segments.filter((s) => s.kind === "away").map((s) => ({ startMs: ms(s.from), endMs: ms(s.to), why: s.why }));
  const cuts = breaks.flatMap((b) => [b.startMs, b.endMs]).sort((a, b) => a - b);

  const raw: Segment[] = [];
  let cursorMs = startMs;
  let run = 0;
  let previousUnlabelled = false;

  const pushGap = (fromMs: number, toMs: number) => {
    const mid = fromMs + (toMs - fromMs) / 2;
    const away = aways.find((a) => mid >= a.startMs && mid <= a.endMs);
    raw.push({ startMs: fromMs, endMs: toMs, activeMs: 0, idleMs: 0, group: { kind: "gap", why: away?.why ?? "unobserved" }, fill: GAP_FILL, hatched: false });
    previousUnlabelled = false;
  };

  for (const span of band.spans) {
    const spanStart = ms(span.from);
    const spanEnd = ms(span.to);
    if (spanStart > cursorMs) pushGap(cursorMs, spanStart);

    // Split the span wherever a break begins or ends inside it, so the break can take its
    // own fill without the span's colour bleeding across it.
    const edges = [spanStart, ...cuts.filter((cut) => cut > spanStart && cut < spanEnd), spanEnd];
    for (let i = 0; i < edges.length - 1; i++) {
      const pieceStart = edges[i];
      const pieceEnd = edges[i + 1];
      const share = (pieceEnd - pieceStart) / Math.max(1, spanEnd - spanStart);
      const activeMs = span.active_minutes * 60_000 * share;
      const idleMs = span.idle_minutes * 60_000 * share;
      const mid = pieceStart + (pieceEnd - pieceStart) / 2;

      let group: Group;
      if (breaks.some((b) => mid >= b.startMs && mid <= b.endMs)) {
        group = { kind: "break" };
      } else {
        const chunk = chunks.find((c) => mid >= ms(c.from) && mid <= ms(c.to));
        if (chunk) {
          group = { kind: "chunk", chunk };
        } else {
          if (!previousUnlabelled) run += 1;
          group = { kind: "unlabelled", run };
        }
      }
      previousUnlabelled = group.kind === "unlabelled";

      raw.push({ startMs: pieceStart, endMs: pieceEnd, activeMs, idleMs, group, ...appearance(group, idleMs, pieceEnd - pieceStart, chunks.length > 0, fillFor) });
    }
    cursorMs = spanEnd;
  }
  if (cursorMs < endMs) pushGap(cursorMs, endMs);

  const drawn = collapse(raw, totalMs);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, ...style }}>
      {/* Deliberately no `overflow: hidden`: `Tooltip` renders its popup as an absolutely
          positioned child of the segment, entirely outside this box, so clipping the
          container would hide every tooltip on the band. The ends are rounded by rounding
          the first and last fills instead. */}
      <div
        role="list"
        aria-label={t.label}
        className="ambient-band"
        style={{
          display: "flex",
          height: 78,
          borderRadius: 16,
          // The ground shows through wherever nothing was observed, so the band is never
          // shorter than the day: absence is drawn, not omitted.
          background: GAP_FILL,
          boxShadow: "inset 0 0 0 1px var(--border-soft)",
        }}
      >
        {drawn.map((segment, index) => {
          const first = index === 0;
          const last = index === drawn.length - 1;
          // Placement follows where the segment actually sits, not its index: a first
          // segment that fills most of the band is centred like any other, and only a
          // stretch hard against an edge opens inward instead.
          const centre = (segment.startMs + (segment.endMs - segment.startMs) / 2 - startMs) / totalMs;
          return (
            <Tooltip
              key={index}
              label={tooltipLabel(segment)}
              placement={centre < 0.2 ? "right" : centre > 0.8 ? "left" : "top"}
              // A labelled stretch's headline is a whole sentence; left to run on one line
              // it would be wider than the screen.
              labelStyle={{ whiteSpace: "normal", maxWidth: 280, width: "max-content" }}
              style={{ width: `${((segment.endMs - segment.startMs) / totalMs) * 100}%` }}
            >
              <div
                role="listitem"
                aria-label={ariaLabel(segment)}
                style={{
                  width: "100%",
                  height: "100%",
                  backgroundColor: segment.fill,
                  backgroundImage: segment.hatched ? HATCH : undefined,
                  borderTopLeftRadius: first ? 16 : 0,
                  borderBottomLeftRadius: first ? 16 : 0,
                  borderTopRightRadius: last ? 16 : 0,
                  borderBottomRightRadius: last ? 16 : 0,
                }}
              />
            </Tooltip>
          );
        })}
      </div>

      {/* Absolutely positioned at each hour's real offset, not spaced evenly: the bar is
          proportional, so the ruler under it has to be too. */}
      <div style={{ position: "relative", height: 16 }}>
        {hourTicks(startMs, endMs).map(({ hour, offsetPct }) => (
          <span
            key={hour}
            className="ui-mono"
            style={{
              position: "absolute",
              left: `${offsetPct}%`,
              transform: offsetPct <= 1 ? "none" : offsetPct >= 99 ? "translateX(-100%)" : "translateX(-50%)",
              fontSize: 10,
              color: "var(--ink-4)",
            }}
          >
            {String(hour).padStart(2, "0")}
          </span>
        ))}
      </div>
    </div>
  );
}

function ms(iso: string): number {
  return new Date(iso).getTime();
}

/** Fill and hatching for a piece, decided by its group. */
function appearance(group: Group, idleMs: number, durationMs: number, labelled: boolean, fillFor: FillFor): { fill: string; hatched: boolean } {
  switch (group.kind) {
    case "gap":
      return { fill: GAP_FILL, hatched: false };
    case "break":
      return { fill: IDLE_FILL, hatched: true };
    case "chunk": {
      const chunk = group.chunk;
      const quiet = chunk.minutes > 0 && chunk.idleMinutes / chunk.minutes >= QUIET_SHARE;
      return { fill: quiet ? IDLE_FILL : chunk.label === null ? OTHER_FILL : fillFor(chunk.project), hatched: quiet };
    }
    case "unlabelled": {
      // Before any chunk exists the per-piece ratio is the only signal; once chunks exist a
      // piece they missed stays neutral rather than making its own claim.
      const quiet = !labelled && durationMs > 0 && idleMs / durationMs >= QUIET_SHARE;
      return { fill: quiet ? IDLE_FILL : OTHER_FILL, hatched: quiet };
    }
  }
}

function headline(segment: Segment): string {
  switch (segment.group.kind) {
    case "gap":
      return t[segment.group.why];
    case "break":
      return t.breakLabel;
    case "chunk":
      return segment.group.chunk.label ?? en.ambient.labels.notLabelled;
    case "unlabelled":
      return en.ambient.labels.notLabelled;
  }
}

/** The times the sentence is about: the chunk's own when one covers this piece, else the piece's. */
function when(segment: Segment): string {
  const chunk = segment.group.kind === "chunk" ? segment.group.chunk : null;
  const fromMs = chunk ? ms(chunk.from) : segment.startMs;
  const toMs = chunk ? ms(chunk.to) : segment.endMs;
  const range = `${interpolate(t.range, { from: clock(fromMs), to: clock(toMs) })} · ${formatDuration((toMs - fromMs) / 60_000)}`;
  if (chunk) {
    return `${range} · ${interpolate(en.ambient.labels.activeIdle, {
      active: formatDuration(chunk.activeMinutes),
      idle: formatDuration(chunk.idleMinutes),
    })}`;
  }
  return range;
}

function tooltipLabel(segment: Segment): ReactNode {
  return (
    <>
      <span style={{ display: "block", fontWeight: "var(--weight-semibold)" }}>{headline(segment)}</span>
      <span style={{ display: "block", opacity: 0.7, marginTop: 4 }}>{when(segment)}</span>
    </>
  );
}

function ariaLabel(segment: Segment): string {
  return `${headline(segment)}, ${when(segment)}`;
}

function sameGroup(a: Group, b: Group): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "chunk" && b.kind === "chunk") return a.chunk === b.chunk;
  if (a.kind === "unlabelled" && b.kind === "unlabelled") return a.run === b.run;
  if (a.kind === "gap" && b.kind === "gap") return a.why === b.why;
  return true;
}

/**
 * Merge neighbours in the same group, then hand any segment too narrow to draw to the
 * neighbour beside it and merge again. The band's total span is preserved exactly at every
 * step: absorption moves the boundary between two segments, it never discards time.
 */
function collapse(segments: Segment[], totalMs: number): Segment[] {
  const minMs = Math.min(totalMs * MIN_DRAWN_SHARE, MIN_DRAWN_SECONDS * 1000);
  let current = merge(segments);
  for (;;) {
    if (current.length <= 1) break;
    const index = current.findIndex((segment) => segment.endMs - segment.startMs < minMs);
    if (index === -1) break;
    const sliver = current[index];
    const next = current.filter((_, i) => i !== index);
    const receiver = index > 0 ? next[index - 1] : next[0];
    if (index > 0) receiver.endMs = sliver.endMs;
    else receiver.startMs = sliver.startMs;
    receiver.activeMs += sliver.activeMs;
    receiver.idleMs += sliver.idleMs;
    current = merge(next);
  }
  return current;
}

function merge(segments: Segment[]): Segment[] {
  const merged: Segment[] = [];
  for (const segment of segments) {
    const last = merged[merged.length - 1];
    if (last && sameGroup(last.group, segment.group) && last.fill === segment.fill) {
      last.endMs = segment.endMs;
      last.activeMs += segment.activeMs;
      last.idleMs += segment.idleMs;
      continue;
    }
    merged.push({ ...segment });
  }
  return merged;
}

/**
 * Whole hours that fall inside the observed span, each at its true offset along the band.
 * The step widens until at most six labels remain.
 */
function hourTicks(startMs: number, endMs: number): { hour: number; offsetPct: number }[] {
  const totalMs = endMs - startMs;
  if (!(totalMs > 0)) return [];
  const firstTick = new Date(startMs);
  firstTick.setMinutes(0, 0, 0);
  if (firstTick.getTime() < startMs) firstTick.setHours(firstTick.getHours() + 1);
  const hoursSpanned = Math.floor((endMs - firstTick.getTime()) / 3_600_000);
  if (hoursSpanned < 0) return [];
  const step = Math.max(1, Math.ceil((hoursSpanned + 1) / 6));
  const ticks: { hour: number; offsetPct: number }[] = [];
  for (let i = 0; i <= hoursSpanned; i += step) {
    const at = new Date(firstTick);
    at.setHours(at.getHours() + i);
    ticks.push({ hour: at.getHours(), offsetPct: ((at.getTime() - startMs) / totalMs) * 100 });
  }
  return ticks;
}
