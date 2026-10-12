import type { AmbientContentSnapshot } from "./rollup";

/**
 * Lenses: what a window was *about*, read from what the collector already recorded.
 *
 * A window title is often all a stretch has to go on, and for some apps it says nothing:
 * the Claude desktop app is titled "Claude" whatever conversation is open, which on a
 * typical day is half the tracked time. The conversation's name is on screen, though, as a
 * line "<name> - Claude" in the text the collector reads, and a browser title names the page
 * under a suffix and an unread counter. A lens turns those into a *thread* — the
 * conversation, document, page or app the time went to — so a stretch can be divided by
 * what held it, measured to the minute, without asking a model anything.
 *
 * Pure: no I/O, and nothing here looks ahead in time. The thread at a moment depends only on
 * what had been seen by then, so a stretch that has closed reads the same however long the
 * day goes on — which is what lets its label stay cached.
 */

export type ThreadKind = "chat" | "doc" | "web" | "video" | "meeting" | "app" | "home";

export type Thread = {
  /** Stable identity within a day: the app and the name, lower-cased. */
  key: string;
  /** What to show: the conversation, page or document name, cleaned. */
  name: string;
  kind: ThreadKind;
};

/** A stretch of one interval that belonged to one thread. Runs tile their interval. */
export type ThreadRun = Thread & { startMs: number; endMs: number };

const MAX_NAME_CHARS = 120;

const BROWSERS = /^(vivaldi|chrome|msedge|firefox|brave|opera|arc|librewolf|waterfox|chromium)$/i;
/** The browser's own name at the end of its title, in every spelling the big ones use (Edge puts a zero-width space in its own). */
const BROWSER_SUFFIX = /\s+[-—–]\s+(Vivaldi|Google Chrome|Chromium|Microsoft​?\s?Edge|Mozilla Firefox|Firefox|Brave|Opera|Arc)$/;
/** Edge and Chrome fold a tab group into the title: "Page and 3 more pages". */
const MORE_PAGES = /\s+and \d+ more pages?/;
/** Unread counters: "(2) YouTube", "Inbox (195) - mail". Only where a counter sits, so "(group 44)" survives. */
const LEADING_COUNTER = /^\(\d{1,5}\)\s+/;
const INLINE_COUNTER = /\s+\(\d{1,5}\)(?=\s+[-—–|]\s|$)/g;

/** Site suffixes worth shortening, and what kind of thread a page on that site is. Generic sites only. */
const SITES: { suffix: RegExp; short?: string; kind: ThreadKind }[] = [
  { suffix: /\s+-\s+YouTube$/, short: "YouTube", kind: "video" },
  { suffix: /\s+-\s+Twitch$/, short: "Twitch", kind: "video" },
  { suffix: /\s+[-|]\s+Netflix$/, short: "Netflix", kind: "video" },
  { suffix: /\s+-\s+Online LaTeX Editor Overleaf$/, short: "Overleaf", kind: "doc" },
  { suffix: /\s+-\s+Google (Docs|Dokument|Sheets|Kalkylark|Slides|Presentationer)$/, kind: "doc" },
  { suffix: /\.pdf$/i, kind: "doc" },
];
/** Titles that are a call in progress, in a browser or a meeting app. */
const MEETING = /^(Meet\s+[–-]\s|Google Meet\b)|\bZoom Meeting\b|\b(Meeting|Call) (with|in)\b|\|\s*Microsoft Teams$/;
const MEETING_APPS = /^(zoom|ms-teams|teams|webex|ciscowebex)$/i;
/** Desktop apps whose title names the document open in them. */
const DOC_APPS = /^(code|cursor|obsidian|winword|excel|powerpnt|acrord32|acrobat|sumatrapdf|notepad\+\+|notepad|devenv|idea64|pycharm64|rider64|texstudio)$/i;

/** A conversation or tab nobody has named yet: time in it is real, its name says nothing. */
const UNNAMED = /^(new (session|task|chat|conversation|tab)|home|start page|untitled)$/i;

/**
 * An app whose window title is just its own name and whose screen text names the document
 * inside it as "<name> - <title>". The Claude desktop app is the case that matters; the
 * rule is generic so any app that labels its content the same way gets the same reading.
 */
function namesItsDocument(title: string): boolean {
  const trimmed = title.trim();
  return trimmed.length > 0 && trimmed.length <= 40 && !/\s[-—–|]\s/.test(trimmed);
}

/** The document an app's screen text names, or null. Checks cheaply before splitting the text. */
export function documentIn(title: string, text: string): string | null {
  const suffix = ` - ${title.trim()}`;
  if (!namesItsDocument(title) || !text.includes(suffix)) return null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.endsWith(suffix)) continue;
    const name = line.slice(0, -suffix.length).trim();
    if (name.length > 0 && !name.startsWith("More options for")) return name;
  }
  return null;
}

function clip(name: string): string {
  return name.length > MAX_NAME_CHARS ? `${name.slice(0, MAX_NAME_CHARS - 1)}…` : name;
}

