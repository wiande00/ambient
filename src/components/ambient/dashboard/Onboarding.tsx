import { useEffect, useState } from "react";
import { Button } from "@/ui/Button";
import { Input } from "@/ui/Input";
import { keyForName, type AmbientProject } from "@/lib/ambient/projects";
import type { AmbientProjectsResponse, AmbientSettingsResponse } from "@/lib/ambient/types";
import { en } from "@/i18n/en";
import { interpolate } from "@/i18n";

/**
 * The first-run walkthrough: three slides over the dashboard — the key, the projects, go.
 *
 * It opens on a fresh install only: when neither a key nor a project is set and it has not
 * been finished or skipped before. That flag lives in localStorage, so a person who already
 * has a key and projects never sees it, and one who skips it is not asked again. Each slide
 * saves through the same routes the Settings screen uses, and every step can be left empty;
 * Settings holds the full editors.
 */

const t = en.ambient.onboarding;
const KEY = "ambient.onboarded";

type Step = 0 | 1 | 2;

function markDone() {
  try {
    localStorage.setItem(KEY, "1");
  } catch {
    // Without storage the walkthrough may show again next launch, which is harmless.
  }
}

export function Onboarding({ onDone }: { onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>(0);
  const [hasKey, setHasKey] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [existing, setExisting] = useState<AmbientProject[]>([]);
  const [names, setNames] = useState<string[]>(["", ""]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    try {
      if (localStorage.getItem(KEY)) return;
    } catch {
      return;
    }
    let cancelled = false;
    Promise.all([
      fetch("/api/ambient/settings").then((res) => res.json() as Promise<AmbientSettingsResponse>),
      fetch("/api/ambient/projects").then((res) => res.json() as Promise<AmbientProjectsResponse>),
    ])
      .then(([settings, projects]) => {
        if (cancelled || settings.status !== "ready" || projects.status !== "ready") return;
        // Someone who already set Ambient up (before this existed) is not walked through it.
        if (settings.hasApiKey && projects.projects.length > 0) {
          markDone();
          return;
        }
        setHasKey(settings.hasApiKey);
        setExisting(projects.projects);
        setOpen(true);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") finish();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!open) return null;

  function finish() {
    markDone();
    setOpen(false);
    onDone();
  }

  async function saveKey() {
    if (!apiKey.trim()) return setStep(1);
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/ambient/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ anthropicApiKey: apiKey.trim() }),
      });
      const next: AmbientSettingsResponse = await res.json();
      if (next.status !== "ready") return setError(interpolate(t.failed, { message: next.message }));
      setHasKey(true);
      setApiKey("");
      await window.ambient?.applySettings();
      setStep(1);
    } catch (e) {
      setError(interpolate(t.failed, { message: e instanceof Error ? e.message : "Request failed." }));
    } finally {
      setBusy(false);
    }
  }

  async function saveProjects() {
    const fresh = names.map((name) => name.trim()).filter(Boolean);
    if (fresh.length === 0) return setStep(2);
    const taken = existing.map((project) => project.key);
    const added = fresh.map((name) => {
      const key = keyForName(name, taken);
      taken.push(key);
      return { key, name, description: "", hints: [] } satisfies AmbientProject;
    });
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/ambient/projects", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projects: [...existing, ...added] }),
      });
      const next: AmbientProjectsResponse = await res.json();
      if (next.status !== "ready") return setError(interpolate(t.failed, { message: next.message }));
      setExisting(next.projects);
      setNames(["", ""]);
      setStep(2);
    } catch (e) {
      setError(interpolate(t.failed, { message: e instanceof Error ? e.message : "Request failed." }));
    } finally {
      setBusy(false);
    }
  }

  const slide = t.slides[step];

  return (
    <div className="ambient-onboarding" role="dialog" aria-modal="true" aria-labelledby="onboarding-title">
      <div className="ambient-onboarding-card">
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
          <span className="ui-mono" style={{ fontSize: 10, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--ink-4)" }}>
            {interpolate(t.stepOf, { step: String(step + 1), total: "3" })}
          </span>
          <span style={{ flex: 1 }} />
          {step < 2 ? (
            <Button type="button" variant="ghost" size="sm" onClick={finish}>
              {t.skip}
            </Button>
          ) : null}
        </div>

        <div key={step} className="ambient-onboarding-slide">
          <span aria-hidden className="ambient-onboarding-number">
            {step + 1}
          </span>
          <h2 id="onboarding-title" className="ambient-onboarding-title">
            {slide.title}
          </h2>
          <p style={{ margin: 0, fontSize: "var(--text-body-md)", color: "var(--ink-3)", lineHeight: "var(--leading-body)" }}>{slide.body}</p>

          {step === 0 ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void saveKey();
              }}
              style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}
            >
              <Input
                type="password"
                autoComplete="off"
                spellCheck={false}
                autoFocus
                value={apiKey}
                placeholder={hasKey ? t.keySet : t.keyPlaceholder}
                onChange={(event) => setApiKey(event.target.value)}
              />
              <span style={{ fontSize: "var(--text-body-sm)", color: "var(--ink-4)" }}>
                {t.keyHint}{" "}
                <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer" style={{ color: "var(--text-link)" }}>
                  {t.keyLink}
                </a>
              </span>
            </form>
          ) : step === 1 ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void saveProjects();
              }}
              style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}
            >
              {existing.length > 0 ? (
                <span style={{ fontSize: "var(--text-body-sm)", color: "var(--ink-4)" }}>
                  {interpolate(t.already, { names: existing.map((project) => project.name).join(", ") })}
                </span>
              ) : null}
              {names.map((name, index) => (
                <Input
                  key={index}
                  autoFocus={index === 0}
                  value={name}
                  placeholder={t.projectPlaceholders[index % t.projectPlaceholders.length]}
                  onChange={(event) => setNames((current) => current.map((n, i) => (i === index ? event.target.value : n)))}
                />
              ))}
              <div>
                <Button type="button" variant="ghost" size="sm" iconLeft="plus" onClick={() => setNames((current) => [...current, ""])}>
                  {t.addAnother}
                </Button>
              </div>
              {/* Lets Enter submit the form even though the visible buttons sit outside it. */}
              <button type="submit" hidden />
            </form>
          ) : (
            <div className="ambient-onboarding-tip">
              <span className="ui-mono" style={{ fontSize: 10, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--text-accent)" }}>
                {t.tipLabel}
              </span>
              <span style={{ fontSize: "var(--text-body-sm)", color: "var(--ink-2)", lineHeight: "var(--leading-body)" }}>{t.tip}</span>
            </div>
          )}

          {error ? <span style={{ fontSize: "var(--text-body-sm)", color: "var(--alert-3)" }}>{error}</span> : null}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
          <div style={{ display: "flex", gap: 6 }} aria-hidden>
            {[0, 1, 2].map((i) => (
              <span key={i} className="ambient-onboarding-dot" data-active={i === step || undefined} />
            ))}
          </div>
          <span style={{ flex: 1 }} />
          {step > 0 ? (
            <Button type="button" variant="outline" disabled={busy} onClick={() => setStep((step - 1) as Step)}>
              {t.back}
            </Button>
          ) : null}
          {step === 0 ? (
            <Button type="button" variant="primary" iconRight="chevron-right" disabled={busy} loading={busy} onClick={() => void saveKey()}>
              {apiKey.trim() ? t.saveNext : t.next}
            </Button>
          ) : step === 1 ? (
            <Button type="button" variant="primary" iconRight="chevron-right" disabled={busy} loading={busy} onClick={() => void saveProjects()}>
              {names.some((name) => name.trim()) ? t.saveNext : t.next}
            </Button>
          ) : (
            <Button type="button" variant="accent" onClick={finish}>
              {t.start}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
