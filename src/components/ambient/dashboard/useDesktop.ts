import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { AmbientDesktopStatus } from "@/types/ambient-bridge";

/**
 * The desktop shell's presence and its live status. In a browser `window.ambient` is
 * undefined, `desktop` stays false and `status` stays null, and every screen falls back to
 * its web behaviour. Presence is read through `useSyncExternalStore` with a server snapshot
 * of `false`, so the first client render matches the server's and there is no flash.
 */

const subscribeNever = () => () => {};

export function useIsDesktop(): boolean {
  return useSyncExternalStore(
    subscribeNever,
    () => window.ambient !== undefined,
    () => false,
  );
}

export function useDesktopStatus() {
  const desktop = useIsDesktop();
  const [status, setStatus] = useState<AmbientDesktopStatus | null>(null);

  useEffect(() => {
    const bridge = window.ambient;
    if (!bridge) return;
    const off = bridge.onStatus(setStatus);
    bridge.getStatus().then(setStatus, () => undefined);
    return off;
  }, []);

  const refresh = useCallback(async () => {
    const next = await window.ambient?.getStatus();
    if (next) setStatus(next);
  }, []);

  return { desktop, status, setStatus, refresh };
}