function make(app: string, name: string, kind: ThreadKind): Thread {
  const clean = clip(name.trim() || app);
  return { key: `${app.toLowerCase()}|${clean.toLowerCase()}`, name: clean, kind: UNNAMED.test(clean) ? "home" : kind };
}

/** A browser title without the browser, the tab-group tail and the unread counters. */
export function cleanBrowserTitle(title: string): string {
  return title.replace(BROWSER_SUFFIX, "").replace(MORE_PAGES, "").replace(LEADING_COUNTER, "").replace(INLINE_COUNTER, "").trim();
}

/**
 * The thread a window was on, from its app and title and, for apps that name their content
 * on screen, the text of one snapshot.
 */
export function threadOf(app: string, title: string, text?: string): Thread {
  const trimmed = title.trim();
  if (text) {
    const doc = documentIn(trimmed, text);
    if (doc) return make(app, doc, app.toLowerCase() === "claude" ? "chat" : "doc");
  }
  if (BROWSERS.test(app)) {
    let name = cleanBrowserTitle(trimmed);
    if (MEETING.test(name)) return make(app, name, "meeting");
    for (const site of SITES) {
      if (!site.suffix.test(name)) continue;
      if (site.short) name = name.replace(site.suffix, ` - ${site.short}`);
      return make(app, name, site.kind);
    }
    return make(app, name, "web");
  }
  const name = trimmed.replace(LEADING_COUNTER, "").replace(INLINE_COUNTER, "");
  if (MEETING_APPS.test(app) && /meeting|call/i.test(name)) return make(app, name, "meeting");
  if (MEETING.test(name)) return make(app, name, "meeting");
  // A title that is only the app's own name says nothing; the app is the thread.
  if (namesItsDocument(name) && name.toLowerCase() === app.toLowerCase()) return make(app, name, "app");
  return make(app, name, DOC_APPS.test(app) ? "doc" : "app");
}

/**
 * The runs of threads inside one sample's `[startMs, endMs)`. Carry-forward only: from each
 * snapshot onward the thread is what that snapshot showed, until the next one; before the
 * first snapshot inside the range it is what the latest earlier snapshot showed, or the title.
 * Adjacent runs on the same thread are one run.
 */
export function threadRuns(app: string, title: string, contents: AmbientContentSnapshot[] | undefined, startMs: number, endMs: number): ThreadRun[] {
  if (endMs <= startMs) return [];
  const byTitle = threadOf(app, title);
  const reads = (contents ?? [])
    .map((snap) => ({ at: Date.parse(snap.t), snap }))
    .filter((entry) => Number.isFinite(entry.at))
    .sort((a, b) => a.at - b.at);
  // Only an app that names its content on screen can change thread without changing title.
  if (reads.length === 0 || !namesItsDocument(title)) return [{ ...byTitle, startMs, endMs }];

  const threadAt = (text: string) => {
    const doc = documentIn(title, text);
    return doc ? make(app, doc, app.toLowerCase() === "claude" ? "chat" : "doc") : byTitle;
  };
  let current = byTitle;
  const runs: ThreadRun[] = [];
  let cursor = startMs;
  for (const { at, snap } of reads) {
    const next = threadAt(snap.text);
    if (at <= startMs) {
      current = next;
      continue;
    }
    if (at >= endMs) break;
    if (next.key !== current.key) {
      runs.push({ ...current, startMs: cursor, endMs: at });
      cursor = at;
      current = next;
    }
  }
  runs.push({ ...current, startMs: cursor, endMs });
  return runs;
}

/**
 * Runs normalised to tile `[startMs, endMs)` exactly: sorted, each running up to the next
 * one's start, the first opening at `startMs` and the last closing at `endMs`, and
 * neighbours on the same thread joined. Samples merged into one interval can leave a
 * jitter gap between their runs; the gap belongs to the run before it.
 */
export function tileRuns(runs: ThreadRun[], startMs: number, endMs: number): ThreadRun[] {
  const sorted = runs.filter((run) => run.endMs > startMs && run.startMs < endMs).sort((a, b) => a.startMs - b.startMs);
  const out: ThreadRun[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const from = i === 0 ? startMs : Math.max(sorted[i].startMs, out[out.length - 1].endMs);
    const to = i + 1 < sorted.length ? Math.max(from, Math.min(endMs, sorted[i + 1].startMs)) : endMs;
    if (to <= from) continue;
    const last = out[out.length - 1];
    if (last && last.key === sorted[i].key) last.endMs = to;
    else out.push({ ...sorted[i], startMs: from, endMs: to });
  }
  if (out.length > 0) out[out.length - 1].endMs = endMs;
  return out;
}

/** The runs inside `[startMs, endMs)`, cut at its edges. */
export function clipRuns(runs: ThreadRun[], startMs: number, endMs: number): ThreadRun[] {
  return runs
    .filter((run) => run.endMs > startMs && run.startMs < endMs)
    .map((run) => ({ ...run, startMs: Math.max(run.startMs, startMs), endMs: Math.min(run.endMs, endMs) }));
}

