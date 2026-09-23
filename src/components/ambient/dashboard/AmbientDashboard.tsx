"use client";

import { useEffect, useState } from "react";
import type { AmbientChunksResponse, AmbientDayResponse, AmbientWeekResponse } from "@/lib/ambient/types";
import { en } from "@/i18n/en";
import { DayScreen } from "./DayScreen";
import { DeskNav } from "./DeskNav";
import { SettingsScreen } from "./SettingsScreen";
import { UpdateBanner } from "./UpdateBanner";
import { useDesktopStatus } from "./useDesktop";
import { useThemeMode } from "./useThemeMode";
import { WeekScreen } from "./WeekScreen";

/**
 * The app shell: a sidebar with three screens behind it.
 *
 * The day screen makes two independent fetches, on purpose. The day endpoint returns only
 * measured figures and needs no key, so the page paints in full from local disk alone. The
 * chunks — the interpreted sentences and the project colours — are fetched separately and
 * are allowed to be slow, to cost money, and to be absent. A missing key costs the labels,
 * not the screen.
 *
 * The screens refetch on a slow tick, visible or not — the day endpoint is a local disk
 * read, and the chunks route only pays for a model call once the day has moved on enough —
 * and once more whenever the page becomes visible again. In the desktop app the shell also
 * pokes the page soon after the collector writes a block, so a window that was covered or
 * minimised shows the right totals as soon as it is brought back rather than a minute later.
 * Today includes the window in front right now, which the log only gets once focus moves
 * on (`lib/ambient/live.ts`), so the figures move on the tick even while nobody switches.
 *
 * In a browser the shell draws the app as an object sitting on a desk: a framed panel on a
 * warm ground, with its own title bar. In the desktop app the window is that object, so the
 * page fills it and its title bar is the window's; Windows draws the real caption buttons
 * over the bar's right end, where the mockup drew pretend ones. The difference is all CSS,
 * keyed to `data-shell` in `app/globals.css`, so the first paint is already the right one.
 */

const t = en.ambient;

/** How often a screen refetches on its own. The chunks route only pays for a model call when the day has moved on enough. */
const REFRESH_MS = 60_000;

type Screen = "day" | "week" | "settings";

const NAV = [
  { value: "day", label: t.nav.day, icon: "clock" },
  { value: "week", label: t.nav.week, icon: "calendar" },
  { value: "settings", label: t.nav.settings, icon: "settings" },
];

function toScreen(value: string): Screen {
  return value === "week" || value === "settings" ? value : "day";
}

