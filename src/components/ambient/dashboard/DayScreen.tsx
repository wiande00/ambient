import type { CSSProperties, ReactNode } from "react";
import { Icon } from "@/ui/Icon";
import { FALLBACK_BUCKETS, isFallbackBucket } from "@/lib/ambient/projects";
import { clock, formatDuration } from "@/lib/ambient/format";
import type { AmbientChunksResponse, AmbientDayResponse } from "@/lib/ambient/types";
import { en } from "@/i18n/en";
import { interpolate, localeTag } from "@/i18n";
import { ChunkList, type ChunkEditing, type LabelState } from "./ChunkList";
import { DayBand } from "./DayBand";
import { OffComputerControl } from "./OffComputerControl";
import { GAP_FILL, HATCH, IDLE_FILL, projectPalette } from "./palette";
import { ProjectList, projectLabel } from "./ProjectList";
import { useIsDesktop } from "./useDesktop";

/**
 * One day, read top to bottom: what day it is, the three figures that sum it up, the shape
 * of it as a single band, then what actually happened in words.
 *
 * The measured parts paint from the day response alone; the sentences and the project
 * colours arrive with the chunks response and the screen stands without them. That ordering
 * is why the figures and the band come first — they are the part that is always true.
 */

const t = en.ambient;

export function DayScreen({
  day,
  chunks,
  onDateChange,
  onChanged,
  onChunks,
  refreshKey,
}: {
  day: Extract<AmbientDayResponse, { status: "ready" | "empty" }>;
  chunks: AmbientChunksResponse | { status: "loading" };
  onDateChange: (date: string | null) => void;
  /** Something on this screen changed the day (the off-computer switch, an edit to a chunk); refetch it. */
  onChanged: () => void;
  /** A fresh chunks response fetched from this screen ("Label now"), to show in place of the current one. */
  onChunks: (next: AmbientChunksResponse) => void;
  /** Bumped by the dashboard's refresh tick, so controls with their own fetch re-read too. */
  refreshKey: number;
}) {
  // Step between days that actually have a log rather than by the calendar: a blank day in
  // the middle of the week is not a screen worth landing on.
  const dayIndex = day.days.indexOf(day.date);
  const previousDay = dayIndex > 0 ? day.days[dayIndex - 1] : dayIndex === -1 ? latestBefore(day.days, day.date) : null;
  const nextDay = dayIndex >= 0 && dayIndex < day.days.length - 1 ? day.days[dayIndex + 1] : null;
  const viewingPast = day.date !== day.today;

  const ready = chunks.status === "ready" ? chunks : null;
  const { fillFor, textFor } = projectPalette(ready?.projects ?? []);
  const names = ready?.projectNames ?? {};
  const labelState: LabelState =
    chunks.status === "loading" ? "loading" : chunks.status === "not_configured" ? "noKey" : chunks.status === "ready" ? "ready" : "unavailable";

  // Correcting the day needs the project list, which arrives with the chunks.
  const editing: ChunkEditing | null =
    ready && day.status === "ready"
      ? {
          date: day.date,
          today: day.today,
          observedTo: day.totals.to,
          projects: [
            ...Object.entries(ready.projectNames).map(([value, label]) => ({ value, label })),
            ...FALLBACK_BUCKETS.map((key) => ({ value: key, label: t.projects.buckets[key] })),
          ],
          source: ready,
          onChanged,
          onLabelled: onChunks,
        }
      : null;

  const since = formatSince(day.days[0] ?? day.date, day.today);
  const observed = day.status === "ready" ? interpolate(t.day.span, { from: clock(day.totals.from), to: clock(day.totals.to) }) : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 34 }}>
      <header style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 24, flexWrap: "wrap" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
          <span className="ambient-eyebrow" style={{ letterSpacing: "0.2em" }}>
            {viewingPast ? t.day.eyebrowPast : t.day.eyebrowToday}
          </span>
          <Title>{formatDate(day.date)}</Title>
          <span style={{ fontSize: 14, color: "var(--ink-3)" }}>
            {observed ? `${observed} · ` : ""}
            {interpolate(t.day.since, { since })}
          </span>
        </div>

        <div role="group" aria-label={t.day.nav.label} style={{ display: "flex", alignItems: "center", gap: 6, flex: "0 0 auto" }}>
          <StepButton label={t.day.nav.previous} flip disabled={previousDay === null} onClick={() => previousDay && onDateChange(previousDay)} />
          <StepButton label={t.day.nav.next} disabled={nextDay === null} onClick={() => nextDay && onDateChange(nextDay)} />
          {viewingPast ? <TextButton label={t.day.nav.today} onClick={() => onDateChange(null)} /> : null}
        </div>
      </header>

      {day.status === "empty" ? (
        <EmptyDay isToday={!viewingPast} />
      ) : (
        <>
          <Figures>
            <Figure value={formatDuration(day.totals.activeMinutes)} caption={t.day.active} lead />
            <Figure value={formatDuration(day.totals.idleMinutes)} caption={t.day.idle} tone="var(--ink-3)" />
            <Figure value={formatDuration(day.totals.awayMinutes)} caption={t.day.away} tone="var(--ink-4)" />
          </Figures>

          {day.totals.estimatedIdle ? (
            <span style={{ fontSize: 13, color: "var(--ink-4)", maxWidth: "72ch", lineHeight: "var(--leading-body)", marginTop: -20 }}>
              {t.day.estimatedNote}
            </span>
          ) : null}

          {day.band ? (
            <section style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 16 }}>
                <SectionTitle>{t.day.shape}</SectionTitle>
                <span className="ui-mono" style={{ fontSize: 11, color: "var(--ink-4)" }}>
                  {interpolate(t.day.shapeRange, { from: clock(day.totals.from), to: clock(day.totals.to) })}
                </span>
              </div>
              <DayBand band={day.band} segments={day.segments} chunks={ready?.chunks ?? []} fillFor={fillFor} />
              <Legend projects={(ready?.projects ?? []).map((total) => total.project)} names={names} fillFor={fillFor} />
            </section>
          ) : null}

          <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 260px", gap: 40, alignItems: "start" }}>
            <ChunkList
              segments={day.segments}
              chunks={ready?.chunks ?? []}
              names={names}
              fillFor={fillFor}
              textFor={textFor}
              labelState={labelState}
              editing={editing}
            />

            <div style={{ display: "flex", flexDirection: "column", gap: 20, position: "sticky", top: 24 }}>
              <ProjectList
                totals={ready?.projects ?? []}
                names={names}
                fillFor={fillFor}
                activeMinutes={day.totals.activeMinutes}
                note={ready?.projectsError ? interpolate(t.projects.fileError, { message: ready.projectsError }) : null}
              />
              {!viewingPast ? <OffComputerControl onChanged={onChanged} refreshKey={refreshKey} /> : null}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/** The band's key: one swatch per project the day touched, then the two kinds of not-working. */