/** Interface lines of the Claude app that recur in every view and say nothing about the work. */
const CLAUDE_UI = new Set(
  [
    "Notifications",
    "Primary pane",
    "Auto",
    "Retry",
    "Copy",
    "Edit",
    "Bad response",
    "Good response",
    "Read aloud",
    "Message actions",
    "Dictate",
    "Voice input",
    "Microphone",
    "Use voice mode",
    "Send message",
    "Add files, connectors, and more",
    "Chat messages",
    "Sidebar",
    "Resize sidebar",
    "Get apps and extensions",
    "View all",
    "Close find bar",
    "Next match",
    "Previous match",
    "Find in page",
    "Older",
    "Mark as read",
    "Mark all as read",
    "Jump back in",
    "Knowledge",
    "Suggested actions",
    "Copy to clipboard",
    "Close",
    "Maximize",
    "Minimize",
    "Expand",
    "More options",
    "Stop response",
    "Currently streaming message",
    "Working on it",
    "Thinking",
    "Cancel dictation",
    "Finish dictation",
    "Reply",
    "Running a command on your computer",
    "running",
    "Captured page",
    "Screenshot",
    "Loading",
    "Session activity panel",
    "Close activity panel",
    "Open in Claude Code",
  ].map((line) => line.toLowerCase()),
);
/** Interface lines of the same app that carry a varying part: progress, tool use, the activity panel. */
const CLAUDE_UI_PATTERNS = [
  /^Claude is (responding|thinking)/,
  /^Used .+\(\d+ actions?\)/,
  /^Using .+/,
  /^Screenshot \d+ of \d+$/,
  /^Batch — \d+ actions?$/,
  /^Buttons that scroll the chat/,
  /^Connectors: /,
  /^Knowledge · /,
  /^Claude Desktop \(/,
  /^Bulk actions/,
  /^Show message actions/,
  /^\d+ runs?$/,
];
const RELATIVE_TIME = /^(just now|yesterday|\d+ (second|minute|hour|day|week|month|year)s? ago|\d+\s?[smhdw] ago)$/i;
/** A notification or list entry naming something else that happened: "Morning brief New run · Scheduled task · 1 hour ago". */
const LISTED_ELSEWHERE = /[·•]\s*(just now|\d+\s*\w+ ago)$/i;
const MESSAGE_COUNTER = /^Message \d+ of \d+$/i;
/** A status-bar clock: "10 October 2026 08:29". */
const STATUS_CLOCK = /^\d{1,2}\s+\p{L}+\s+\d{4}\s+\d{1,2}:\d{2}(:\d{2})?$/u;
/** A PDF viewer's page marker: "Page 5", with the isolation marks some viewers put round the number. */
const PAGE_MARKER = /^Page\s*⁨?\d+⁩?$/;
/** Browser furniture that is not the page: extension menus, video player controls, overlays. */
const BROWSER_UI = /^(Bitwarden |picture-in-picture|Close overlay$|Splitscreen View$|Cookie consent$|Dismiss cookie notice$|mailto:)/;
const NO_WORD = /^[^\p{L}\p{N}]*$/u;

/**
 * A snapshot's text with the parts that say nothing about the work taken out: the lines of
 * the window title and thread name (they travel as the block's title), very short fragments
 * (a formula read off the screen one symbol per line), and for apps that name their content
 * on screen, the navigation around it — the sidebar listing *other* conversations, message
 * counters, "5 minutes ago", button labels. The sidebar matters most: it names
 * conversations that were not open, and read as evidence it pulls a stretch toward
 * whichever project those belong to.
 */
export function cleanText(app: string, title: string, threadName: string, text: string): string {
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  const titleLine = title.trim();
  const appNamesContent = namesItsDocument(titleLine);
  const sidebar = new Set<string>();
  if (appNamesContent) {
    for (const line of lines) if (line.startsWith("More options for ")) sidebar.add(line.slice("More options for ".length).trim());
  }
  const docSuffix = appNamesContent ? ` - ${titleLine}` : null;
  const seen = new Set<string>();
  const out: string[] = [];
  const browser = BROWSERS.test(app);
  for (const line of lines) {
    if (line.length < 3 || NO_WORD.test(line) || seen.has(line)) continue;
    seen.add(line);
    if (line === titleLine || line === threadName) continue;
    if (STATUS_CLOCK.test(line) || PAGE_MARKER.test(line) || RELATIVE_TIME.test(line) || LISTED_ELSEWHERE.test(line)) continue;
    // A browser's window and tab titles are already the block's title.
    if (browser && (BROWSER_SUFFIX.test(line) || threadOf(app, line).name === threadName || BROWSER_UI.test(line))) continue;
    if (appNamesContent) {
      if (line.startsWith("More options for ") || sidebar.has(line)) continue;
      if (docSuffix && line.endsWith(docSuffix)) continue;
      if (MESSAGE_COUNTER.test(line) || CLAUDE_UI.has(line.toLowerCase()) || CLAUDE_UI_PATTERNS.some((pattern) => pattern.test(line))) continue;
      if (/^Model: /.test(line) || /^Write your prompt to /.test(line) || /is AI and can make mistakes/.test(line)) continue;
    }
    out.push(line);
  }
  return out.join("\n");
}
