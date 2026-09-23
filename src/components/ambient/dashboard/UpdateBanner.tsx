import { useState } from "react";
import { Button } from "@/ui/Button";
import { en } from "@/i18n/en";
import { interpolate } from "@/i18n";
import type { AmbientUpdateState } from "@/types/ambient-bridge";

/**
 * One line across the top of the dashboard when the desktop shell has a newer build verified
 * and waiting. "Later" hides it for this version until the app next starts; the tray keeps
 * offering the update in the meantime. Nothing renders in a browser or while up to date.
 */

const t = en.ambient.updateBanner;

export function UpdateBanner({ update }: { update: AmbientUpdateState | undefined }) {
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!update) return null;
  if (update.state === "installing") return <Bar text={interpolate(t.installing, { version: update.version })} />;
  if (update.state !== "ready" || dismissed === update.version) return null;

  async function onInstall() {
    setBusy(true);
    try {
      await window.ambient?.installUpdate();
    } finally {
      // Only reached if nothing was installed; a real install exits the app first.
      setBusy(false);
    }
  }

  return (
    <Bar
      text={interpolate(t.title, { version: update.version })}
      detail={t.body}
      actions={
        <>
          <Button variant="ghost" size="sm" type="button" disabled={busy} onClick={() => setDismissed(update.version)}>
            {t.later}
          </Button>
          <Button variant="primary" size="sm" type="button" disabled={busy} loading={busy} onClick={() => void onInstall()}>
            {t.install}
          </Button>
        </>
      }
    />
  );
}

function Bar({ text, detail, actions }: { text: string; detail?: string; actions?: React.ReactNode }) {
  return (
    <div
      role="status"
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--space-4)",
        flexWrap: "wrap",
        marginBottom: "var(--space-6)",
        padding: "var(--space-3) var(--space-4)",
        borderRadius: "var(--radius-card)",
        background: "var(--status-info-soft)",
        border: "1px solid var(--border-soft)",
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 2, flex: 1, minWidth: 240 }}>
        <span style={{ fontSize: "var(--text-body-md)", fontWeight: "var(--weight-semibold)", color: "var(--ink-1)" }}>{text}</span>
        {detail ? <span style={{ fontSize: "var(--text-body-sm)", color: "var(--ink-3)" }}>{detail}</span> : null}
      </div>
      {actions ? <div style={{ display: "flex", gap: "var(--space-2)", alignItems: "center" }}>{actions}</div> : null}
    </div>
  );
}
