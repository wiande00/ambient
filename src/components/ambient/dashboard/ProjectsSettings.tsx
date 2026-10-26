import { useEffect, useState } from "react";
import { Button } from "@/ui/Button";
import { Card } from "@/ui/Card";
import { Field } from "@/ui/Field";
import { Input } from "@/ui/Input";
import { Textarea } from "@/ui/Textarea";
import { keyForName, PROJECT_COLORS, projectColors, type AmbientProject, type ProjectColor } from "@/lib/ambient/projects";
import type { AmbientProjectsResponse } from "@/lib/ambient/types";
import { en } from "@/i18n/en";
import { interpolate } from "@/i18n";
import { colorFill } from "./palette";

/**
 * The projects editor on the Settings screen: the list `~/.ambient/projects.json` holds,
 * each with a name, a description and hints for the model and a colour for the screen,
 * plus add and remove. Keys are derived from the name when a project is created and never
 * change afterwards, since they are what every cached chunk refers to. Saving writes the
 * whole list through the projects route, which validates it the same way the reader does.
 */

const t = en.ambient.settings.projects;

/** `color` null is Auto: the project takes a colour by its place in the list. */
type Draft = { key: string; name: string; description: string; hints: string; color: ProjectColor | null; isNew: boolean };
type SaveState = { kind: "idle" } | { kind: "saving" } | { kind: "saved" } | { kind: "failed"; message: string };

function toDraft(project: AmbientProject): Draft {
  return {
    key: project.key,
    name: project.name,
    description: project.description,
    hints: project.hints.join(", "),
    color: project.color ?? null,
    isNew: false,
  };
}

function toProject(draft: Draft): AmbientProject {
  return {
    key: draft.key,
    name: draft.name.trim(),
    description: draft.description.trim(),
    hints: draft.hints
      .split(",")
      .map((hint) => hint.trim())
      .filter(Boolean),
    ...(draft.color ? { color: draft.color } : {}),
  };
}

