import type { Metadata } from "next";
import { JetBrains_Mono, Manrope } from "next/font/google";
import "./globals.css";

/**
 * Self-hosted at build time — no request ever leaves for Google. `latin-ext` covers å ä ö.
 *
 * Manrope carries both roles: the statement type at 800 and the reading type at 400–600.
 * One family across the whole app is deliberate — the desk theme separates display from UI
 * by size and weight, not by family, and a second face would fight the mono for attention.
 */
const manrope = Manrope({
  subsets: ["latin", "latin-ext"],
  weight: ["400", "500", "600", "700", "800"],
  variable: "--font-manrope",
  display: "swap",
});

/** Clock times, durations, and every label set in small caps. */
const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin", "latin-ext"],
  weight: ["400", "500", "600"],
  variable: "--font-jetbrains-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: { default: "Ambient", template: "%s" },
  description: "What this machine was actually doing today, read from the window that had focus.",
  applicationName: "Ambient",
  robots: { index: false, follow: false },
};

/**
 * Sets `data-mode` before the first paint, so a dark-mode window never flashes the paper
 * ground on its way in. It runs ahead of React and is the only reason this is inline; the
 * toggle itself lives in `useThemeMode`, which writes the same key.
 *
 * It also sets `data-shell="desktop"` when the desktop app's preload has put `window.ambient`
 * in place, so the page fills the window instead of framing itself on the desk. The preload
 * runs before any page script, so the answer is already there.
 *
 * Both attributes can differ from the markup the server sent, which is why `<html>` alone
 * suppresses the hydration warning.
 */
const HEAD_SCRIPT = `try{var m=localStorage.getItem("ambient.mode");document.documentElement.dataset.mode=m==="dark"?"dark":"light"}catch(e){document.documentElement.dataset.mode="light"}if(window.ambient)document.documentElement.dataset.shell="desktop";`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      data-theme="desk"
      data-mode="light"
      className={`${manrope.variable} ${jetbrainsMono.variable}`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: HEAD_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