function Legend({
  projects,
  names,
  fillFor,
  style,
}: {
  projects: string[];
  names: Record<string, string>;
  fillFor: (project: string | null) => string;
  style?: CSSProperties;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 18, flexWrap: "wrap", ...style }}>
      {projects.map((project) => (
        <Key
          key={project}
          fill={fillFor(project)}
          label={projectLabel(project, names)}
          // Buckets are the remainder; they say so by sitting a shade back from the projects.
          tone={isFallbackBucket(project) ? "var(--ink-3)" : "var(--ink-2)"}
        />
      ))}
      <Key fill={IDLE_FILL} hatched label={t.day.legend.idle} tone="var(--ink-3)" />
      <Key fill={GAP_FILL} label={t.day.legend.away} tone="var(--ink-3)" />
    </div>
  );
}

function Key({ fill, hatched, label, tone }: { fill: string; hatched?: boolean; label: string; tone: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 7, fontSize: 12, color: tone }}>
      <span
        aria-hidden="true"
        style={{ width: 9, height: 9, borderRadius: 999, background: fill, backgroundImage: hatched ? HATCH : undefined, flex: "0 0 auto" }}
      />
      {label}
    </span>
  );
}

/** The three figures that sum the period up, ruled off from what follows. */
export function Figures({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-end",
        gap: 52,
        flexWrap: "wrap",
        paddingBottom: 30,
        borderBottom: "1px solid var(--border-soft)",
      }}
    >
      {children}
    </div>
  );
}

/**
 * One figure. `lead` is the one the screen is about — active time — and it is set nearly
 * half again as large as the other two, because the difference between them is the point.
 */
