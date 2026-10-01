import { useState } from "react";
import { Button } from "@/ui/Button";
import { en } from "@/i18n/en";
import { interpolate } from "@/i18n";
import { clock } from "@/lib/ambient/format";
import type { AmbientChunksResponse, AmbientLabelProblem } from "@/lib/ambient/types";
import { Bar } from "./UpdateBanner";

/**
 * A warning across the top of the dashboard while labelling is stuck on something only the
 * person can fix: the Anthropic account is out of credit, or the key is refused. Without it
 * the only sign is stretches that stay "Not labelled", which reads like the model being slow.
 *
 * "Hide" holds for this problem until the app restarts; a new problem shows again. "Try
 * again" is one "Label now" call for the day on screen, and the banner goes once it succeeds.
 */

const t = en.ambient.labelProblem;

/** Opens in the default browser from the desktop app (`electron/window.ts`), in a new tab in a browser. */
const BILLING_URL = "https://console.anthropic.com/settings/billing";

export function LabelProblemBanner({
  problem,
  date,
  onOpenSettings,
  onRetried,
}: {
  problem: AmbientLabelProblem | null;
  /** The day on screen, for "Try again". */
  date: string | null;
  onOpenSettings: () => void;
  /** After "Try again", to refetch what is on screen. */
  onRetried: () => void;
}) {
  const [hidden, setHidden] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [stillFailing, setStillFailing] = useState(false);
  if (!problem || hidden === `${problem.kind} ${problem.since}`) return null;

  async function retry() {
    if (!date) return;
    setBusy(true);
    setStillFailing(false);
    try {
      const res = await fetch("/api/ambient/chunks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ date }),
      });
      const next: AmbientChunksResponse = await res.json();
      // A call that went through clears the problem on the server; the refetch drops the banner.
      setStillFailing(next.status !== "ready" || next.labelProblem !== null);
    } catch {
      setStillFailing(true);
    } finally {
      setBusy(false);
      onRetried();
    }
  }

  const credits = problem.kind === "credits";
  const detail = `${credits ? t.creditsBody : t.authBody} ${stillFailing ? t.stillFailing : interpolate(t.lastTried, { time: clock(problem.lastTried) })}`;

  return (
    <Bar
      tone="caution"
      text={credits ? t.creditsTitle : t.authTitle}
      detail={detail}
      actions={
        <>
          <Button variant="ghost" size="sm" type="button" disabled={busy} onClick={() => setHidden(`${problem.kind} ${problem.since}`)}>
            {t.dismiss}
          </Button>
          {date ? (
            <Button variant="outline" size="sm" type="button" disabled={busy} loading={busy} onClick={() => void retry()}>
              {t.retry}
            </Button>
          ) : null}
          {credits ? (
            <Button variant="primary" size="sm" type="button" onClick={() => window.open(BILLING_URL, "_blank", "noopener")}>
              {t.billing}
            </Button>
          ) : (
            <Button variant="primary" size="sm" type="button" onClick={onOpenSettings}>
              {t.settings}
            </Button>
          )}
        </>
      }
    />
  );
}
