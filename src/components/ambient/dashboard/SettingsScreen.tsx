import { useEffect, useState } from "react";
import { Button } from "@/ui/Button";
import { Field } from "@/ui/Field";
import { Input } from "@/ui/Input";
import { Switch } from "@/ui/Switch";
import { AFK_MAX_S, AFK_MIN_S, BREAK_MAX_M, BREAK_MIN_M } from "@/lib/ambient/config";
import { clock } from "@/lib/ambient/format";
import type { AmbientSettingsResponse } from "@/lib/ambient/types";
import type { AmbientConnectorInfo, AmbientDesktopStatus } from "@/types/ambient-bridge";
import { en } from "@/i18n/en";
import { interpolate } from "@/i18n";
import { ProjectsSettings } from "./ProjectsSettings";
import { useDesktopStatus } from "./useDesktop";

/**
 * The key, the idle rule, how long an absence has to be to be a break, autostart, and what
 * the collector may not read. Saving writes
 * `~/.ambient/config.json` through the settings route, then asks the desktop shell (when
 * there is one) to apply the parts only it can: the Windows login item and the collector's
 * arguments. In a browser the shell-only controls are shown disabled and say why.
 */

const t = en.ambient.settings;

type Loaded = Extract<AmbientSettingsResponse, { status: "ready" }>;
type SaveState = { kind: "idle" } | { kind: "saving" } | { kind: "saved" } | { kind: "failed"; message: string };

