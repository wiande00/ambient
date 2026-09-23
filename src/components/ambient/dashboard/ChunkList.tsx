import { useState, type ReactNode } from "react";
import { Icon } from "@/ui/Icon";
import type { AmbientChunk, AmbientDaySegment } from "@/lib/ambient/chunks";
import { clock, formatDuration } from "@/lib/ambient/format";
import type { AmbientChunksResponse, AmbientEditsResponse } from "@/lib/ambient/types";
import { en } from "@/i18n/en";
import { interpolate } from "@/i18n";
import { ChunkEditor, type EditorTarget } from "./ChunkEditor";
import { SectionTitle, TextButton } from "./DayScreen";
import { GAP_FILL, HATCH, IDLE_FILL, OTHER_FILL, type FillFor } from "./palette";
import { projectLabel } from "./ProjectList";

/**
 * The day as a list: one card per chunk, in order, with the breaks and absences between
 * them drawn as thin rules so the list has the same shape as the band above it.
 *
 * The measured figures — the clock range, active and idle minutes — are always present. The
 * sentence and the project are interpreted and arrive later, or not at all; a card without
 * them says so rather than leaving a blank. The sentence is the largest text on the screen
 * after the figures, because it is the one thing here nobody could have worked out
 * themselves.
 *
 * Once the chunks are in, the list is also where the day is corrected: a card opens into a
 * form in place, a break or a gap takes an added stretch, and a removed stretch keeps a row
 * of its own so it can be given back. Nothing here touches the model — the day re-measures
 * with the edit on the next fetch.
 */

const t = en.ambient.chunks;
const labels = en.ambient.labels;
const te = en.ambient.edit;

export type LabelState = "loading" | "ready" | "noKey" | "unavailable";

/** What editing needs, present only once the chunks have arrived. */
export type ChunkEditing = {
  date: string;
  today: string;
  /** Where "Add a stretch" ends on a past day: the end of what was observed. */
  observedTo: string | null;
  projects: { value: string; label: string }[];
  /** The response the list is showing. A saved edit keeps its form up until a newer one replaces it. */
  source: Extract<AmbientChunksResponse, { status: "ready" }>;
  onChanged: () => void;
  /** "Label now" came back with the day as it now stands; show that rather than fetch it again. */
  onLabelled: (next: AmbientChunksResponse) => void;
};

/** Which row is open, and — once saved — the response it was saved against. */
type Open = { key: string; target: EditorTarget; savedWith?: ChunkEditing["source"] };

/**
 * "Label now" is one call for everything unlabelled on the day, so the whole list waits on
 * it together. `note` says why a stretch is still unlabelled afterwards, on the card that asked.
 */
type Labelling = { key: string; busy: boolean; note: string | null };

