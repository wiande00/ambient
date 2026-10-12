import { clock, formatDuration } from "@/lib/ambient/format";
import { longestProjectStretch, type AmbientFocus } from "@/lib/ambient/focus";
import type { AmbientChunk } from "@/lib/ambient/chunks";
import type { AmbientThreadTotal } from "@/lib/ambient/threads";
import { en } from "@/i18n/en";
import { interpolate } from "@/i18n";
import { OTHER_FILL, type FillFor } from "./palette";
import { projectLabel } from "./ProjectList";
import { SectionTitle } from "./DayScreen";

/**
 * How the day's attention moved, and what held it: the quiet companions to the headline
 * figures. Everything here is measured from the windows — no model, no key — and stated as
 * a figure, never a verdict.
 */

const t = en.ambient.rhythm;

/** A row of small figures under the day's headline ones. Figures with nothing to say are left out. */
export function RhythmRow({
  focus,
  chunks,
  names,
}: {
  focus: AmbientFocus;
  chunks: AmbientChunk[];
  names: Record<string, string>;
}) {
  const stretch = longestProjectStretch(chunks);
  const items: { value: string; caption: string; hint?: string }[] = [];
  if (focus.firstActiveAt && focus.lastActiveAt) {
    items.push({ value: clock(focus.firstActiveAt), caption: t.started });
    items.push({ value: clock(focus.lastActiveAt), caption: t.stopped });
  }
  if (stretch && stretch.activeMinutes >= 1) {
    items.push({
      value: formatDuration(stretch.activeMinutes),
      caption: t.longestProject,
      hint: interpolate(t.longestProjectHint, { name: projectLabel(stretch.project, names), range: `${clock(stretch.from)}–${clock(stretch.to)}` }),
    });
  } else if (focus.longestThread) {
    items.push({
      value: formatDuration(focus.longestThread.activeMinutes),
      caption: t.longestThread,
      hint: interpolate(t.longestThreadHint, { name: focus.longestThread.name, range: `${clock(focus.longestThread.from)}–${clock(focus.longestThread.to)}` }),
    });
  }
  if (focus.switchesPerHour !== null) items.push({ value: String(focus.switchesPerHour), caption: t.switches, hint: t.switchesHint });
  if (focus.glanceShare !== null) items.push({ value: `${Math.round(focus.glanceShare * 100)}%`, caption: t.glances, hint: t.glancesHint });
  if (focus.meetingMinutes >= 1) items.push({ value: formatDuration(focus.meetingMinutes), caption: t.calls });
  if (focus.videoMinutes >= 1) items.push({ value: formatDuration(focus.videoMinutes), caption: t.video });
  if (items.length === 0) return null;

  return (
    <dl style={{ display: "flex", flexWrap: "wrap", gap: "14px 32px", margin: "-14px 0 0" }}>
      {items.map((item) => (
        <div key={item.caption} title={item.hint} style={{ display: "flex", flexDirection: "column", gap: 2, cursor: item.hint ? "help" : undefined }}>
          <dd className="ui-mono" style={{ margin: 0, fontSize: 15, color: "var(--ink-2)" }}>
            {item.value}
          </dd>
          <dt style={{ fontSize: 12, color: "var(--ink-4)" }}>{item.caption}</dt>
        </div>
      ))}
    </dl>
  );
}

/** The longest-held conversations, pages and documents of a day or week, each dotted with the project that held most of it. */
export function ThreadTotals({
  heading,
  threads,
  fillFor,
  limit = 8,
}: {
  heading: string;
  threads: AmbientThreadTotal[];
  fillFor: FillFor;
  limit?: number;
}) {
  const rows = threads.filter((thread) => thread.minutes >= 1).slice(0, limit);
  if (rows.length === 0) return null;
  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <SectionTitle>{heading}</SectionTitle>
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 7 }}>
        {rows.map((thread) => (
          <li
            key={`${thread.app}:${thread.name}`}
            title={`${thread.name} · ${thread.app.toLowerCase()}`}
            style={{ display: "grid", gridTemplateColumns: "8px minmax(0, 1fr) auto", alignItems: "center", gap: 9 }}
          >
            <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: 999, background: thread.project ? fillFor(thread.project) : OTHER_FILL }} />
            <span style={{ fontSize: 13, color: "var(--ink-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{thread.name}</span>
            <span className="ui-mono" style={{ fontSize: 12, color: "var(--ink-3)" }}>
              {formatDuration(thread.minutes)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
