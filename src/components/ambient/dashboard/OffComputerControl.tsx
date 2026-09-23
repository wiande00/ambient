import { useEffect, useState } from "react";
import { Input } from "@/ui/Input";
import { Select } from "@/ui/Select";
import { Switch } from "@/ui/Switch";
import { clock } from "@/lib/ambient/format";
import { FALLBACK_BUCKETS } from "@/lib/ambient/projects";
import type { AmbientOffComputerResponse } from "@/lib/ambient/types";
import { en } from "@/i18n/en";
import { interpolate } from "@/i18n";

/**
 * The "working off computer" switch, on today's screen. Off: pick a project and say what,
 * then flick it on. On: it says since when and for which project, and flicking it off ends
 * the session. The day above and the chunks below re-measure right after either.
 *
 * It sits in the day's right-hand rail, beside the project totals it feeds — the one place
 * on the screen where time is entered rather than measured.
 */

const t = en.ambient.offComputer;
const bucketNames = en.ambient.projects.buckets;

type Loaded = Extract<AmbientOffComputerResponse, { status: "ready" }>;

export function OffComputerControl({ onChanged, refreshKey }: { onChanged: () => void; refreshKey: number }) {
  const [state, setState] = useState<Loaded | null>(null);
  const [project, setProject] = useState<string>("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-read on the dashboard's tick as well as on mount: the switch can be flicked from
  // the MCP connector, and the screen should show that within the minute.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/ambient/offcomputer")
      .then((res) => res.json())
      .then((next: AmbientOffComputerResponse) => {
        if (cancelled || next.status !== "ready") return;
        setState(next);
        // Default to the project of the last session, else the first project, else Other.
        const last = next.today[next.today.length - 1];
        setProject((current) => current || last?.project || next.projects[0]?.key || "other");
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  async function toggle(on: boolean) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/ambient/offcomputer", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(on ? { on, project, note } : { on }),
      });
      const next: AmbientOffComputerResponse = await res.json();
      if (next.status !== "ready") {
        setError(next.message);
        return;
      }
      setState(next);
      if (!on) setNote("");
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed.");
    } finally {
      setBusy(false);
    }
  }

  if (!state) return null;
  const active = state.active;
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
            }. ${t.onHint}`
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

      {error ? <span style={{ fontSize: 12, color: "var(--status-negative)" }}>{interpolate(t.failed, { message: error })}</span> : null}
    </section>
  );
}