export function ChunkList({
  segments,
  chunks,
  names,
  fillFor,
  textFor,
  labelState,
  editing,
}: {
  segments: AmbientDaySegment[];
  chunks: AmbientChunk[];
  names: Record<string, string>;
  fillFor: FillFor;
  textFor: FillFor;
  labelState: LabelState;
  editing: ChunkEditing | null;
}) {
  const [openState, setOpen] = useState<Open | null>(null);
  const [restoring, setRestoring] = useState<{ key: string; savedWith: ChunkEditing["source"] } | null>(null);
  const [labelling, setLabelling] = useState<Labelling | null>(null);
  // A saved form stays up, busy, until the day it changed comes back, so the old card never
  // flashes up again in between. Derived rather than cleared in an effect.
  const open = openState && editing && (openState.savedWith === undefined || openState.savedWith === editing.source) ? openState : null;
  const restoringKey = restoring && editing && restoring.savedWith === editing.source ? restoring.key : null;

  const editor = (key: string) =>
    editing && open?.key === key ? (
      <ChunkEditor
        key={key}
        target={open.target}
        date={editing.date}
        projects={editing.projects}
        fillFor={fillFor}
        onCancel={() => setOpen(null)}
        onSaved={() => {
          setOpen({ ...open, savedWith: editing.source });
          editing.onChanged();
        }}
      />
    ) : null;

  const defaultProject = (before: AmbientChunk | undefined) =>
    before && before.label !== null ? before.project : (editing?.projects[0]?.value ?? "other");

  async function restore(key: string, from: string, to: string) {
    if (!editing) return;
    setRestoring({ key, savedWith: editing.source });
    try {
      const res = await fetch("/api/ambient/edits", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ date: editing.date, op: "revert", from, to }),
      });
      const next: AmbientEditsResponse = await res.json();
      if (next.status !== "ready") setRestoring(null);
    } catch {
      setRestoring(null);
    }
    editing.onChanged();
  }

  async function labelNow(key: string) {
    if (!editing) return;
    setLabelling({ key, busy: true, note: null });
    let note: string | null = null;
    try {
      const res = await fetch("/api/ambient/chunks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ date: editing.date }),
      });
      const next: AmbientChunksResponse = await res.json();
      if (next.status === "ready") {
        editing.onLabelled(next);
        // The call went through, but an answer that did not fit leaves its stretch as it was.
        if (next.unlabelled.length > 0) note = labels.labelRejected;
      } else if (next.status === "not_configured") {
        note = labels.noKey;
      } else if (next.status === "error") {
        note = interpolate(labels.labelFailed, { message: next.message });
      }
    } catch (error) {
      note = interpolate(labels.labelFailed, { message: error instanceof Error ? error.message : String(error) });
    }
    setLabelling(note ? { key, busy: false, note } : null);
  }

  /** Whether "Label now" would reach this chunk: it lies in a stretch the model could still label. */
  const labellable = (chunk: AmbientChunk) => {
    if (!editing || chunk.label !== null) return false;
    const mid = (Date.parse(chunk.from) + Date.parse(chunk.to)) / 2;
    return editing.source.unlabelled.some((range) => Date.parse(range.from) <= mid && mid <= Date.parse(range.to));
  };

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 16, paddingBottom: 6 }}>
        <SectionTitle>{t.heading}</SectionTitle>
        {editing && open?.key !== "top" ? (
          <TextButton label={te.add} onClick={() => setOpen({ key: "top", target: { mode: "add", initial: addDefaults(editing, chunks, defaultProject) } })} />
        ) : null}
      </div>

      {editor("top")}

      {segments.map((segment, index) => {
        if (segment.kind === "break" || segment.kind === "away") {
          const key = `gap:${segment.from}`;
          if (open?.key === key) return editor(key);
          const text =
            segment.kind === "break"
              ? interpolate(t.breakRow, { duration: formatDuration(segment.minutes) })
              : interpolate(t.awayRow, { why: en.ambient.band[segment.why], duration: formatDuration(segment.minutes) });
          const removed = segment.kind === "away" && segment.why === "removed";
          const before = chunks.filter((chunk) => chunk.label !== null && Date.parse(chunk.to) <= Date.parse(segment.from)).pop();
          return (
            <Divider key={key} text={text} hatched={segment.kind === "break"}>
              {!editing ? null : removed ? (
                <RowAction label={te.restore} busy={restoringKey === key} onClick={() => void restore(key, segment.from, segment.to)} visible />
              ) : (
                <RowAction
                  label={te.addHere}
                  title={interpolate(te.addHereLabel, { range: interpolate(t.range, { from: clock(segment.from), to: clock(segment.to) }) })}
                  icon="plus"
                  onClick={() =>
                    setOpen({
                      key,
                      target: { mode: "add", initial: { from: segment.from, to: segment.to, project: defaultProject(before), label: "", active: true } },
                    })
                  }
                />
              )}
            </Divider>
          );
        }

        const own = chunks.filter((chunk) => chunk.candidate === segment.index);
        if (own.length === 0) {
          return (
            <PendingCard key={index} from={segment.from} to={segment.to} minutes={segment.minutes} text={pendingText(labelState)} />
          );
        }
        return own.map((chunk) => {
          const key = `chunk:${chunk.from}`;
          if (open?.key === key) return editor(key);
          const canLabel = labellable(chunk);
          return (
            <ChunkCard
              key={key}
              chunk={chunk}
              names={names}
              fillFor={fillFor}
              textFor={textFor}
              label={
                canLabel
                  ? {
                      busy: labelling?.busy ?? false,
                      note: labelling?.key === key ? labelling.note : null,
                      onClick: () => void labelNow(key),
                    }
                  : null
              }
              onEdit={
                editing
                  ? () =>
                      setOpen({
                        key,
                        target: {
                          mode: "edit",
                          initial: {
                            from: chunk.from,
                            to: chunk.to,
                            project: chunk.label === null ? defaultProject(lastLabelledBefore(chunks, chunk)) : chunk.project,
                            label: chunk.label ?? "",
                            active: chunk.edit?.active ?? false,
                          },
                          original: { from: chunk.from, to: chunk.to, edited: chunk.edit !== undefined },
                        },
                      })
                  : null
              }
            />
          );
        });
      })}
    </section>
  );
}

/** The nearest labelled chunk before this one: an unlabelled stretch is most likely more of the same. */
function lastLabelledBefore(chunks: AmbientChunk[], chunk: AmbientChunk): AmbientChunk | undefined {
  return chunks.filter((other) => other.label !== null && Date.parse(other.to) <= Date.parse(chunk.from)).pop();
}

