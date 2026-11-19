import { useId, useState, type KeyboardEvent } from "react";
import { Button } from "@/ui/Button";
import { Checkbox } from "@/ui/Checkbox";
import { Field } from "@/ui/Field";
import { Icon } from "@/ui/Icon";
import { Input } from "@/ui/Input";
import { Select } from "@/ui/Select";
import type { AddOn } from "@/lib/ambient/edits";
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
 * Under the project go the add-ons: a few minutes of the stretch that went to another
 * project, with no time of their own — "and ten minutes on the course" — so a mostly-one-
 * thing stretch need not be cut in two to say so. They come out of the stretch's own
 * project; the form keeps that project holding the most.
 *
 * Times are typed as clock minutes, but a stretch's real edges are to the second. An
 * untouched time is sent as the exact edge it came from, and the server takes a typed one
 * within a minute of a real edge to mean that edge, so neither leaves a sliver behind.
 */

const t = en.ambient.edit;

export type EditorDraft = { from: string; to: string; project: string; label: string; active: boolean; addOns: AddOn[] };

/** One add-on as typed: the minutes stay text until saved, so a half-typed number is not fought over. */
type AddOnRow = { key: number; project: string; minutes: string };

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
  const [addOns, setAddOns] = useState<AddOnRow[]>(() => initial.addOns.map((addOn, i) => ({ key: i, project: addOn.project, minutes: String(addOn.minutes) })));
  const [nextKey, setNextKey] = useState(initial.addOns.length);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);

  const from = resolveClock(date, fromClock, initial.from, false);
  const to = resolveClock(date, toClock, initial.to, true);
  const minutes = from && to ? (Date.parse(to) - Date.parse(from)) / 60_000 : null;
  const projectName = projects.find((option) => option.value === project)?.label ?? project;

  function addAddOn() {
    // The first project not already in the stretch, so a new row starts somewhere useful.
    const taken = new Set([project, ...addOns.map((row) => row.project)]);
    const next = projects.find((option) => !taken.has(option.value)) ?? projects.find((option) => option.value !== project);
    setAddOns([...addOns, { key: nextKey, project: next?.value ?? "other", minutes: "" }]);
    setNextKey(nextKey + 1);
  }

  function updateAddOn(key: number, change: Partial<Omit<AddOnRow, "key">>) {
    setAddOns(addOns.map((row) => (row.key === key ? { ...row, ...change } : row)));
  }

  /** The add-ons ready to send, or the reason they are not. */
  function checkedAddOns(stretchMinutes: number): AddOn[] | string {
    const parsed = addOns.map((row) => ({ project: row.project, minutes: Number(row.minutes.replace(",", ".")) }));
    if (parsed.some((addOn) => !Number.isFinite(addOn.minutes) || addOn.minutes < 1)) return t.addOnMinutesInvalid;
    if (parsed.some((addOn) => addOn.project === project)) return t.addOnSameProject;
    const byProject = new Map<string, number>();
    for (const addOn of parsed) byProject.set(addOn.project, (byProject.get(addOn.project) ?? 0) + addOn.minutes);
    const total = parsed.reduce((sum, addOn) => sum + addOn.minutes, 0);
    if ([...byProject.values()].some((each) => each > stretchMinutes - total)) return interpolate(t.addOnTooMuch, { project: projectName });
    return [...byProject].map(([key, each]) => ({ project: key, minutes: each }));
  }

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
    const extra = checkedAddOns(minutes);
    if (typeof extra === "string") {
      setError(extra);
      return;
    }
    void send("save", {
      op: "label",
      from,
      to,
      project,
      label: label.trim(),
      active: target.mode === "add" ? true : active,
      addOns: extra,
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

        <div role="group" aria-label={t.addOnsHeading} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {addOns.length > 0 ? (
            <>
              <span style={{ fontFamily: "var(--font-sans)", fontSize: "var(--text-body-sm)", fontWeight: "var(--weight-semibold)", color: "var(--ink-2)" }}>{t.addOnsHeading}</span>
              {addOns.map((row, index) => (
                <div key={row.key} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: 999, background: fillFor(row.project), flex: "0 0 auto" }} />
                  <Select
                    aria-label={t.addOnProject}
                    options={projects}
                    value={row.project}
                    disabled={disabled}
                    onChange={(event: { target: { value: string } }) => updateAddOn(row.key, { project: event.target.value })}
                    style={{ flex: "1 1 auto", maxWidth: 296, minWidth: 0 }}
                  />
                  <Input
                    type="number"
                    size="sm"
                    min={1}
                    step={1}
                    inputMode="numeric"
                    aria-label={t.addOnMinutes}
                    placeholder="10"
                    value={row.minutes}
                    disabled={disabled}
                    autoFocus={index === addOns.length - 1 && row.minutes === ""}
                    onChange={(event: { target: { value: string } }) => updateAddOn(row.key, { minutes: event.target.value })}
                    style={{ width: 96, flex: "0 0 auto" }}
                  />
                  <span style={{ fontSize: 13, color: "var(--ink-3)" }}>min</span>
                  <button
                    type="button"
                    aria-label={t.addOnRemove}
                    title={t.addOnRemove}
                    disabled={disabled}
                    onClick={() => setAddOns(addOns.filter((other) => other.key !== row.key))}
                    className="ambient-row-action ambient-row-action-on"
                    style={{ width: 28, height: 28 }}
                  >
                    <Icon name="x" size={14} />
                  </button>
                </div>
              ))}
              <span style={{ fontSize: 13, color: "var(--ink-3)", lineHeight: 1.5 }}>{interpolate(t.addOnsHint, { project: projectName })}</span>
            </>
          ) : null}
          <button type="button" onClick={addAddOn} disabled={disabled} className="ambient-add-on-add" style={{ alignSelf: "flex-start" }}>
            <Icon name="plus" size={13} />
            {t.addOnAdd}
          </button>
        </div>

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
