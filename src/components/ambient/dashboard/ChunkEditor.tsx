import { useId, useState, type KeyboardEvent } from "react";
import { Button } from "@/ui/Button";
import { Checkbox } from "@/ui/Checkbox";
import { Field } from "@/ui/Field";
import { Input } from "@/ui/Input";
import { Select } from "@/ui/Select";
import { clock, formatDuration } from "@/lib/ambient/format";
import type { AmbientEditsResponse } from "@/lib/ambient/types";
import { en } from "@/i18n/en";
import { interpolate } from "@/i18n";
import type { FillFor } from "./palette";

/**
 * Saying what a stretch really was, in place of its card: the times, a sentence, the
 * project, and — when editing — whether the idle time in it was really work. Adding is the
 * same form over a break, a gap or any times typed in; an added stretch always counts as
 * worked, since it is time the screen did not show as work.
 *
 * Times are typed as clock minutes, but a stretch's real edges are to the second. An
 * untouched time is sent as the exact edge it came from, and the server takes a typed one
 * within a minute of a real edge to mean that edge, so neither leaves a sliver behind.
 */

const t = en.ambient.edit;

export type EditorDraft = { from: string; to: string; project: string; label: string; active: boolean };

export type EditorTarget =
  | { mode: "add"; initial: EditorDraft }
  /** `original` is the stretch as it stands; `edited` when it is already the person's own. */
  | { mode: "edit"; initial: EditorDraft; original: { from: string; to: string; edited: boolean } };

type Busy = "save" | "delete" | "undo" | null;