/**
 * Where "Add a stretch" starts: the half hour up to now on today, or up to the end of what
 * was observed on a past day, in the project the day last worked on.
 */
function addDefaults(editing: ChunkEditing, chunks: AmbientChunk[], defaultProject: (before: AmbientChunk | undefined) => string): EditorTarget["initial"] {
  const [y, m, d] = editing.date.split("-").map(Number);
  const dayStartMs = new Date(y, m - 1, d).getTime();
  const endMs = editing.date === editing.today || editing.observedTo === null ? Date.now() : Date.parse(editing.observedTo);
  const toMs = Math.floor(endMs / 60_000) * 60_000;
  const fromMs = Math.max(dayStartMs, toMs - 30 * 60_000);
  const labelled = chunks.filter((chunk) => chunk.label !== null).pop();
  return { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString(), project: defaultProject(labelled), label: "", active: true };
}

function pendingText(state: LabelState): string {
  switch (state) {
    case "loading":
      return labels.pending;
    case "noKey":
      return labels.noKey;
    default:
      return labels.unavailable;
  }
}

/**
 * Active minutes inside one chunk that belonged to a project other than its headline one,
 * largest first. Under a minute is noise on a card and is left to the totals.
 */
function otherProjects(chunk: AmbientChunk): { project: string; activeMinutes: number }[] {
  if (!chunk.projects || chunk.projects.length < 2) return [];
  const byProject = new Map<string, number>();
  for (const line of chunk.projects) {
    if (line.project === chunk.project) continue;
    byProject.set(line.project, (byProject.get(line.project) ?? 0) + line.activeMinutes);
  }
  return [...byProject.entries()]
    .map(([project, activeMinutes]) => ({ project, activeMinutes }))
    .filter((entry) => entry.activeMinutes >= 1)
    .sort((a, b) => b.activeMinutes - a.activeMinutes);
}

function ChunkCard({
  chunk,
  names,
  fillFor,
  textFor,
  label,
  onEdit,
}: {
  chunk: AmbientChunk;
  names: Record<string, string>;
  fillFor: FillFor;
  textFor: FillFor;
  /** "Label now", on an unlabelled chunk a call could still label. */
  label: { busy: boolean; note: string | null; onClick: () => void } | null;
  onEdit: (() => void) | null;
}) {
  const unlabelled = chunk.label === null;
  const quiet = chunk.minutes > 0 && chunk.idleMinutes / chunk.minutes >= 0.5;
  const fill = unlabelled ? OTHER_FILL : fillFor(chunk.project);
  const activeShare = chunk.minutes > 0 ? Math.round((chunk.activeMinutes / chunk.minutes) * 100) : 0;
  // The ledger behind the headline. A stretch that held more than one project keeps one
  // sentence and one colour, but says here where the rest of its minutes went, so the
  // project totals below can never be larger than what this card admits to.
  const others = otherProjects(chunk);

  return (
    <Shell rail={quiet ? IDLE_FILL : fill} hatched={quiet}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 16 }}>
        <span className="ui-mono" style={{ fontSize: 12, color: "var(--ink-3)" }}>
          {interpolate(t.range, { from: clock(chunk.from), to: clock(chunk.to) })}
        </span>
        <span
          style={{ display: "flex", alignItems: "center", gap: 10, flex: "0 0 auto" }}
          title={interpolate(t.activeShare, { active: formatDuration(chunk.activeMinutes), total: formatDuration(chunk.minutes) })}
        >
          {/* How much of the stretch was actually worked, so a long quiet block never reads
              as a long busy one at a glance. */}
          <span aria-hidden="true" style={{ display: "flex", width: 56, height: 4, borderRadius: 999, overflow: "hidden", background: "var(--data-track)" }}>
            <span style={{ width: `${activeShare}%`, background: quiet ? "var(--paper-4)" : fill }} />
          </span>
          <span className="ui-mono" style={{ fontSize: 15, color: "var(--ink-1)" }}>
            {formatDuration(chunk.minutes)}
          </span>
          {onEdit ? (
            <button type="button" aria-label={te.editLabel} title={te.editLabel} onClick={onEdit} className="ambient-row-action ambient-card-edit">
              <Icon name="pencil" size={14} />
            </button>
          ) : null}
        </span>
      </div>

      <span style={{ fontSize: 19, lineHeight: 1.45, color: unlabelled ? "var(--ink-4)" : "var(--ink-1)", fontStyle: unlabelled ? "italic" : undefined }}>
        {chunk.label ?? (label?.busy ? labels.pending : labels.notLabelled)}
      </span>

      {label && !label.busy ? (
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <button type="button" onClick={label.onClick} title={labels.labelNowHint} className="ambient-label-now">
            <Icon name="sparkles" size={13} />
            {labels.labelNow}
          </button>
          {label.note ? <span style={{ fontSize: 13, color: "var(--ink-4)" }}>{label.note}</span> : null}
        </div>
      ) : null}

      {!unlabelled ? (
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: textFor(chunk.project) }}>{projectLabel(chunk.project, names)}</span>
          {chunk.what ? <span style={{ fontSize: 13, color: "var(--ink-3)" }}>{chunk.what}</span> : null}
          {others.map((other) => (
            <span key={other.project} className="ui-mono" style={{ fontSize: 11, color: textFor(other.project) }}>
              {interpolate(t.alsoProject, { name: projectLabel(other.project, names), duration: formatDuration(other.activeMinutes) })}
            </span>
          ))}
          {chunk.idleMinutes > 0 ? (
            <span className="ui-mono" style={{ fontSize: 11, color: "var(--ink-4)" }}>
              {interpolate(t.idleIn, { duration: formatDuration(chunk.idleMinutes) })}
            </span>
          ) : null}
          {chunk.unclear ? <span style={{ fontSize: 13, color: "var(--ink-4)" }}>{labels.unclear}</span> : null}
          {chunk.edit ? <span style={{ fontSize: 12, color: "var(--ink-4)" }}>{te.edited}</span> : null}
        </div>
      ) : null}
    </Shell>
  );
}

