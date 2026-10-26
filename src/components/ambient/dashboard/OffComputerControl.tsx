import { useEffect, useState } from "react";
import { Input } from "@/ui/Input";
import { Select } from "@/ui/Select";
import { Switch } from "@/ui/Switch";
import { clock } from "@/lib/ambient/format";
import { nextClockTime } from "@/lib/ambient/offComputer";
import { FALLBACK_BUCKETS } from "@/lib/ambient/projects";
import type { AmbientOffComputerResponse } from "@/lib/ambient/types";
import { en } from "@/i18n/en";
import { interpolate } from "@/i18n";

/**
 * The "working off computer" switch, on today's screen. Off: pick a project, say what, and
 * optionally when it should stop on its own, then flick it on. On: it says since when, for
 * which project and until when, the stop time can still be set, changed or cleared, and
 * flicking it off ends the session. The day above and the chunks below re-measure right
 * after any of these.
 *
 * It sits in the day's right-hand rail, beside the project totals it feeds — the one place
 * on the screen where time is entered rather than measured.
 */

const t = en.ambient.offComputer;
const bucketNames = en.ambient.projects.buckets;

type Loaded = Extract<AmbientOffComputerResponse, { status: "ready" }>;

/** "Stops on its own at 17:00.", or "...tomorrow at..." when that is past midnight from `nowMs`. */
function stopsLine(untilMs: number, nowMs: number): string {
  const tomorrow = new Date(untilMs).toDateString() !== new Date(nowMs).toDateString();
  return interpolate(tomorrow ? t.stopsTomorrowAt : t.stopsAt, { time: clock(untilMs) });
}

export function OffComputerControl({ onChanged, refreshKey }: { onChanged: () => void; refreshKey: number }) {
  const [state, setState] = useState<Loaded | null>(null);
  const [project, setProject] = useState<string>("");
  const [note, setNote] = useState("");
  /** The stop-at field, "HH:MM" or empty. While a session runs it shows that session's stop time. */
  const [stopAt, setStopAt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** When the switch last heard from the server: the "now" the screen is drawn against. */
  const [nowMs, setNowMs] = useState(0);

  // The field follows the running session's stop time, but only when that changes: the
  // re-read every minute must not undo a time being typed. When a session ends, on its own
  // or by hand, the field empties, so the next one does not inherit a stop time.
  const running = state?.active ?? null;
  const runningKey = running ? `${running.id}|${running.until ?? ""}` : null;
  const [shownKey, setShownKey] = useState<string | null>(null);
  if (runningKey !== shownKey) {
    setShownKey(runningKey);
    setStopAt(running?.until ? clock(running.until) : "");
  }

  // Re-read on the dashboard's tick as well as on mount: the switch can be flicked from
  // the MCP connector, and the screen should show that within the minute.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/ambient/offcomputer")
      .then((res) => res.json())
      .then((next: AmbientOffComputerResponse) => {
        if (cancelled || next.status !== "ready") return;
        setState(next);
        setNowMs(Date.now());
        // Default to the project of the last session, else the first project, else Other.
        const last = next.today[next.today.length - 1];
        setProject((current) => current || last?.project || next.projects[0]?.key || "other");
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  async function send(body: object): Promise<Loaded | null> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/ambient/offcomputer", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const next: AmbientOffComputerResponse = await res.json();
      if (next.status !== "ready") {
        setError(next.message);
        return null;
      }
      setState(next);
      setNowMs(Date.now());
      onChanged();
      return next;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed.");
      return null;
    } finally {
      setBusy(false);
    }
  }

  // The next time the clock reads the field's time, later today or else tomorrow.
  const untilFor = (value: string) => nextClockTime(value, Date.now());

  async function toggle(on: boolean) {
    if (!on) {
      if (await send({ on })) setNote("");
      return;
    }
    const untilMs = untilFor(stopAt);
    await send({ on, project, note, ...(untilMs !== null ? { until: new Date(untilMs).toISOString() } : {}) });
  }

  // While a session runs, a changed stop time is saved when the field is left.
  async function saveStopAt() {
    const active = state?.active;
    if (!active || stopAt === (active.until ? clock(active.until) : "")) return;
    const untilMs = untilFor(stopAt);
    await send({ until: untilMs === null ? null : new Date(untilMs).toISOString() });
  }

  if (!state) return null;
  const active = state.active;
  // Before it starts, say when the time typed would stop it; once on, the line above does.
  const plannedUntil = active ? null : nextClockTime(stopAt, nowMs);
  const names: Record<string, string> = { ...Object.fromEntries(state.projects.map((p) => [p.key, p.name])), ...bucketNames };
  const options = [
    ...state.projects.map((p) => ({ value: p.key, label: p.name })),
    ...FALLBACK_BUCKETS.map((key) => ({ value: key, label: bucketNames[key] })),
  ];

  return (
    <section
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 12,
        padding: 18,
        border: "1px solid var(--border-soft)",
        borderRadius: 18,
        background: "var(--panel-2)",
      }}
    >
      <Switch
        checked={active !== null}
        disabled={busy}
        onChange={(checked: boolean) => void toggle(checked)}
        label={<span style={{ fontSize: 14, fontWeight: 700 }}>{t.label}</span>}
        style={{ gap: 11 }}
      />

      <span style={{ fontSize: 12, color: "var(--ink-3)", lineHeight: 1.5 }}>
        {active
          ? `${interpolate(t.since, { time: clock(active.from), project: names[active.project] ?? active.project })}${
              active.note ? ` · ${active.note}` : ""
            }. ${active.until ? stopsLine(Date.parse(active.until), nowMs) : t.onHint}`
          : t.hint}
      </span>

      {!active ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <Select
            aria-label={t.project}
            options={options}
            value={project}
            disabled={busy}
            onChange={(event: { target: { value: string } }) => setProject(event.target.value)}
          />
          <Input
            aria-label={t.note}
            placeholder={t.notePlaceholder}
            value={note}
            disabled={busy}
            onChange={(event: { target: { value: string } }) => setNote(event.target.value)}
          />
        </div>
      ) : null}

      <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12, color: "var(--ink-3)" }}>
        {t.stopAt}
        <Input
          type="time"
          value={stopAt}
          disabled={busy}
          onChange={(event: { target: { value: string } }) => setStopAt(event.target.value)}
          onBlur={() => void saveStopAt()}
          onKeyDown={(event: { key: string }) => {
            if (event.key === "Enter") void saveStopAt();
          }}
        />
        {plannedUntil !== null ? <span>{stopsLine(plannedUntil, nowMs)}</span> : null}
      </label>

      {error ? <span style={{ fontSize: 12, color: "var(--status-negative)" }}>{interpolate(t.failed, { message: error })}</span> : null}
    </section>
  );
}
