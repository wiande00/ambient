import { FALLBACK_BUCKETS, type ProjectColor } from "@/lib/ambient/projects";

/**
 * One colour per project, shared by the band, the chunk list and the project list so the
 * three read as one encoding. A project keeps its colour on every screen and every day: the
 * one picked in Settings, else one handed out by its place in the projects list
 * (`projectColors`). Ranking by the period's hours instead made a project change colour from
 * one day to the next, depending on what else got time that day.
 *
 * Named projects take the hue wheel; the Other bucket takes a neutral warm tone. That split
 * is the point: Other is the honest remainder, and giving it a hue of its own would make it
 * compete with work the person actually named.
 */

/** A project colour as a fill: one hue each, same lightness and chroma. */
export function colorFill(color: ProjectColor): string {
  return `var(--project-${color})`;
}
/** The same hue darkened far enough to set as text on paper. */
export function colorText(color: ProjectColor): string {
  return `var(--project-${color}-t)`;
}

/** Neutral fill for the buckets, in the order `FALLBACK_BUCKETS` lists them. */
export const BUCKETS = ["var(--bucket)"];
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

export function projectPalette(colors: Record<string, ProjectColor>): Palette {
  const bucketIndex = (project: string) => FALLBACK_BUCKETS.indexOf(project as (typeof FALLBACK_BUCKETS)[number]);

  // A key the list no longer holds — a project removed after its day was labelled — takes
  // the bucket's fill rather than borrowing a colour a listed project owns.
  const fillFor: FillFor = (project) => {
    if (project === null) return OTHER_FILL;
    const color = colors[project];
    if (color) return colorFill(color);
    const bucket = bucketIndex(project);
    return BUCKETS[bucket === -1 ? 0 : bucket];
  };

  // Buckets are named in plain subtle ink rather than their own swatch colour: the neutral
  // ramp is chosen to sit quietly behind the projects, and it is far too pale to read as
  // text on paper.
  const textFor: FillFor = (project) => {
    const color = project === null ? undefined : colors[project];
    return color ? colorText(color) : "var(--ink-3)";
  };

  return { fillFor, textFor };
}

/** The fill half alone, for the screens that never set a project name in colour. */
export function projectFills(colors: Record<string, ProjectColor>): FillFor {
  return projectPalette(colors).fillFor;
}
