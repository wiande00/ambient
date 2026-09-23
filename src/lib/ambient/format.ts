/**
 * `"7h 12"` — hours and zero-padded minutes, the form the design sets in tabular figures.
 * Under an hour it drops to `"58 min"` rather than showing `"0h 58"`, which reads as a
 * failure state at a glance.
 *
 * Anything above zero but under a minute renders as `"<1 min"`, never `"0 min"`. Rounding a
 * real measurement down to a zero says "nothing happened here", which is a different and
 * false claim about time that was genuinely observed. A true zero renders as `"0 min"`.
 */
export function formatDuration(minutes: number): string {
  if (minutes > 0 && minutes < 0.5) return "<1 min";
  const whole = Math.round(minutes);
  if (whole < 60) return `${whole} min`;
  const hours = Math.floor(whole / 60);
  return `${hours}h ${String(whole % 60).padStart(2, "0")}`;
}

/** `"09:41"` from a local-ISO instant or a millisecond timestamp. */
export function clock(at: string | number): string {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}
