# Ambient

A time tracker for Windows that works out where your hours went without you starting or
stopping anything. It watches which window has focus, cuts the day at its natural breaks,
and asks Claude for one plain sentence and one project per stretch — a handful of chunks a
day, plus honest idle and away time.

- **Automatic.** Starts when you sign in and runs quietly in the tray.
- **Local.** Everything it records stays in `~/.ambient/` on your machine.
- **Correctable.** Edit, add or delete any stretch; your edits sit on top of what was measured.
- **Works with Claude.** Ships an MCP server so Claude can read your days and keep your
  projects list.

## Install

1. Download `Ambient-Setup-<version>.exe` from the
   [latest release](https://github.com/wiande00/ambient/releases/latest).
2. Run it. The installer is not code-signed, so Windows shows *"Windows protected your PC"*
   the first time; choose **More info → Run anyway**. It installs for your user only, under
   `%LOCALAPPDATA%\Programs\Ambient`, with no admin prompt.
3. Ambient opens, starts recording, and from now on starts itself when you sign in. Closing
   the window keeps it in the tray; quit from the tray icon.

Windows 10 or 11, x64.

### First run

- **Anthropic API key.** Open **Settings** and paste a key from
  [console.anthropic.com](https://console.anthropic.com/) → *API Keys*. Without one every
  measured figure still shows; only the sentences and project colours are missing. Labelling
  a day costs a few cents at most, and a finished day is cached and never paid for twice.
- **Projects.** In **Settings › Projects**, add the things you work on, each with a short
  description and a few *hints* — words, window titles or paths that mark that project's
  work. Anything that fits no project lands in *personal*, *admin* or *other*.

### Updates

Ambient checks GitHub for a new release shortly after it starts and every fifteen minutes
after that. When one is out it downloads it, checks its SHA-512 against the release, and
shows **Update now** across the top of the dashboard and in the tray menu. Updating quits
the app cleanly, installs silently and starts the new version; your data is untouched.
*Settings › Version* shows the running version and has *Check for updates*.

## Privacy

Read this before installing. The collector records, for the window in front: the app, its
title, how long it had focus, and whether there was keyboard or mouse input (never *what*
was typed). It also reads the **visible text** of that window through Windows UI
Automation, the same interface screen readers use. That text is what gets sent to the
Anthropic API when a stretch is labelled, so anything visible on screen can end up in a
request. Password managers are excluded by default, and *Settings › Never read text from these apps*
adds more apps.

It never takes screenshots, logs keystrokes, reads the clipboard, browser history or files.
The collector itself makes no network calls. The app makes two kinds: labelling requests to
the Anthropic API with your key, and the update check against this repository's releases.

## How it works

Two halves ship as one Windows app:

- **The collector** — `collector/collect.ps1`, a PowerShell script the app runs hidden. It
  appends JSON lines to `~/.ambient/<yyyy-MM-dd>.jsonl`: which window had focus and for how
  long, every run of no input, and every stretch the session was locked or the machine
  slept. A window's line is written when focus leaves it, so the one in front right now is
  kept in `~/.ambient/live.json`, rewritten every 15 seconds.
- **The dashboard** — a Next.js app, bundled and served on `127.0.0.1` only, that measures
  each day from those lines, cuts it at its natural breaks, and asks Claude for one sentence
  and a project per chunk.

## What the day screen shows

- **Active / Idle / Away.** Active is time at the machine under the idle rule below. Idle is
  time a window was in front with nobody touching the machine. Away is time between the first
  and last observed moment that no window covers: locked, asleep, or the collector not running.
  Time you removed from the day (see *Correcting a day*) counts as none of the three.
- **The band.** The day in proportion, coloured by project, idle hatched, away as bare track.
- **The chunks.** Three to six stretches a day, one to three hours each, cut at every
  absence of twenty minutes or more, whether the screen locked or a window sat there
  untouched. Each gets a plain past-tense sentence (compound when the stretch held several
  things), a project, and measured minutes. How long an untouched window has to sit before
  it counts as a break is *Break after* on the Settings screen (default 20 minutes).
- **By project.** Active minutes per project for the day; the week screen totals seven days.
  A chunk is coarse on purpose — one sentence over an hour or two — but its minutes are not
  counted that coarsely. Each chunk carries a *ledger*: the stretch divided between the
  projects that actually held it, on boundaries the collector measured. So an hour of one
  project with twenty minutes of another inside it reads as one stretch and still puts twenty
  minutes where they belong; the card says *also Thesis 20 min* under the sentence. The story
  is coarse and the ledger is exact, which is the whole point of keeping them apart.

## Working off the computer

The collector cannot see pen and paper. The day screen has a *Working off computer* switch:
pick a project, say what in a few words, and flick it on; flick it off when you are back.
While it is on, the time counts as active work on that project whatever the screen shows
and however long the keyboard is untouched, and it becomes a chunk of its own with the text
you gave it, never sent to the model. Sessions live in `~/.ambient/offcomputer.json`. The
MCP connector has `start_off_computer` and `stop_off_computer` for the same switch.

## Correcting a day

When a chunk is wrong, fix it in the list under *What you did*:

- **Edit.** The pencil on a chunk opens it in place: change the sentence, the project or the
  times. *Count the idle time as active* turns the whole stretch into work, for the twenty
  minutes you spent writing on paper while the keyboard sat untouched.
- **Add.** *Add a stretch* beside the heading, or *Add* on a break or a gap, records work the
  screen did not show. An added stretch counts as active on its project whatever the screen
  showed then.
- **Delete.** *Delete* in the editor takes the stretch out of the day: it stops counting as
  tracked, active, idle or away, and leaves the project totals. It stays in the list as a
  *Removed* row with *Restore*. On a chunk you have edited, *Undo my edit* puts back what
  Ambient measured and labelled.

Edits sit on top of what was measured and labelled; they never change it. The model always
labels the day as the collector saw it, so a correction costs no API call and moves no label
anywhere else in the day. The day's figures, band, chunks and the week's totals are all
drawn with the edits applied. A time typed within a minute of a real edge in the day (a
chunk's, a break's) snaps to that edge. Edits live in `~/.ambient/edits.json`. The MCP
connector has `edit_chunk`, `add_chunk`, `delete_chunk` and `undo_chunk_edits`.

## Finishing a day

A day is labelled when someone opens it, because a model call costs money and the week screen
is not allowed to spend any. Left alone that is quietly lossy: a day whose dashboard was last
open at lunchtime keeps an afternoon that no chunk covers, so those hours are in the day's own
Active figure and in no project's total, and nothing says a number is short.

So the app finishes each day once, by itself. A pass shortly after it starts, and once an hour
after that, asks which past days still have a stretch the model has never seen and opens each
of them the way a person would — one at a time, waiting for each, so a fortnight of neglect is
a queue rather than a burst. Today is never closed; it is still being lived, and it re-labels
as it grows. `GET /api/ambient/unclosed` is that question on its own: it reads logs and caches,
calls nothing, and says which days are short and by how many minutes.

## The idle rule

You are active from an input event until five minutes pass with no input at all; then the
whole stretch since that last input is idle, until the next input. Reading a page for three
minutes counts as work; a tab left open for half an hour does not. The threshold is applied by
the app, not the collector, so it can be changed without recollecting: *Idle after* on the
Settings screen (default 300 seconds).

Logs written before the collector recorded idle runs get an estimate per window instead, and
the screen says so.

## The break rule

An absence of twenty minutes or more is a break: it ends the chunk before it and shows as a
row of its own, so a day reads as work, break, work rather than one long push. A shorter one
stays inside the chunk around it — a coffee, not a break — counted as idle but not drawn as a
division of the day. Twenty minutes is the default either way the absence looked to the
collector: a window sitting in front with nobody touching the keyboard, or a hole in the day
where the screen locked, the machine slept or the collector was not running.

*Break after* on the Settings screen moves the first of those. Like the idle rule it is
applied when the log is read, so it changes without recollecting. Raising it folds short
untouched stretches into the work around them; lowering it cuts the day finer. A hole in the
day always ends a stretch at twenty minutes whatever the setting says, because time nobody
observed has no evidence in it and no sentence could honestly cover it.

A day whose stretches the change moves is relabelled on the next load, since the model is
being shown a different stretch; days it does not move keep their cached labels and cost
nothing.

## What the collector records

For the foreground window: process name, title, how long it held focus, and how much of that
time had any keyboard or mouse input (via `GetLastInputInfo`, which reports *whether* input
happened, never what). Every run of no input longer than `-IdleFloorSeconds` (default 60) is
written as its own line, and so is every lock and every sleep. It also reads the **visible
text** of the focused window through Windows UI Automation, the same mechanism screen readers
use. That text is what the dashboard sends to the Anthropic API when it labels a chunk, so
anything visible on screen in any app can end up in a log and in an API request. Password
managers are excluded by default (`-ExcludeApps`); `-ContentApps` narrows extraction to an
allowlist for a single run.

It never captures screenshots, keystrokes, clipboard contents, browser history or file contents.

## Working with it from Claude

Ambient is also an MCP server, so Claude can read where the hours went and keep the
projects list without the app being opened. The server (`mcp/server.ts`, shipped inside the
app and run by `Ambient.exe` in Node mode) is a thin client of the dashboard server the app
already runs on loopback, so nothing leaves the machine. The app must be running.

Tools: `get_day`, `get_week`, `list_days`, `list_projects`, `add_project`, `update_project`,
`remove_project`, `start_off_computer`, `stop_off_computer`, `edit_chunk`, `add_chunk`,
`delete_chunk`, `undo_chunk_edits`, `get_status`.

*Settings › Claude connector* has **Add to Claude Desktop**, which writes the entry into
Claude Desktop's config (a backup is kept; restart Claude Desktop once), and shows the
`claude mcp add …` line for Claude Code.

## Where the data lives

Everything is under `~/.ambient/`:

| Path | What |
| --- | --- |
| `<yyyy-MM-dd>.jsonl` | The collector's log for a day |
| `config.json` | Settings: API key, idle and break thresholds, excluded apps |
| `projects.json` | Your projects (see `projects.example.json`) |
| `edits.json` | Your corrections to chunks |
| `offcomputer.json` | *Working off computer* sessions |
| `chunks/` | Cached labels, keyed to the exact model input |
| `logs/` | Logs for the shell, the server and the collector |
| `updates/` | Downloaded installers waiting to be installed |

Uninstalling (Windows *Settings › Apps*) leaves this folder in place; delete it to remove
your data.

## Development

Requires Node.js 20+ on Windows.

```bash
npm install
npm run dev            # dashboard only, http://localhost:3000
npm run dev:electron   # dashboard + desktop shell + collector
npm run typecheck
npm run lint
```

`AMBIENT_NO_COLLECTOR=1` skips the collector in the dev shell. For development without the
Settings screen, `.env.local` (see `.env.example`) works as a fallback for the API key and
thresholds.

The collector can also run by hand:

```powershell
powershell -File collector/collect.ps1
powershell -File collector/collect.ps1 -ExcludeApps outlook,signal
```

Create `~/.ambient/STOP` to stop it; it flushes what it has and exits.

### Releasing

Every installed copy follows this repository's releases.

1. Bump `version` in `package.json`, commit and push.
2. Run `npm run release` (needs the [GitHub CLI](https://cli.github.com/), signed in).

That builds `release/Ambient-Setup-<version>.exe`, creates the GitHub release `v<version>`
on the pushed commit with the installer and a `latest.json` (version, file, size, SHA-512),
and also drops it into your own `~/.ambient/updates/`. `AMBIENT_RELEASE_NOTES="…"` sets
the text shown in the update banner. `npm run dist` builds the installer without publishing.

`AMBIENT_UPDATE_URL` points the app at a different `latest.json`, and `AMBIENT_UPDATE_URL=off`
turns the GitHub check off.

## Credits

Icons are from [Lucide](https://lucide.dev/) (ISC licence).

## Licence

[MIT](LICENSE)
