"use client";

import { Icon } from "@/ui/Icon";
import { clock } from "@/lib/ambient/format";
import type { AmbientDesktopStatus } from "@/types/ambient-bridge";
import { en } from "@/i18n/en";
import { interpolate } from "@/i18n";

/**
 * The sidebar: three screens, and the collector's own state underneath them.
 *
 * The collector card is not decoration. Every figure on every screen is only as true as the
 * collector's log, so the one thing the sidebar owes the person is whether it is running and
 * since when — and the reminder that none of it leaves the machine. In a browser there is no
 * shell to ask, so the card says where the collector does run instead of inventing a state.
 */

const t = en.ambient.nav;

export type NavItem = { value: string; label: string; icon: string };

export function DeskNav({
  items,
  value,
  onChange,
  status,
  desktop,
}: {
  items: NavItem[];
  value: string;
  onChange: (value: string) => void;
  /** The desktop shell's live status, or null in a browser. */
  status: AmbientDesktopStatus | null;
  desktop: boolean;
}) {
  return (
    <nav
      // `ambient-nav` rounds the outer corner on the desk and keeps the sidebar in place
      // while the screens scroll in the desktop app.
      className="ambient-nav"
      style={{
        width: 196,
        flex: "0 0 auto",
        borderRight: "1px solid var(--border-soft)",
        background: "var(--panel-2)",
        padding: "26px 14px",
        display: "flex",
        flexDirection: "column",
        gap: 26,
      }}
    >
      <span className="ambient-eyebrow" style={{ padding: "0 10px" }}>
        {t.heading}
      </span>

      <div style={{ display: "grid", gap: 3, alignContent: "start" }}>
        {items.map((item) => {
          const on = item.value === value;
          return (
            <button
              key={item.value}
              type="button"
              aria-current={on ? "page" : undefined}
              onClick={() => onChange(item.value)}
              className="ambient-nav-item"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 11,
                height: 42,
                padding: "0 12px",
                border: "none",
                borderRadius: 13,
                cursor: "pointer",
                textAlign: "left",
                fontFamily: "var(--font-sans)",
                fontSize: 15,
                background: on ? "var(--nav-on)" : "transparent",
                color: on ? "var(--ink-1)" : "var(--ink-3)",
                fontWeight: on ? 700 : 500,
              }}
            >
              <Icon name={item.icon} size={17} style={{ color: on ? "var(--data-1t)" : "currentColor" }} />
              <span style={{ flex: 1 }}>{item.label}</span>
            </button>
          );
        })}
      </div>

      <span style={{ flex: 1 }} />

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 9,
          padding: 14,
          borderRadius: 16,
          background: "var(--panel)",
          border: "1px solid var(--border-soft)",
        }}
      >
        <span className="ambient-eyebrow">{t.collector.heading}</span>
        {status ? (
          <>
            <CollectorLine collector={status.collector} />
            <span className="ui-mono" style={{ fontSize: 10, color: "var(--ink-4)", lineHeight: 1.45 }}>
              {interpolate(t.collector.privacy, { version: status.version })}
            </span>
          </>
        ) : (
          // A browser, or the shell's first status has yet to arrive: say where the
          // collector runs rather than guess at a state it might be in.
          <span style={{ fontSize: 12, color: "var(--ink-3)", lineHeight: 1.45 }}>{desktop ? "" : t.collector.web}</span>
        )}
      </div>
    </nav>
  );
}

function CollectorLine({ collector }: { collector: AmbientDesktopStatus["collector"] }) {
  const { dot, text } = describe(collector);
  return (
    <span style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--ink-3)", lineHeight: 1.45 }}>
      <span aria-hidden="true" style={{ width: 7, height: 7, borderRadius: 999, background: dot, flex: "0 0 auto" }} />
      {text}
    </span>
  );
}

function describe(state: NonNullable<AmbientDesktopStatus["collector"]>): { dot: string; text: string } {
  const copy = en.ambient.nav.collector;
  switch (state.state) {
    case "running":
      return { dot: "var(--data-1)", text: interpolate(copy.running, { time: clock(state.since) }) };
    case "restarting":
      return { dot: "var(--status-caution)", text: interpolate(copy.restarting, { seconds: String(state.inSeconds) }) };
    case "stopped":
      return { dot: "var(--status-negative)", text: copy.stopped };
    case "disabled":
      return { dot: "var(--paper-4)", text: copy.unmanaged };
  }
}
