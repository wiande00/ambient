import type { AmbientProjectTotal } from "@/lib/ambient/chunks";
import { formatDuration } from "@/lib/ambient/format";
import { isFallbackBucket } from "@/lib/ambient/projects";
import { en } from "@/i18n/en";
import { interpolate } from "@/i18n";
import { SectionTitle } from "./DayScreen";
import type { FillFor } from "./palette";

/**
 * Hours per project, most active first, bar drawn against the largest row. Buckets are
 * dimmed rather than dropped: they are the honest remainder, and hiding them would make the
 * named projects look like the whole of the time.
 *
 * Two shapes, same data. `stacked` is the day screen's narrow rail, where the name and the
 * total share a line and the bar sits under them. `row` is the week's full width, where
 * there is room to line the names, bars, totals and shares up into columns that can be read
 * down as well as across.
 */

const t = en.ambient.projects;

export function ProjectList({
  totals,
  names,
  fillFor,
  heading,
  note,
  variant = "stacked",
  activeMinutes,
}: {
  totals: AmbientProjectTotal[];
  names: Record<string, string>;
  fillFor: FillFor;
  heading?: string;
  /** A line under the list — a projects.json error, or how much is still unlabelled. */
  note?: string | null;
  variant?: "stacked" | "row";
  /** The period's active total, for the share under each bar. Omit to leave shares off. */
  activeMinutes?: number;
}) {
  const largest = Math.max(1, ...totals.map((total) => total.activeMinutes));
  const denominator = activeMinutes && activeMinutes > 0 ? activeMinutes : null;

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <SectionTitle>{heading ?? t.heading}</SectionTitle>

      {/* Only when there is genuinely no projects file: an empty list on a window with no
          labelled days is explained by the note below, not by a setup hint. */}
      {totals.length === 0 && Object.keys(names).length === 0 ? (
        <span style={{ fontSize: 13, color: "var(--ink-4)", lineHeight: "var(--leading-body)" }}>{t.none}</span>
      ) : null}

      <div style={{ display: "flex", flexDirection: "column", gap: variant === "stacked" ? 14 : 16 }}>
        {totals.map((total) => {
          const bucket = isFallbackBucket(total.project);
          const width = `${Math.round((total.activeMinutes / largest) * 100)}%`;
          const share = denominator === null ? null : Math.round((total.activeMinutes / denominator) * 100);
          const ink = bucket ? "var(--ink-3)" : "var(--ink-1)";
          const title = interpolate(t.rowTitle, {
            active: formatDuration(total.activeMinutes),
            idle: formatDuration(total.idleMinutes),
          });

          if (variant === "row") {
            return (
              <div key={total.project} title={title} style={{ display: "flex", alignItems: "center", gap: 14 }}>
                {/* Wider than the mockup's 96px: real project names are whole course titles, and the
                    column is only worth lining up if the names in it survive. */}
                <span style={{ width: 150, flex: "0 0 auto", fontSize: 15, fontWeight: 600, color: ink, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {projectLabel(total.project, names)}
                </span>
                <Bar width={width} fill={fillFor(total.project)} height={9} grow />
                <span className="ui-mono" style={{ fontSize: 14, color: ink, width: 58, textAlign: "right", flex: "0 0 auto" }}>
                  {formatDuration(total.activeMinutes)}
                </span>
                <span className="ui-mono" style={{ fontSize: 11, color: "var(--ink-4)", width: 34, textAlign: "right", flex: "0 0 auto" }}>
                  {share === null ? "" : `${share}%`}
                </span>
              </div>
            );
          }

          return (
            <div key={total.project} title={title} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10 }}>
                <span style={{ fontSize: 14, fontWeight: 600, color: ink, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {projectLabel(total.project, names)}
                </span>
                <span className="ui-mono" style={{ fontSize: 13, color: ink, flex: "0 0 auto" }}>
                  {formatDuration(total.activeMinutes)}
                </span>
              </span>
              <Bar width={width} fill={fillFor(total.project)} height={7} />
              {share === null ? null : (
                <span className="ui-mono" style={{ fontSize: 10, color: "var(--ink-4)" }}>
                  {interpolate(t.share, { percent: String(share) })}
                </span>
              )}
            </div>
          );
        })}
      </div>

      {note ? <span style={{ fontSize: 12, color: "var(--ink-4)", lineHeight: "var(--leading-body)" }}>{note}</span> : null}
    </section>
  );
}

/** `grow` only in the row variant: in the stacked one the parent is a column, where
    `flex: 1` would stretch the bar down the card instead of across it. */
function Bar({ width, fill, height, grow }: { width: string; fill: string; height: number; grow?: boolean }) {
  return (
    <span
      aria-hidden="true"
      style={{ display: "block", flex: grow ? 1 : undefined, height, borderRadius: 999, background: "var(--data-track)", overflow: "hidden" }}
    >
      <span style={{ display: "block", width, height: "100%", background: fill }} />
    </span>
  );
}

/** The display name for a project key or bucket. */
export function projectLabel(project: string, names: Record<string, string>): string {
  if (isFallbackBucket(project)) return t.buckets[project];
  return names[project] ?? project;
}
