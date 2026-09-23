import { Tooltip } from "@/ui/Tooltip";
import { formatDuration } from "@/lib/ambient/format";
import type { AmbientWeekDay, AmbientWeekResponse } from "@/lib/ambient/types";
import { en } from "@/i18n/en";
import { interpolate, localeTag } from "@/i18n";
import { Figure, Figures, SectionTitle, StepButton, TextButton, Title } from "./DayScreen";
import { HATCH, IDLE_FILL, OTHER_FILL, projectFills, type FillFor } from "./palette";
import { ProjectList } from "./ProjectList";

/**
 * Seven days as stacked bars — one block per project, idle hatched on top — and the week's
 * hours by project underneath.
 *
 * Stacking by project rather than by active-versus-idle is what makes the week worth
 * looking at: the same colours as the day screen, so a week reads as seven of those days
 * side by side and a project's run through the week is visible without reading a number.
 *
 * Project totals come only from days that have been labelled; the rest is stated as
 * unlabelled rather than folded into "other".
 */

const t = en.ambient.week;

/** Every bar is drawn against the tallest tracked day, so their heights are comparable. */
type Part = { fill: string; hatched: boolean; minutes: number };

export function WeekScreen({
  week,
  onWeekChange,
}: {
  week: Extract<AmbientWeekResponse, { status: "ready" }>;
  /** Called with the new last day of the window, or null for the week ending today. */
  onWeekChange: (to: string | null) => void;
}) {
  const observed = week.days.filter((day) => day.observed);
  const missing = week.days.length - observed.length;
  const tallest = Math.max(1, ...week.days.map((day) => (day.observed ? day.trackedMinutes : 0)));
  const active = observed.reduce((sum, day) => sum + (day.observed ? day.activeMinutes : 0), 0);
  const idle = observed.reduce((sum, day) => sum + (day.observed ? day.idleMinutes : 0), 0);
  const unlabelledDays = observed.filter((day) => day.observed && !day.labelled).length;
  const fillFor = projectFills(week.projects);
  const viewingPast = week.to !== week.today;
  const longest = observed.reduce<AmbientWeekDay | null>(
    (best, day) => (day.observed && (best === null || !best.observed || day.activeMinutes > best.activeMinutes) ? day : best),
    null,
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 34 }}>
      <header style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 24, flexWrap: "wrap" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
          <span className="ambient-eyebrow" style={{ letterSpacing: "0.2em" }}>
            {viewingPast ? t.eyebrowPast : t.eyebrowThis}
          </span>
          <Title>{interpolate(t.range, { from: formatShort(week.from), to: formatShort(week.to) })}</Title>
          <span style={{ fontSize: 14, color: "var(--ink-3)" }}>{observedLine(observed.length, missing)}</span>
        </div>
        <div role="group" aria-label={t.nav.label} style={{ display: "flex", alignItems: "center", gap: 6, flex: "0 0 auto" }}>
          <StepButton label={t.nav.previous} flip disabled={false} onClick={() => onWeekChange(shift(week.to, -7))} />
          <StepButton label={t.nav.next} disabled={!viewingPast} onClick={() => onWeekChange(shift(week.to, 7))} />
          {viewingPast ? <TextButton label={t.nav.thisWeek} onClick={() => onWeekChange(null)} /> : null}
        </div>
      </header>

      {observed.length === 0 ? (
        <span style={{ fontSize: 15, color: "var(--ink-3)" }}>{t.empty}</span>
      ) : (
        <>
          <Figures>
            <Figure value={formatDuration(active)} caption={t.active} lead />
            <Figure value={formatDuration(idle)} caption={t.idle} tone="var(--ink-3)" />
            <Figure value={formatDuration(active / observed.length)} caption={t.average} tone="var(--ink-4)" />
          </Figures>

          <section style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 16 }}>
              <SectionTitle>{t.byProject}</SectionTitle>
              <span className="ui-mono" style={{ fontSize: 11, color: "var(--ink-4)" }}>
                {interpolate(t.tallest, { duration: formatDuration(tallest) })}
              </span>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(7, minmax(0, 1fr))", gap: 14, alignItems: "end", height: 240 }}>
              {week.days.map((day) => (
                <DayBar key={day.date} day={day} tallest={tallest} fillFor={fillFor} />
              ))}
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(7, minmax(0, 1fr))", gap: 14 }}>
              {week.days.map((day) => (
                <span
                  key={day.date}
                  className="ui-mono"
                  style={{
                    fontSize: 11,
                    color: day.date === week.today ? "var(--ink-1)" : "var(--ink-4)",
                    fontWeight: day.date === week.today ? 600 : 400,
                    textAlign: "center",
                  }}
                >
                  {weekday(day.date)} {Number(day.date.slice(8, 10))}
                </span>
              ))}
            </div>
          </section>

          <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
            <ProjectList
              totals={week.projects}
              names={week.projectNames}
              fillFor={fillFor}
              heading={t.whereWent}
              variant="row"
              activeMinutes={week.projects.reduce((sum, total) => sum + total.activeMinutes, 0)}
              note={
                week.unlabelledMinutes > 0
                  ? interpolate(unlabelledDays === 1 ? t.unlabelledOne : t.unlabelled, {
                      duration: formatDuration(week.unlabelledMinutes),
                      count: unlabelledDays,
                    })
                  : null
              }
            />

            <WorthKnowing longest={longest} missing={missing} />
          </div>
        </>
      )}
    </div>
  );
}

