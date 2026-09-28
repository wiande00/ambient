"use client";

import { formatClock, remainingAt, useNow, usePomodoro } from "./usePomodoro";

/**
 * The time left on the focus timer, beside its sidebar item — only while it runs or is
 * paused mid-phase, so an idle timer adds nothing to the sidebar.
 */
export function FocusBadge() {
  const s = usePomodoro();
  const running = s.endsAt !== null;
  const now = useNow(running);
  if (!s.started) return null;
  return (
    <span
      className="ui-mono"
      style={{
        fontSize: 11,
        fontWeight: 600,
        fontVariantNumeric: "tabular-nums",
        color: running ? (s.phase === "work" ? "var(--data-1t)" : "var(--ink-3)") : "var(--ink-4)",
      }}
    >
      {formatClock(remainingAt(s, now))}
    </span>
  );
}