export function ProjectsSettings() {
  const [drafts, setDrafts] = useState<Draft[] | null>(null);
  const [path, setPath] = useState("");
  const [fileError, setFileError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [save, setSave] = useState<SaveState>({ kind: "idle" });

  useEffect(() => {
    let cancelled = false;
    fetch("/api/ambient/projects")
      .then((res) => res.json())
      .then((next: AmbientProjectsResponse) => {
        if (cancelled) return;
        if (next.status === "ready") {
          setDrafts(next.projects.map(toDraft));
          setPath(next.path);
          setFileError(next.error);
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

  const missingName = drafts?.some((draft) => draft.name.trim() === "") ?? false;
  // What each project shows as, picked or automatic, live as the list is edited.
  const shown = projectColors(drafts?.map(toProject) ?? []);
  // What a project would get on Auto, which moves when another project picks its colour.
  const autoColor = (index: number) =>
    drafts ? projectColors(drafts.map((draft, i) => toProject(i === index ? { ...draft, color: null } : draft)))[drafts[index].key] : undefined;

  function update(index: number, patch: Partial<Draft>) {
    setDrafts((current) => {
      if (!current) return current;
      const next = current.map((draft, i) => (i === index ? { ...draft, ...patch } : draft));
      // A new project's key follows its name until it is saved; a saved one keeps its key.
      const draft = next[index];
      if (draft.isNew && patch.name !== undefined) {
        next[index] = { ...draft, key: keyForName(draft.name, next.filter((_, i) => i !== index).map((d) => d.key)) };
      }
      return next;
    });
    setSave({ kind: "idle" });
  }

  function add() {
    setDrafts((current) => {
      const list = current ?? [];
      return [...list, { key: keyForName("", list.map((d) => d.key)), name: "", description: "", hints: "", color: null, isNew: true }];
    });
    setSave({ kind: "idle" });
  }

  function remove(index: number) {
    setDrafts((current) => current?.filter((_, i) => i !== index) ?? current);
    setSave({ kind: "idle" });
  }

  async function onSave() {
    if (!drafts || missingName) return;
    setSave({ kind: "saving" });
    try {
      const res = await fetch("/api/ambient/projects", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projects: drafts.map(toProject) }),
      });
      const next: AmbientProjectsResponse = await res.json();
      if (next.status !== "ready") {
        setSave({ kind: "failed", message: next.message });
        return;
      }
      setDrafts(next.projects.map(toDraft));
      setFileError(next.error);
      setSave({ kind: "saved" });
    } catch (error) {
      setSave({ kind: "failed", message: error instanceof Error ? error.message : "Request failed." });
    }
  }

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: "var(--space-5)" }}>
      <header style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
        <h2
          style={{
            margin: 0,
            fontFamily: "var(--font-display)",
            fontWeight: "var(--weight-black)",
            fontStretch: "90%",
            letterSpacing: "var(--tracking-display)",
            fontSize: "var(--text-h4)",
            lineHeight: "var(--leading-display)",
          }}
        >
          {t.title}
        </h2>
        <span style={{ fontSize: "var(--text-body-sm)", color: "var(--ink-3)", lineHeight: "var(--leading-body)" }}>{t.intro}</span>
        {path ? <span style={{ fontSize: "var(--text-body-sm)", color: "var(--ink-3)" }}>{interpolate(t.storedAt, { path })}</span> : null}
      </header>

      {loadError ? (
        <span style={{ fontSize: "var(--text-body-sm)", color: "var(--alert-3)" }}>{loadError}</span>
      ) : !drafts ? (
        <span style={{ fontSize: "var(--text-body-sm)", color: "var(--ink-3)" }}>{t.loading}</span>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void onSave();
          }}
          style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}
        >
          {fileError ? (
            <span style={{ fontSize: "var(--text-body-sm)", color: "var(--alert-3)" }}>{interpolate(t.fileError, { message: fileError })}</span>
          ) : null}

          {drafts.length === 0 ? <span style={{ fontSize: "var(--text-body-sm)", color: "var(--ink-3)" }}>{t.empty}</span> : null}

          {drafts.map((draft, index) => (
            <Card key={draft.key} style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
              <Field
                label={t.name}
                hint={interpolate(t.key, { key: draft.key })}
                error={draft.name.trim() === "" ? t.nameRequired : undefined}
                htmlFor={`project-name-${draft.key}`}
              >
                <div style={{ display: "flex", gap: "var(--space-3)", alignItems: "center" }}>
                  <Input
                    id={`project-name-${draft.key}`}
                    value={draft.name}
                    placeholder={t.namePlaceholder}
                    invalid={draft.name.trim() === ""}
                    onChange={(event) => update(index, { name: event.target.value })}
                    style={{ flex: 1 }}
                  />
                  <Button type="button" variant="ghost" size="sm" onClick={() => remove(index)}>
                    {t.remove}
                  </Button>
                </div>
              </Field>
              <Field label={t.description} htmlFor={`project-description-${draft.key}`}>
                <Textarea
                  id={`project-description-${draft.key}`}
                  rows={2}
                  value={draft.description}
                  placeholder={t.descriptionPlaceholder}
                  onChange={(event) => update(index, { description: event.target.value })}
                />
              </Field>
              <Field label={t.hints} hint={t.hintsHint} htmlFor={`project-hints-${draft.key}`}>
                <Input id={`project-hints-${draft.key}`} value={draft.hints} spellCheck={false} onChange={(event) => update(index, { hints: event.target.value })} />
              </Field>
              <Field label={t.color} hint={t.colorHint}>
                <ColorPicker
                  color={draft.color}
                  auto={autoColor(index)}
                  usedBy={(color) =>
                    drafts.filter((other) => other.key !== draft.key && shown[other.key] === color).map((other) => other.name.trim() || other.key)
                  }
                  onChange={(color) => update(index, { color })}
                />
              </Field>
            </Card>
          ))}

          <div style={{ display: "flex", gap: "var(--space-4)", alignItems: "center", flexWrap: "wrap" }}>
            <Button type="button" variant="outline" onClick={add}>
              {t.add}
            </Button>
            <Button type="submit" variant="primary" disabled={missingName || save.kind === "saving"} loading={save.kind === "saving"}>
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
    </section>
  );
}

/**
 * Auto, then a swatch per colour. Auto's dot is the colour the project gets when nothing is
 * picked, so leaving it there still says what the project will look like. A swatch another
 * project already shows says so on hover; picking it anyway is allowed.
 */
function ColorPicker({
  color,
  auto,
  usedBy,
  onChange,
}: {
  color: ProjectColor | null;
  auto: ProjectColor | undefined;
  usedBy: (color: ProjectColor) => string[];
  onChange: (color: ProjectColor | null) => void;
}) {
  return (
    <div role="radiogroup" aria-label={t.color} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10, padding: "2px 0" }}>
      <button
        type="button"
        role="radio"
        aria-checked={color === null}
        className="ambient-swatch-auto"
        title={auto ? interpolate(t.colorAutoTitle, { color: t.colors[auto] }) : undefined}
        onClick={() => onChange(null)}
      >
        <span aria-hidden style={{ width: 14, height: 14, borderRadius: 999, background: auto ? colorFill(auto) : "var(--paper-3)" }} />
        {t.colorAuto}
      </button>
      {PROJECT_COLORS.map((option) => {
        const others = usedBy(option);
        const label = others.length > 0 ? `${t.colors[option]} · ${interpolate(t.colorUsedBy, { name: others.join(", ") })}` : t.colors[option];
        return (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={color === option}
            aria-label={label}
            title={label}
            className="ambient-swatch"
            onClick={() => onChange(option)}
            style={{ background: colorFill(option) }}
          />
        );
      })}
    </div>
  );
}
