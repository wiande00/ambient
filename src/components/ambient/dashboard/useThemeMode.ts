"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * Light or dark, remembered on this machine.
 *
 * The value is read straight off `<html data-mode>` rather than held in React state,
 * because the inline script in `app/layout.tsx` has already set it before the first paint.
 * Reading the DOM keeps the two in step and means the first client render agrees with the
 * markup the server sent — the server snapshot is "light", which is what the html element
 * carries until the script runs.
 */

export type ThemeMode = "light" | "dark";

const KEY = "ambient.mode";

/** Bumped on every write; `useSyncExternalStore` re-reads the attribute when it fires. */
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useThemeMode(): { mode: ThemeMode; toggle: () => void } {
  const mode = useSyncExternalStore(
    subscribe,
    () => (document.documentElement.dataset.mode === "dark" ? "dark" : "light"),
    () => "light" as const,
  );

  const toggle = useCallback(() => {
    const next: ThemeMode = document.documentElement.dataset.mode === "dark" ? "light" : "dark";
    document.documentElement.dataset.mode = next;
    try {
      localStorage.setItem(KEY, next);
    } catch {
      // A locked-down browser profile costs the preference, not the toggle.
    }
    for (const listener of listeners) listener();
  }, []);

  return { mode, toggle };
}