export function AmbientDashboard() {
  const [screen, setScreen] = useState<Screen>("day");
  // `null` means "follow today" — so a dashboard left open overnight rolls onto the new day
  // by itself rather than pinning to whatever date it was opened on. A real date here means
  // the person navigated deliberately and the view should stay put.
  const [date, setDate] = useState<string | null>(null);
  const [weekTo, setWeekTo] = useState<string | null>(null);
  const [day, setDay] = useState<AmbientDayResponse | { status: "loading" }>({ status: "loading" });
  // Keyed to the day they describe, so yesterday's sentences never appear over today's band
  // while the new day's are still in flight.
  const [chunks, setChunks] = useState<{ date: string | null; response: AmbientChunksResponse | { status: "loading" } }>({
    date: null,
    response: { status: "loading" },
  });
  const [week, setWeek] = useState<{ to: string | null; response: AmbientWeekResponse } | null>(null);
  // Bumped to refetch whatever is on screen; the fetch effects list it as a dependency.
  const [tick, setTick] = useState(0);
  // The update banner and the sidebar's collector card; both stay null in a browser.
  const { desktop: isDesktop, status: desktop } = useDesktopStatus();
  const { mode, toggle } = useThemeMode();

  useEffect(() => {
    const bump = () => setTick((n) => n + 1);
    const onVisibility = () => {
      if (document.visibilityState === "visible") bump();
    };
    document.addEventListener("visibilitychange", onVisibility);
    const timer = window.setInterval(bump, REFRESH_MS);
    const offData = window.ambient?.onDataChanged(bump);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.clearInterval(timer);
      offData?.();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/ambient/day${date ? `?date=${date}` : ""}`)
      .then((res) => res.json())
      .then((next: AmbientDayResponse) => {
        if (!cancelled) setDay(next);
      })
      .catch((error: unknown) => {
        if (!cancelled) setDay({ status: "error", message: error instanceof Error ? error.message : "Request failed." });
      });
    return () => {
      cancelled = true;
    };
  }, [date, tick]);

  // No synchronous "loading" reset here: the render treats a response keyed to a different
  // date as loading, which avoids the extra render a setState inside the effect would cost.
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/ambient/chunks${date ? `?date=${date}` : ""}`)
      .then((res) => res.json())
      .then((next: AmbientChunksResponse) => {
        if (!cancelled) setChunks({ date, response: next });
      })
      .catch((error: unknown) => {
        if (!cancelled) setChunks({ date, response: { status: "error", message: error instanceof Error ? error.message : "Request failed." } });
      });
    return () => {
      cancelled = true;
    };
  }, [date, tick]);

  useEffect(() => {
    if (screen !== "week") return;
    let cancelled = false;
    fetch(`/api/ambient/week${weekTo ? `?date=${weekTo}` : ""}`)
      .then((res) => res.json())
      .then((next: AmbientWeekResponse) => {
        if (!cancelled) setWeek({ to: weekTo, response: next });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setWeek({ to: weekTo, response: { status: "error", message: error instanceof Error ? error.message : "Request failed." } });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [screen, weekTo, tick]);

  return (
    <div className="ambient-desk">
      <div className="ambient-frame">
        <TitleBar mode={mode} onToggleMode={toggle} />

        <div className="ambient-body">
          <DeskNav items={NAV} value={screen} onChange={(value) => setScreen(toScreen(value))} status={desktop} desktop={isDesktop} />

          <main style={{ flex: 1, minWidth: 0, padding: "38px 44px 48px" }}>
            <UpdateBanner update={desktop?.update} />
            {screen === "settings" ? (
              <SettingsScreen />
            ) : screen === "day" ? (
              day.status === "ready" || day.status === "empty" ? (
                <DayScreen
                  day={day}
                  chunks={chunks.date === date ? chunks.response : { status: "loading" }}
                  onDateChange={setDate}
                  onChanged={() => setTick((n) => n + 1)}
                  // Kept only if the screen is still on the day it was asked for.
                  onChunks={(next) => setChunks((current) => (current.date === date ? { date, response: next } : current))}
                  refreshKey={tick}
                />
              ) : day.status === "error" ? (
                <Message title={t.error.title} body={day.message} />
              ) : null
            ) : week && week.to === weekTo && week.response.status === "ready" ? (
              <WeekScreen week={week.response} onWeekChange={setWeekTo} />
            ) : week && week.to === weekTo && week.response.status === "error" ? (
              <Message title={t.error.title} body={week.response.message} />
            ) : null}
          </main>
        </div>
      </div>
    </div>
  );
}

/**
 * The app's own title bar: the mark, the name, and the light/dark switch. The switch is
 * labelled with the mode it moves to, not the one in use, so it reads as an action.
 *
 * In the desktop app this is also the window's title bar, and the caption buttons Windows
 * draws over it are told the bar's colours whenever the mode changes. The first report is
 * what opens the window, so a dark page never appears under light buttons.
 */
function TitleBar({ mode, onToggleMode }: { mode: "light" | "dark"; onToggleMode: () => void }) {
  useEffect(() => {
    const bridge = window.ambient;
    if (!bridge) return;
    const tokens = getComputedStyle(document.documentElement);
    const token = (name: string) => tokens.getPropertyValue(name).trim();
    bridge
      .setWindowColors({ titleBar: token("--panel-2"), symbols: token("--ink-2"), background: token("--panel") })
      .catch(() => undefined);
  }, [mode]);

  return (
    <div className="ambient-titlebar">
      {/* eslint-disable-next-line @next/next/no-img-element -- a fixed 18px mark from /public; the optimizer has nothing to add. */}
      <img src="/brand/ambient-mark.png" alt="" width={18} height={18} style={{ display: "block", borderRadius: 6 }} />
      <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: "0.01em", color: "var(--ink-2)" }}>{en.ambient.meta.title}</span>
      <span style={{ flex: 1 }} />
      <button
        type="button"
        onClick={onToggleMode}
        className="ambient-chip ui-mono"
        style={{
          border: "1px solid var(--border-soft)",
          background: "var(--panel)",
          color: "var(--ink-3)",
          fontSize: 10,
          letterSpacing: "0.14em",
          textTransform: "uppercase",
          padding: "5px 11px",
          borderRadius: 999,
          cursor: "pointer",
        }}
      >
        {mode === "dark" ? t.nav.toLight : t.nav.toDark}
      </button>
    </div>
  );
}

function Message({ title, body }: { title: string; body: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)", maxWidth: 520 }}>
      <span
        style={{
          fontFamily: "var(--font-display)",
          fontWeight: "var(--weight-black)",
          fontStretch: "90%",
          fontSize: "var(--text-h3)",
          letterSpacing: "var(--tracking-display)",
        }}
      >
        {title}
      </span>
      <span style={{ fontSize: "var(--text-body-sm)", color: "var(--ink-3)", lineHeight: "var(--leading-body)" }}>{body}</span>
    </div>
  );
}