export function SettingsScreen() {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [afk, setAfk] = useState("");
  const [breakAfter, setBreakAfter] = useState("");
  const [openAtLogin, setOpenAtLogin] = useState(true);
  const [excludeApps, setExcludeApps] = useState("");
  const [save, setSave] = useState<SaveState>({ kind: "idle" });
  const { desktop, status, setStatus } = useDesktopStatus();

  useEffect(() => {
    let cancelled = false;
    fetch("/api/ambient/settings")
      .then((res) => res.json())
      .then((next: AmbientSettingsResponse) => {
        if (cancelled) return;
        if (next.status === "ready") {
          setLoaded(next);
          setAfk(String(next.afkSeconds));
          setBreakAfter(String(next.breakMinutes));
          setOpenAtLogin(next.openAtLogin);
          setExcludeApps(next.excludeApps.join(", "));
        } else {
          setLoadError(next.message);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : "Request failed.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const afkNumber = Number(afk);
  const afkValid = afk.trim() !== "" && Number.isInteger(afkNumber) && afkNumber >= AFK_MIN_S && afkNumber <= AFK_MAX_S;
  const breakNumber = Number(breakAfter);
  const breakValid = breakAfter.trim() !== "" && Number.isInteger(breakNumber) && breakNumber >= BREAK_MIN_M && breakNumber <= BREAK_MAX_M;

  async function onSave() {
    if (!afkValid || !breakValid) return;
    setSave({ kind: "saving" });
    const body: Record<string, unknown> = { afkSeconds: afkNumber, breakMinutes: breakNumber, openAtLogin, excludeApps };
    if (clearKey) body.anthropicApiKey = "";
    else if (apiKey.trim()) body.anthropicApiKey = apiKey.trim();
    try {
      const res = await fetch("/api/ambient/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const next: AmbientSettingsResponse = await res.json();
      if (next.status !== "ready") {
        setSave({ kind: "failed", message: next.message });
        return;
      }
      setLoaded(next);
      setApiKey("");
      setClearKey(false);
      setExcludeApps(next.excludeApps.join(", "));
      const applied = await window.ambient?.applySettings();
      if (applied) setStatus(applied);
      setSave({ kind: "saved" });
    } catch (error) {
      setSave({ kind: "failed", message: error instanceof Error ? error.message : "Request failed." });
    }
  }

  async function onCheckForUpdates() {
    const next = await window.ambient?.checkForUpdates();
    if (next) setStatus(next);
  }

  async function onRestartCollector() {
    const next = await window.ambient?.restartCollector();
    if (next) setStatus(next);
  }

  const keyHint = !loaded
    ? ""
    : clearKey
      ? t.apiKey.hintUnset
      : loaded.apiKeySource === "config"
        ? interpolate(t.apiKey.hintSet, { masked: loaded.apiKeyMasked })
        : loaded.apiKeySource === "env"
          ? t.apiKey.hintEnv
          : t.apiKey.hintUnset;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-6)", maxWidth: 640 }}>
      <header style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
        <h1
          style={{
            margin: 0,
            fontFamily: "var(--font-display)",
            fontWeight: "var(--weight-black)",
            fontStretch: "90%",
            letterSpacing: "var(--tracking-display)",
            fontSize: "var(--text-h3)",
            lineHeight: "var(--leading-display)",
          }}
        >
          {t.title}
        </h1>
        {loaded ? (
          <span style={{ fontSize: "var(--text-body-sm)", color: "var(--ink-3)" }}>{interpolate(t.storedAt, { path: loaded.configPath })}</span>
        ) : null}
      </header>

      {loadError ? (
        <span style={{ fontSize: "var(--text-body-sm)", color: "var(--alert-3)" }}>{loadError}</span>
      ) : !loaded ? (
        <span style={{ fontSize: "var(--text-body-sm)", color: "var(--ink-3)" }}>{t.loading}</span>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void onSave();
          }}
          style={{ display: "flex", flexDirection: "column", gap: "var(--space-6)" }}
        >
          <Field label={t.apiKey.label} hint={keyHint} htmlFor="settings-api-key">
            <div style={{ display: "flex", gap: "var(--space-3)", alignItems: "center" }}>
              <Input
                id="settings-api-key"
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={apiKey}
                placeholder={loaded.hasApiKey && !clearKey ? loaded.apiKeyMasked : t.apiKey.placeholder}
                disabled={clearKey}
                onChange={(event) => setApiKey(event.target.value)}
                style={{ flex: 1 }}
              />
              {loaded.apiKeySource === "config" ? (
                <Button type="button" variant="ghost" size="sm" onClick={() => setClearKey((value) => !value)}>
                  {clearKey ? t.apiKey.keep : t.apiKey.clear}
                </Button>
              ) : null}
            </div>
          </Field>

          <Field
            label={t.afk.label}
            hint={t.afk.hint}
            error={afkValid ? undefined : interpolate(t.afk.invalid, { min: String(AFK_MIN_S), max: String(AFK_MAX_S) })}
            htmlFor="settings-afk"
          >
            <div style={{ display: "flex", gap: "var(--space-3)", alignItems: "center" }}>
              <Input
                id="settings-afk"
                type="number"
                inputMode="numeric"
                min={AFK_MIN_S}
                max={AFK_MAX_S}
                step={1}
                value={afk}
                invalid={!afkValid}
                onChange={(event) => setAfk(event.target.value)}
                style={{ width: 160 }}
              />
              <span style={{ fontSize: "var(--text-body-sm)", color: "var(--ink-3)" }}>{t.afk.unit}</span>
            </div>
          </Field>

          <Field
            label={t.breakAfter.label}
            hint={t.breakAfter.hint}
            error={breakValid ? undefined : interpolate(t.breakAfter.invalid, { min: String(BREAK_MIN_M), max: String(BREAK_MAX_M) })}
            htmlFor="settings-break"
          >
            <div style={{ display: "flex", gap: "var(--space-3)", alignItems: "center" }}>
              <Input
                id="settings-break"
                type="number"
                inputMode="numeric"
                min={BREAK_MIN_M}
                max={BREAK_MAX_M}
                step={1}
                value={breakAfter}
                invalid={!breakValid}
                onChange={(event) => setBreakAfter(event.target.value)}
                style={{ width: 160 }}
              />
              <span style={{ fontSize: "var(--text-body-sm)", color: "var(--ink-3)" }}>{t.breakAfter.unit}</span>
            </div>
          </Field>

          <Field
            label={t.openAtLogin.label}
            hint={!desktop ? t.openAtLogin.desktopOnly : status && status.openAtLogin && !status.willLaunchAtLogin ? t.openAtLogin.overridden : t.openAtLogin.hint}
          >
            <Switch checked={openAtLogin} disabled={!desktop} onChange={setOpenAtLogin} />
          </Field>

          <Field label={t.excludeApps.label} hint={t.excludeApps.hint} htmlFor="settings-exclude">
            <Input id="settings-exclude" value={excludeApps} spellCheck={false} onChange={(event) => setExcludeApps(event.target.value)} />
          </Field>

          {desktop && status ? (
            <Field label={t.update.label} hint={interpolate(t.update.channel, { dir: status.update.channel })}>
              <div style={{ display: "flex", gap: "var(--space-3)", alignItems: "center", flexWrap: "wrap" }}>
                <span style={{ fontSize: "var(--text-body-md)", color: "var(--ink-1)" }}>{interpolate(t.update.current, { current: status.update.current })}</span>
                <span style={{ fontSize: "var(--text-body-sm)", color: status.update.state === "error" ? "var(--alert-3)" : "var(--ink-3)" }}>{updateLine(status)}</span>
                {status.update.state === "ready" ? (
                  <Button type="button" variant="primary" size="sm" onClick={() => void window.ambient?.installUpdate()}>
                    {interpolate(t.update.install, { version: status.update.version })}
                  </Button>
                ) : (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={status.update.state === "checking" || status.update.state === "installing"}
                    onClick={() => void onCheckForUpdates()}
                  >
                    {t.update.check}
                  </Button>
                )}
              </div>
            </Field>
          ) : null}

          {desktop ? <ConnectorField /> : null}

          {desktop ? (
            <Field label={t.collector.label} hint={status ? interpolate(t.collector.logs, { dir: status.logsDir }) : undefined}>
              <div style={{ display: "flex", gap: "var(--space-3)", alignItems: "center", flexWrap: "wrap" }}>
                <span style={{ fontSize: "var(--text-body-md)", color: "var(--ink-1)" }}>{status ? collectorLine(status) : "…"}</span>
                <Button type="button" variant="outline" size="sm" onClick={() => void onRestartCollector()}>
                  {t.collector.restart}
                </Button>
              </div>
            </Field>
          ) : null}

          <div style={{ display: "flex", gap: "var(--space-4)", alignItems: "center" }}>
            <Button type="submit" variant="primary" disabled={!afkValid || !breakValid || save.kind === "saving"} loading={save.kind === "saving"}>
              {save.kind === "saving" ? t.saving : t.save}
            </Button>
            {save.kind === "saved" ? (
              <span style={{ fontSize: "var(--text-body-sm)", color: "var(--ink-3)" }}>{t.saved}</span>
            ) : save.kind === "failed" ? (
              <span style={{ fontSize: "var(--text-body-sm)", color: "var(--alert-3)" }}>{interpolate(t.failed, { message: save.message })}</span>
            ) : null}
          </div>
        </form>
      )}

      <ProjectsSettings />
    </div>
  );
}

/** The MCP connector: its state in Claude Desktop, a button to add it, and the line for Claude Code. */
function ConnectorField() {
  const [info, setInfo] = useState<AmbientConnectorInfo | null>(null);
  const [state, setState] = useState<{ kind: "idle" } | { kind: "busy" } | { kind: "failed"; message: string }>({ kind: "idle" });

  useEffect(() => {
    window.ambient?.getConnector().then(setInfo, () => undefined);
  }, []);

  async function onInstall() {
    setState({ kind: "busy" });
    try {
      setInfo((await window.ambient?.installClaudeDesktop()) ?? null);
      setState({ kind: "idle" });
    } catch (error) {
      setState({ kind: "failed", message: error instanceof Error ? error.message : "Request failed." });
    }
  }

  return (
    <Field label={t.connector.label} hint={t.connector.hint}>
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
        <div style={{ display: "flex", gap: "var(--space-3)", alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ fontSize: "var(--text-body-md)", color: info?.claudeDesktop === "unreadable" ? "var(--alert-3)" : "var(--ink-1)" }}>
            {info ? t.connector.desktop[info.claudeDesktop] : "…"}
          </span>
          {info && info.claudeDesktop !== "current" && info.claudeDesktop !== "waiting" && info.claudeDesktop !== "not-installed" ? (
            <Button type="button" variant="outline" size="sm" disabled={state.kind === "busy"} onClick={() => void onInstall()}>
              {state.kind === "busy" ? t.connector.installing : t.connector.install}
            </Button>
          ) : null}
          {state.kind === "failed" ? (
            <span style={{ fontSize: "var(--text-body-sm)", color: "var(--alert-3)" }}>{interpolate(t.connector.failed, { message: state.message })}</span>
          ) : null}
        </div>
        {info ? (
          <>
            <span style={{ fontSize: "var(--text-body-sm)", color: "var(--ink-3)" }}>{t.connector.codeHint}</span>
            <code
              className="ui-mono"
              style={{
                display: "block",
                padding: "var(--space-3)",
                borderRadius: "var(--radius-sm)",
                background: "var(--paper-2)",
                fontSize: "var(--text-caption)",
                whiteSpace: "pre-wrap",
                wordBreak: "break-all",
                userSelect: "all",
              }}
            >
              {info.claudeCodeCommand}
            </code>
          </>
        ) : null}
      </div>
    </Field>
  );
}

function updateLine(status: AmbientDesktopStatus): string {
  const u = status.update;
  switch (u.state) {
    case "checking":
      return t.update.checking;
    case "up-to-date":
      return u.checkedAt ? interpolate(t.update.upToDate, { time: clock(u.checkedAt) }) : t.update.notChecked;
    case "ready":
      return interpolate(t.update.ready, { version: u.version });
    case "installing":
      return interpolate(t.update.installing, { version: u.version });
    case "error":
      return interpolate(t.update.error, { message: u.message });
    default:
      return t.update.notChecked;
  }
}

function collectorLine(status: AmbientDesktopStatus): string {
  const c = status.collector;
  switch (c.state) {
    case "running":
      return interpolate(t.collector.running, { pid: String(c.pid), since: clock(c.since) });
    case "restarting":
      return interpolate(t.collector.restarting, { seconds: String(c.inSeconds), attempt: String(c.attempt) });
    case "disabled":
      return t.collector.disabled;
    default:
      return t.collector.stopped;
  }
}