export function Figure({ value, caption, lead, tone }: { value: string; caption: string; lead?: boolean; tone?: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      <span
        style={{
          fontFamily: "var(--font-display)",
          fontWeight: lead ? 800 : 700,
          fontSize: lead ? 64 : 40,
          lineHeight: 0.92,
          letterSpacing: "-0.03em",
          color: tone ?? "var(--ink-1)",
        }}
      >
        {value}
      </span>
      <span
        className="ambient-eyebrow"
        style={{ fontSize: 11, letterSpacing: "0.16em", paddingTop: lead ? 12 : 10, color: lead ? "var(--ink-3)" : "var(--ink-4)" }}
      >
        {caption}
      </span>
    </div>
  );
}

/** The screen's own name for the day or the week. */
export function Title({ children }: { children: ReactNode }) {
  return (
    <h1
      style={{
        margin: 0,
        fontFamily: "var(--font-display)",
        fontWeight: 800,
        fontSize: 40,
        lineHeight: 1.06,
        letterSpacing: "-0.022em",
        color: "var(--ink-1)",
      }}
    >
      {children}
    </h1>
  );
}

/** A heading over one block within a screen. */
export function SectionTitle({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <span
      style={{
        fontFamily: "var(--font-display)",
        fontWeight: 800,
        fontSize: 21,
        letterSpacing: "-0.015em",
        color: "var(--ink-1)",
        ...style,
      }}
    >
      {children}
    </span>
  );
}

function EmptyDay({ isToday }: { isToday: boolean }) {
  // The desktop app runs the collector itself, so the command line is web-only advice.
  const desktop = useIsDesktop();
  const copy = isToday ? { title: t.empty.title, body: desktop ? t.empty.body : t.empty.bodyWeb } : t.emptyDay;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, maxWidth: 560 }}>
      <SectionTitle>{copy.title}</SectionTitle>
      <span style={{ fontSize: 15, color: "var(--ink-3)", lineHeight: "var(--leading-body)" }}>{copy.body}</span>
      {isToday && !desktop ? (
        <code
          className="ui-mono"
          style={{ alignSelf: "flex-start", fontSize: 13, padding: "8px 12px", borderRadius: 12, background: "var(--panel-2)", border: "1px solid var(--border-soft)" }}
        >
          {t.empty.command}
        </code>
      ) : null}
    </div>
  );
}

/** The latest logged date strictly before `date`, for stepping back from a day with no log. */
function latestBefore(days: string[], date: string): string | null {
  const earlier = days.filter((d) => d < date);
  return earlier.length > 0 ? earlier[earlier.length - 1] : null;
}

export function formatDate(stamp: string): string {
  const [y, m, d] = stamp.split("-").map(Number);
  return new Intl.DateTimeFormat(localeTag(), { weekday: "long", day: "numeric", month: "long" }).format(new Date(y, m - 1, d));
}

/**
 * A weekday alone ("Tuesday") is only unambiguous inside the last week; past that it names
 * a day that could be any of several, so the full date is used instead.
 */
function formatSince(since: string, today: string): string {
  const [sy, sm, sd] = since.split("-").map(Number);
  const [ty, tm, td] = today.split("-").map(Number);
  const sinceAt = new Date(sy, sm - 1, sd);
  const daysApart = Math.round((new Date(ty, tm - 1, td).getTime() - sinceAt.getTime()) / 86_400_000);
  return daysApart < 7
    ? new Intl.DateTimeFormat(localeTag(), { weekday: "long" }).format(sinceAt)
    : new Intl.DateTimeFormat(localeTag(), { day: "numeric", month: "long" }).format(sinceAt);
}

/** One step control. A real button, so it is focusable and operable by keyboard. */
export function StepButton({ label, flip, disabled, onClick }: { label: string; flip?: boolean; disabled: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="ambient-step"
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 36,
        height: 36,
        borderRadius: 12,
        border: `1px solid var(${disabled ? "--border-soft" : "--border-hairline"})`,
        background: `var(${disabled ? "--panel-2" : "--panel"})`,
        color: disabled ? "var(--paper-4)" : "var(--ink-2)",
        cursor: disabled ? "not-allowed" : "pointer",
      }}
    >
      <Icon name="chevron-right" size={15} style={flip ? { transform: "scaleX(-1)" } : undefined} />
    </button>
  );
}

export function TextButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        border: "none",
        background: "none",
        padding: "0 8px",
        cursor: "pointer",
        fontFamily: "var(--font-sans)",
        fontSize: 12,
        fontWeight: 700,
        color: "var(--text-accent)",
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </button>
  );
}