export function ChunkEditor({
  target,
  date,
  projects,
  fillFor,
  onCancel,
  onSaved,
}: {
  target: EditorTarget;
  /** The day the stretch is on, YYYY-MM-DD. */
  date: string;
  projects: { value: string; label: string }[];
  fillFor: FillFor;
  onCancel: () => void;
  /** The edit is stored; the day will re-measure on the next fetch. */
  onSaved: () => void;
}) {
  const id = useId();
  const { initial } = target;
  const [fromClock, setFromClock] = useState(clock(initial.from));
  const [toClock, setToClock] = useState(clock(initial.to));
  const [project, setProject] = useState(initial.project);
  const [label, setLabel] = useState(initial.label);
  const [active, setActive] = useState(initial.active);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);

  const from = resolveClock(date, fromClock, initial.from, false);
  const to = resolveClock(date, toClock, initial.to, true);
  const minutes = from && to ? (Date.parse(to) - Date.parse(from)) / 60_000 : null;

  async function send(kind: Exclude<Busy, null>, body: Record<string, unknown>) {
    setBusy(kind);
    setError(null);
    try {
      const res = await fetch("/api/ambient/edits", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ date, ...body }),
      });
      const next: AmbientEditsResponse = await res.json();
      if (next.status !== "ready") {
        setError(interpolate(t.failed, { message: next.message }));
        setBusy(null);
        return;
      }
      onSaved();
    } catch (err) {
      setError(interpolate(t.failed, { message: err instanceof Error ? err.message : "Request failed." }));
      setBusy(null);
    }
  }

  function save() {
    if (!from || !to || minutes === null || minutes <= 0) {
      setError(t.invalidRange);
      return;
    }
    if (!label.trim()) {
      setError(t.sentenceRequired);
      return;
    }
    void send("save", {
      op: "label",
      from,
      to,
      project,
      label: label.trim(),
      active: target.mode === "add" ? true : active,
      ...(target.mode === "edit" ? { clear: { from: target.original.from, to: target.original.to } } : {}),
    });
  }

  function onKeyDown(event: KeyboardEvent<HTMLFormElement>) {
    if (event.key === "Escape" && busy === null) {
      event.preventDefault();
      onCancel();
    }
  }

  const disabled = busy !== null;

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
      onKeyDown={onKeyDown}
      aria-label={target.mode === "add" ? t.add : t.editLabel}
      style={{
        display: "flex",
        gap: 16,
        padding: "18px 20px 18px 18px",
        background: "var(--panel)",
        border: "1px solid var(--border-hairline)",
        borderRadius: 20,
        boxShadow: "var(--sh-1)",
      }}
    >
      <span aria-hidden="true" style={{ width: 4, alignSelf: "stretch", borderRadius: 999, background: fillFor(project), flex: "0 0 auto" }} />

      <div style={{ display: "flex", flexDirection: "column", gap: 14, flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "flex-end", gap: 10, flexWrap: "wrap" }}>
          <Field label={t.from} htmlFor={`${id}-from`}>
            <Input id={`${id}-from`} type="time" size="sm" step={60} value={fromClock} disabled={disabled} required onChange={(event: { target: { value: string } }) => setFromClock(event.target.value)} style={{ width: 132 }} />
          </Field>
          <span aria-hidden="true" style={{ paddingBottom: 11, color: "var(--ink-4)" }}>
            –
          </span>
          <Field label={t.to} htmlFor={`${id}-to`}>
            <Input id={`${id}-to`} type="time" size="sm" step={60} value={toClock} disabled={disabled} required onChange={(event: { target: { value: string } }) => setToClock(event.target.value)} style={{ width: 132 }} />
          </Field>
          <span className="ui-mono" style={{ marginLeft: "auto", paddingBottom: 11, fontSize: 15, color: minutes !== null && minutes > 0 ? "var(--ink-1)" : "var(--ink-4)" }}>
            {minutes !== null && minutes > 0 ? formatDuration(minutes) : "—"}
          </span>
        </div>

        <Field label={t.sentence} htmlFor={`${id}-label`}>
          <Input
            id={`${id}-label`}
            size="sm"
            value={label}
            placeholder={t.sentencePlaceholder}
            maxLength={300}
            disabled={disabled}
            autoFocus
            onChange={(event: { target: { value: string } }) => setLabel(event.target.value)}
          />
        </Field>

        <Field label={t.project} style={{ maxWidth: 320 }}>
          <Select aria-label={t.project} options={projects} value={project} disabled={disabled} onChange={(event: { target: { value: string } }) => setProject(event.target.value)} />
        </Field>

        {target.mode === "edit" ? (
          <Checkbox label={t.countActive} description={t.countActiveHint} checked={active} disabled={disabled} onChange={(checked: boolean) => setActive(checked)} />
        ) : (
          <span style={{ fontSize: 13, color: "var(--ink-3)", lineHeight: 1.5 }}>{t.addHint}</span>
        )}

        {error ? (
          <span role="alert" style={{ fontSize: 13, color: "var(--status-negative)" }}>
            {error}
          </span>
        ) : null}

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap", paddingTop: 2 }}>
          <div style={{ display: "flex", gap: 4 }}>
            {target.mode === "edit" ? (
              <>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={disabled}
                  loading={busy === "delete"}
                  onClick={() => void send("delete", { op: "remove", from: target.original.from, to: target.original.to })}
                  style={{ color: "var(--status-negative)", paddingLeft: 12, paddingRight: 12 }}
                >
                  {t.delete}
                </Button>
                {target.original.edited ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={disabled}
                    loading={busy === "undo"}
                    onClick={() => void send("undo", { op: "revert", from: target.original.from, to: target.original.to })}
                    style={{ paddingLeft: 12, paddingRight: 12 }}
                  >
                    {t.undo}
                  </Button>
                ) : null}
              </>
            ) : null}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={onCancel}>
              {t.cancel}
            </Button>
            <Button type="submit" variant="primary" size="sm" disabled={disabled} loading={busy === "save"}>
              {busy === "save" ? t.saving : t.save}
            </Button>
          </div>
        </div>
      </div>
    </form>
  );
}

/**
 * The instant a typed clock time means on `date`. Unchanged, it is the exact edge it came
 * from; an end of 00:00 is the midnight that closes the day.
 */
function resolveClock(date: string, value: string, original: string, isEnd: boolean): string | null {
  if (value === clock(original)) return original;
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const hours = Number(match[1]);
  const mins = Number(match[2]);
  const [y, m, d] = date.split("-").map(Number);
  const midnight = isEnd && hours === 0 && mins === 0;
  return new Date(y, m - 1, d + (midnight ? 1 : 0), hours, mins).toISOString();
}
