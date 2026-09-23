import type { AmbientProjectTotal } from "@/lib/ambient/chunks";
import { FALLBACK_BUCKETS, isFallbackBucket } from "@/lib/ambient/projects";

/**
 * One colour per project, shared by the band, the chunk list and the project list so the
 * three read as one encoding. Projects are ranked by how much of the period they hold, so
 * the same project keeps the same colour everywhere on a screen — ranking within the period
 * rather than against a fixed table keeps a day that only touched one project legible.
 *
 * Named projects take the hue wheel; the buckets take a neutral warm ramp. That split is
 * the point: Admin and Personal are the honest remainder, and giving them a hue of their
 * own would make them compete with work the person actually named.
 */

/** Chart sequence: one hue each, same lightness and chroma. Assign in rank order. */
export const SERIES = ["var(--data-1)", "var(--data-2)", "var(--data-3)", "var(--data-4)", "var(--data-5)"];
/** The same hues darkened far enough to set as text on paper. Indexed alongside `SERIES`. */
export const SERIES_TEXT = ["var(--data-1t)", "var(--data-2t)", "var(--data-3t)", "var(--data-4t)", "var(--data-5t)"];
/** Neutral ramp for the buckets, in the order `FALLBACK_BUCKETS` lists them. */
export const BUCKETS = ["var(--bucket-1)", "var(--bucket-2)", "var(--bucket-3)"];
/** Anything not yet labelled. */
export const OTHER_FILL = "var(--paper-4)";
/** Untracked. Must never be merged away, only absorbed when far too small to draw. */
export const GAP_FILL = "var(--paper-2)";
/** Observed, but nothing happened in it: a break, or an idle stretch. */
export const IDLE_FILL = "var(--paper-3)";
/** Stripes rather than a fade: the colour still reads, the texture says something about it. */
export const HATCH = "repeating-linear-gradient(45deg, var(--paper-1) 0 3px, transparent 3px 7px)";

export type FillFor = (project: string | null) => string;

/** Fills for the band and the bars, and the darker tint the same project takes as text. */
export type Palette = { fillFor: FillFor; textFor: FillFor };

export function projectPalette(totals: AmbientProjectTotal[]): Palette {
  const ranked = [...totals]
    .filter((total) => !isFallbackBucket(total.project))
    .sort((a, b) => b.activeMinutes - a.activeMinutes)
    .map((total) => total.project);
  const rank = new Map(ranked.map((project, index) => [project, Math.min(index, SERIES.length - 1)]));

  const bucketIndex = (project: string) => FALLBACK_BUCKETS.indexOf(project as (typeof FALLBACK_BUCKETS)[number]);

  const fillFor: FillFor = (project) => {
    if (project === null) return OTHER_FILL;
    const index = rank.get(project);
    if (index !== undefined) return SERIES[index];
    const bucket = bucketIndex(project);
    return bucket === -1 ? OTHER_FILL : BUCKETS[bucket];
  };

  // Buckets are named in plain subtle ink rather than their own swatch colour: the neutral
  // ramp is chosen to sit quietly behind the projects, and it is far too pale to read as
  // text on paper.
  const textFor: FillFor = (project) => {
    if (project === null) return "var(--ink-3)";
    const index = rank.get(project);
    return index === undefined ? "var(--ink-3)" : SERIES_TEXT[index];
  };

  return { fillFor, textFor };
}

/** The fill half alone, for the screens that never set a project name in colour. */
export function projectFills(totals: AmbientProjectTotal[]): FillFor {
  return projectPalette(totals).fillFor;
}