/**
 * One day, stacked: the projects it went to with the largest at the bottom, and the idle
 * time hatched across the top. A day nobody has opened has no projects yet, so its active
 * time draws as one unattributed block rather than claiming a colour it hasn't earned.
 */
function DayBar({ day, tallest, fillFor }: { day: AmbientWeekDay; tallest: number; fillFor: FillFor }) {
  const label = day.observed
    ? interpolate(t.bar, {
        date: formatShort(day.date),
        active: formatDuration(day.activeMinutes),
        idle: formatDuration(day.idleMinutes),
        away: formatDuration(day.awayMinutes),
      })
    : `${formatShort(day.date)}: ${t.notObserved}`;

  const parts: Part[] = [];
  if (day.observed) {
    if (day.idleMinutes > 0) parts.push({ fill: IDLE_FILL, hatched: true, minutes: day.idleMinutes });
    const byProject = [...day.projects].sort((a, b) => a.activeMinutes - b.activeMinutes);
    if (byProject.length > 0) {
      for (const total of byProject) parts.push({ fill: fillFor(total.project), hatched: false, minutes: total.activeMinutes });
    } else if (day.activeMinutes > 0) {
      parts.push({ fill: OTHER_FILL, hatched: false, minutes: day.activeMinutes });
    }
  }

  const last = parts.length - 1;

  return (
    <Tooltip label={label} style={{ height: "100%", display: "flex" }}>
      <div
        role="img"
        aria-label={label}
        style={{ display: "flex", flexDirection: "column", justifyContent: "flex-end", height: "100%", width: "100%", gap: 2 }}
      >
        {parts.length === 0 ? (
          // Not a zero: a hairline where the bar would be, so the day still holds its place.
          <span style={{ display: "block", height: 3, borderRadius: 999, background: "var(--data-track)" }} />
        ) : (
          parts.map((part, index) => (
            <span
              key={index}
              style={{
                display: "block",
                width: "100%",
                height: `${(part.minutes / tallest) * 100}%`,
                backgroundColor: part.fill,
                backgroundImage: part.hatched ? HATCH : undefined,
                borderRadius: index === 0 ? "8px 8px 0 0" : index === last ? "0 0 8px 8px" : 0,
              }}
            />
          ))
        )}
      </div>
    </Tooltip>
  );
}

/** The two things about the week that a bar chart cannot say on its own. */
function WorthKnowing({ longest, missing }: { longest: AmbientWeekDay | null; missing: number }) {
  if (longest === null || !longest.observed) return null;
  return (
    <div
      style={{
        display: "flex",
        gap: 20,
        flexWrap: "wrap",
        padding: 20,
        border: "1px solid var(--border-soft)",
        borderRadius: 18,
        background: "var(--panel-2)",
      }}
    >
      <span className="ambient-eyebrow" style={{ flexBasis: "100%" }}>
        {t.worthKnowing}
      </span>
      <span style={{ fontSize: 14, lineHeight: 1.5, color: "var(--ink-1)", flex: 1, minWidth: 220 }}>
        {interpolate(t.longest, { date: weekdayLong(longest.date), duration: formatDuration(longest.activeMinutes) })}
      </span>
      {missing > 0 ? (
        <span style={{ fontSize: 14, lineHeight: 1.5, color: "var(--ink-3)", flex: 1, minWidth: 220 }}>{t.unobservedNote}</span>
      ) : null}
    </div>
  );
}

/** e.g. "6 days observed · one day the collector wasn't running". */
function observedLine(observed: number, missing: number): string {
  const seen = observed === 1 ? t.observedOne : interpolate(t.observedDays, { count: String(observed) });
  if (missing === 0) return seen;
  const gone = missing === 1 ? t.missingOne : interpolate(t.missingDays, { count: String(missing) });
  return `${seen} · ${gone}`;
}

function shift(stamp: string, delta: number): string {
  const [y, m, d] = stamp.split("-").map(Number);
  const at = new Date(y, m - 1, d + delta);
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
}

function formatShort(stamp: string): string {
  const [y, m, d] = stamp.split("-").map(Number);
  return new Intl.DateTimeFormat(localeTag(), { day: "numeric", month: "long" }).format(new Date(y, m - 1, d));
}

function weekday(stamp: string): string {
  const [y, m, d] = stamp.split("-").map(Number);
  return new Intl.DateTimeFormat(localeTag(), { weekday: "short" }).format(new Date(y, m - 1, d));
}

function weekdayLong(stamp: string): string {
  const [y, m, d] = stamp.split("-").map(Number);
  return new Intl.DateTimeFormat(localeTag(), { weekday: "long" }).format(new Date(y, m - 1, d));
}