function PendingCard({ from, to, minutes, text }: { from: string; to: string; minutes: number; text: string }) {
  return (
    <Shell rail="var(--paper-3)">
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 16 }}>
        <span className="ui-mono" style={{ fontSize: 12, color: "var(--ink-3)" }}>
          {interpolate(t.range, { from: clock(from), to: clock(to) })}
        </span>
        <span className="ui-mono" style={{ fontSize: 15, color: "var(--ink-1)", flex: "0 0 auto" }}>
          {formatDuration(minutes)}
        </span>
      </div>
      <span style={{ fontSize: 19, lineHeight: 1.45, color: "var(--ink-4)", fontStyle: "italic" }}>{text}</span>
    </Shell>
  );
}

/** One card: a colour rail down the left, and the stretch beside it. */
function Shell({ rail, hatched, children }: { rail: string; hatched?: boolean; children: ReactNode }) {
  return (
    <article
      className="ambient-row"
      style={{
        display: "flex",
        gap: 16,
        padding: "18px 20px 18px 18px",
        background: "var(--panel-2)",
        border: "1px solid var(--border-soft)",
        borderRadius: 20,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 4,
          alignSelf: "stretch",
          borderRadius: 999,
          background: rail,
          backgroundImage: hatched ? HATCH : undefined,
          flex: "0 0 auto",
        }}
      />
      <div style={{ display: "flex", flexDirection: "column", gap: 9, flex: 1, minWidth: 0 }}>{children}</div>
    </article>
  );
}

/**
 * The time between two chunks, drawn rather than listed. Hatched for a break — observed,
 * but nobody was typing — and bare for time that was never observed at all. `children` is
 * the row's action, at its end.
 */
function Divider({ text, hatched, children }: { text: string; hatched?: boolean; children?: ReactNode }) {
  return (
    <div className="ambient-row" style={{ display: "flex", alignItems: "center", gap: 12, padding: "2px 8px", minHeight: 28 }}>
      <span
        aria-hidden="true"
        style={{
          flex: 1,
          height: 5,
          borderRadius: 999,
          background: hatched ? IDLE_FILL : GAP_FILL,
          backgroundImage: hatched ? HATCH : undefined,
        }}
      />
      <span className="ui-mono" style={{ fontSize: 11, color: "var(--ink-4)", whiteSpace: "nowrap" }}>
        {text}
      </span>
      {children}
    </div>
  );
}

/**
 * A small action at the end of a row. Quiet until the row is hovered or focused, so a day
 * of dividers does not read as a day of buttons; `visible` keeps it up regardless, for the
 * one a removed stretch needs to be found by.
 */
function RowAction({
  label,
  title,
  icon,
  busy,
  visible,
  onClick,
}: {
  label: string;
  title?: string;
  icon?: string;
  busy?: boolean;
  visible?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={title ?? label}
      aria-label={title ?? label}
      disabled={busy}
      onClick={onClick}
      className={`ambient-row-action${visible ? " ambient-row-action-on" : ""}`}
      style={{ fontFamily: "var(--font-sans)", fontSize: 12, fontWeight: 700, gap: 4, padding: "4px 10px" }}
    >
      {icon ? <Icon name={icon} size={12} /> : null}
      {label}
    </button>
  );
}
