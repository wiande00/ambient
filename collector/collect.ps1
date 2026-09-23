# Ambient — the collector.
#
# This script makes zero network calls. It reads the foreground window's process name,
# title, and whether there has been any keyboard/mouse input system-wide since the last
# sample — on this machine, appended to a file on this machine. Nothing here talks to the
# internet, a server, or anything else — that is the entire privacy claim of
# Ambient, and it is enforced by this file containing no networking code at all, not by a
# promise.
#
# Content extraction: on by default for every foreground app, not a narrow allowlist. It
# reads the *visible text* of whatever window has focus via Windows' UI Automation API —
# the same mechanism screen readers use — and that content is later sent to the Anthropic
# API to produce the read. The tradeoff is deliberate and worth stating plainly:
# whatever is visible on screen in any app — a code editor with a .env file open, a
# terminal echoing a token, a chat client, email — becomes loggable on this machine and
# gets sent to the API as part of the day's digest. -ExcludeApps carves out a small
# always-off floor (password managers, by default — see the param block below);
# -ContentApps narrows back to an explicit allowlist for a single run, e.g. to test one
# app in isolation. It is still not a screenshot: no pixels are ever captured, read, or
# stored, and there is still no keystroke logging and no clipboard access.
#
# What it does NOT read, for any app: keystrokes, clipboard contents, screenshots,
# browser history, or file contents. The idle check (GetLastInputInfo) reports only
# *whether* and *when* the last input happened, never what key was pressed or where the
# mouse clicked.
#
# Usage:
#   powershell -File collector/collect.ps1
#   powershell -File collector/collect.ps1 -ExcludeApps outlook,signal
#   powershell -File collector/collect.ps1 -ContentApps claude          # narrow to one app
#   Ctrl+C stops it if this window has keyboard focus (Windows only delivers the signal
#   to the focused window — no script can change that). To stop it from anywhere without
#   clicking into it, create the file $env:USERPROFILE\.ambient\STOP — the
#   collector checks for it every poll tick and exits cleanly, flushing whatever block
#   was open, the same as Ctrl+C would.
#
# Output: one JSON line per line in $env:USERPROFILE\.ambient\<yyyy-MM-dd>.jsonl,
# but only when the foreground (app, title) pair actually changes — a block is written
# once it closes, stamped with how long it held focus and how much of that was active
# (input detected) vs idle.
#
# Log format (v2). Focus blocks have no "kind"; every other line does:
#   {"kind":"start","v":2,"t":"…Z","idle_floor_s":60}   once per collector run
#   {"kind":"idle","t":"…Z","s":812}                      no input from t for s seconds
#   {"kind":"away","t":"…Z","s":2870,"why":"lock"}        nobody observed: "lock" or "sleep"
#   {"t":"…Z","app":"…","title":"…","dwell_s":178,"active_s":21,"contents":[…]}
# "t" is always UTC. Lines are not strictly chronological — a block covering an idle run is
# written after the idle line — so readers sort. Only idle runs of at least idle_floor_s
# are recorded; what counts as "idle" is decided by the app that reads the log.
#
# Beside the log, $env:USERPROFILE\.ambient\live.json holds what the log does not have yet,
# rewritten every 15 s and removed on a clean stop:
#   {"v":1,"observed":"…Z","pid":1234,"idle_since":"…Z","block":{…the open block's line…}}
# "block" is the open focus block as it would be written if it closed at "observed";
# "idle_since" is the last input event. Either is absent when there is none.

param(
    # Explicit allowlist, matched case-insensitively against the process name. Omitted
    # (the default, $null) means content extraction runs for every app except those in
    # -ExcludeApps. Passing this narrows back to a strict allowlist for this run only —
    # useful to test a single app in isolation without editing the script.
    [string[]]$ContentApps = $null,
    # Apps that never get content extraction, even in the default "every app" mode.
    # Defaults to a short credential-manager floor so a password vault isn't captured by
    # accident; pass an empty array to remove even this floor.
    [string[]]$ExcludeApps = @("1password", "bitwarden", "keepass"),
    # A stretch with no keyboard or mouse input at least this long is written to the log as
    # its own "idle" line. This is a recording floor, not the idle threshold: the app applies
    # the real threshold (five minutes by default) when it reads the log, so the threshold
    # can change later without recollecting. Keep this well below it.
    [int]$IdleFloorSeconds = 60,
    # Consecutive polls that must agree the session is locked before the open block is
    # closed. Absorbs the brief secure-desktop flicker of a UAC prompt.
    [int]$LockPollsToConfirm = 2
)

$ErrorActionPreference = "Stop"

# Under `powershell -File`, `-ExcludeApps a,b` arrives as the single string "a,b" rather than
# two elements (only `-Command` parses the comma), so each element is split on commas here.
function Split-AppList([string[]]$Apps) {
    @($Apps | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim().ToLowerInvariant() } | Where-Object { $_ })
}
$ContentApps = if ($null -ne $ContentApps) { Split-AppList $ContentApps } else { $null }
$ExcludeApps = Split-AppList $ExcludeApps

function Test-ContentEnabled {
    <# Whether this app gets content extraction, given -ContentApps / -ExcludeApps. Not a
       mandatory param — an empty $App should just resolve to "no", not crash the
       collector, so this stays a plain optional string rather than repeating the
       AllowEmptyString trap Write-AmbientBlock already hit once. #>
    param([string]$App)
    $appLower = ("" + $App).ToLowerInvariant()
    if ($ExcludeApps -contains $appLower) { return $false }
    if ($null -ne $ContentApps) { return $ContentApps -contains $appLower }
    return $true
}

$sig = @'
using System;
using System.Text;
using System.Runtime.InteropServices;

public struct AmbientLastInputInfo {
  public uint cbSize;
  public uint dwTime;
}

public class AmbientNative {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
  [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref AmbientLastInputInfo plii);
  [DllImport("user32.dll")] public static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
  [DllImport("user32.dll")] public static extern bool CloseDesktop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetUserObjectInformation(IntPtr h, int index, StringBuilder info, int len, out int needed);
}
'@
Add-Type -TypeDefinition $sig

$UiaAvailable = $true
$UiaLoadAttempted = $false

function Get-ForegroundWindowInfo {
    <# Returns @{ app; title; handle } for whatever window currently has focus, or $null
       if none can be resolved (e.g. focus is on the desktop, or the owning process has
       already exited between the two native calls). #>
    $handle = [AmbientNative]::GetForegroundWindow()
    if ($handle -eq [IntPtr]::Zero) { return $null }

    $titleBuilder = New-Object System.Text.StringBuilder 1024
    [void][AmbientNative]::GetWindowText($handle, $titleBuilder, 1024)
    $title = $titleBuilder.ToString()

    $processId = 0
    [void][AmbientNative]::GetWindowThreadProcessId($handle, [ref]$processId)
    if ($processId -eq 0) { return $null }

    try {
        $process = Get-Process -Id $processId -ErrorAction Stop
    } catch {
        return $null
    }

    return @{ app = $process.ProcessName; title = $title; handle = $handle }
}

function Get-IdleMilliseconds {
    <# Milliseconds since the last system-wide keyboard or mouse event — presence and
       timing only, never which key or where the click landed. #>
    $info = New-Object AmbientLastInputInfo
    $info.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf([type]"AmbientLastInputInfo")
    if (-not [AmbientNative]::GetLastInputInfo([ref]$info)) { return 0 }
    $idle = [Environment]::TickCount - $info.dwTime
    # [Environment]::TickCount wraps every ~49.7 days of uptime; treat a negative delta
    # as "just active" rather than reporting a nonsensical idle duration.
    if ($idle -lt 0) { return 0 }
    return $idle
}

function Test-SecureDesktop {
    <# Whether the session is locked (or otherwise on a secure desktop). While the lock screen
       is up the interactive desktop is not "Default": OpenInputDesktop either fails or hands
       back the Winlogon desktop. Presence only, same as everything else here. Any failure to
       ask resolves to "not locked" so a transient error can never close a block. #>
    $handle = [IntPtr]::Zero
    try {
        $handle = [AmbientNative]::OpenInputDesktop(0, $false, 0x0001)  # DESKTOP_READOBJECTS
        if ($handle -eq [IntPtr]::Zero) { return $true }
        $name = New-Object System.Text.StringBuilder 256
        $needed = 0
        if (-not [AmbientNative]::GetUserObjectInformation($handle, 2, $name, 256, [ref]$needed)) { return $false }  # UOI_NAME
        return $name.ToString() -ne "Default"
    } catch {
        return $false
    } finally {
        if ($handle -ne [IntPtr]::Zero) { [void][AmbientNative]::CloseDesktop($handle) }
    }
}

function Get-VisibleText {
    <# Reads the visible text of a window via UI Automation — the accessibility tree the
       OS already builds for screen readers. No pixels are read; this walks the same
       structural tree a screen reader narrates. Bounded by element count and wall-clock
       time so a huge or pathological page can't stall the polling loop, and by output
       length so one sample can't dominate the log. Returns $null on any failure — a
       missing accessibility tree degrades to title-only for that sample, it never
       crashes the collector.

       Loading the UIAutomationClient/UIAutomationTypes assemblies happens here, lazily,
       on first real use — not eagerly at script startup. Loading them eagerly, before
       every other function in this script is defined, was observed to corrupt command
       resolution for functions defined afterward (a real, reproduced Windows PowerShell
       5.1 quirk, not a guess) — `Get-ForegroundWindowInfo` would stop being resolvable
       moments after being defined. Loading on first call sidesteps it entirely: by the
       time this ever runs, every function in the script already exists. #>
    param([Parameter(Mandatory)] [IntPtr]$Hwnd)
    if (-not $script:UiaLoadAttempted) {
        $script:UiaLoadAttempted = $true
        try {
            Add-Type -AssemblyName UIAutomationClient
            Add-Type -AssemblyName UIAutomationTypes
        } catch {
            $script:UiaAvailable = $false
            Write-Host "UI Automation assemblies unavailable — content extraction disabled, falling back to title-only for the rest of this run."
        }
    }
    if (-not $UiaAvailable) { return $null }
    try {
        $root = [System.Windows.Automation.AutomationElement]::FromHandle($Hwnd)
        if ($null -eq $root) { return $null }

        $walker = [System.Windows.Automation.TreeWalker]::ContentViewWalker
        $sb = New-Object System.Text.StringBuilder
        $seenText = New-Object System.Collections.Generic.HashSet[string]
        $stack = New-Object System.Collections.Generic.Stack[object]
        $stack.Push($root)

        $visited = 0
        $maxElements = 800
        $maxChars = 6000
        $deadline = (Get-Date).AddMilliseconds(1500)

        while ($stack.Count -gt 0 -and $visited -lt $maxElements -and (Get-Date) -le $deadline) {
            $el = $stack.Pop()
            $visited++

            try {
                $name = $el.Current.Name
                if (-not [string]::IsNullOrWhiteSpace($name) -and $seenText.Add($name)) {
                    [void]$sb.AppendLine($name)
                    if ($sb.Length -ge $maxChars) { break }
                }
            } catch {}

            try {
                $child = $walker.GetFirstChild($el)
                while ($null -ne $child) {
                    $stack.Push($child)
                    $child = $walker.GetNextSibling($child)
                }
            } catch {}
        }

        $text = $sb.ToString().Trim()
        if ($text.Length -eq 0) { return $null }
        if ($text.Length -gt $maxChars) { $text = $text.Substring(0, $maxChars) }
        return $text
    } catch {
        return $null
    }
}

function Get-AmbientLogPath {
    $dir = Join-Path $env:USERPROFILE ".ambient"
    if (-not (Test-Path $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    $fileName = (Get-Date).ToString("yyyy-MM-dd") + ".jsonl"
    return Join-Path $dir $fileName
}

function Get-StopFlagPath {
    <# Ctrl+C only reaches this window if it has keyboard focus, which a background
       collector window often won't — there is no script-side fix for that, it's how
       Windows delivers console signals. This file is the real stop mechanism: create it
       (from anywhere — another terminal, a script, this repo) and the collector notices
       it on its next poll tick, deletes it, and exits through the same clean shutdown
       path Ctrl+C would have used (the open block gets flushed, not lost). #>
    return Join-Path $env:USERPROFILE ".ambient\STOP"
}

function ConvertTo-JsonStringLiteral {
    <# Full JSON string escaping (quotes, backslashes, control characters) — the previous
       version only handled backslash and quote, which was fine for short window titles
       but not safe for arbitrary extracted screen text, which can contain newlines,
       tabs, and other control characters. #>
    param([string]$Value)
    if ($null -eq $Value) { return '""' }
    $sb = New-Object System.Text.StringBuilder
    [void]$sb.Append('"')
    foreach ($ch in $Value.ToCharArray()) {
        switch ($ch) {
            '"'  { [void]$sb.Append('\"'); continue }
            '\'  { [void]$sb.Append('\\'); continue }
            "`n" { [void]$sb.Append('\n'); continue }
            "`r" { [void]$sb.Append('\r'); continue }
            "`t" { [void]$sb.Append('\t'); continue }
            default {
                if ([int]$ch -lt 0x20) {
                    [void]$sb.Append('\u' + ('{0:x4}' -f [int]$ch))
                } else {
                    [void]$sb.Append($ch)
                }
            }
        }
    }
    [void]$sb.Append('"')
    return $sb.ToString()
}

function Format-AmbientSnapshot {
    <# One content snapshot as its JSON object. Built once, when the snapshot is taken, and
       kept on it: the escaping walks the text a character at a time, and the open block's
       snapshots are written out again every few seconds for live.json. #>
    param([Parameter(Mandatory)] [string]$Stamp, [Parameter(Mandatory)] [string]$Text)
    # Every ConvertTo-JsonStringLiteral call stays parenthesised — see the note in
    # Format-AmbientBlock about the bare-call-plus-comma trap.
    return '{"t":' + (ConvertTo-JsonStringLiteral $Stamp) + ',"text":' + (ConvertTo-JsonStringLiteral $Text) + '}'
}

function Format-AmbientBlock {
    <# A focus block as one JSON line, or $null for a block not worth writing. The log gets
       this line when the block closes; live.json carries it while the block is still open. #>
    param(
        [Parameter(Mandatory)] [AllowEmptyString()] [string]$App,
        [Parameter(Mandatory)] [AllowEmptyString()] [string]$Title,
        [Parameter(Mandatory)] [datetime]$StartedAt,
        [Parameter(Mandatory)] [int]$DwellSeconds,
        [Parameter(Mandatory)] [int]$ActiveSeconds,
        # Not [Parameter(Mandatory)] — mandatory-plus-empty is exactly the trap that
        # already crashed this script once (the blank-title bug $App/$Title now guard
        # against with AllowEmptyString). A plain optional default sidesteps it entirely:
        # an empty snapshot list just means no "contents" field gets written.
        $Snapshots = @()
    )
    # A blank title (e.g. some background utility windows, like Windows Search's
    # SearchHost) carries no signal — skip it rather than writing a line the rollup would
    # just discard anyway. Mandatory string parameters reject an empty string by default
    # before this body ever runs, so both params need AllowEmptyString for this guard to
    # actually be reachable — without it, a blank title crashes the whole collector
    # instead of being skipped.
    if ([string]::IsNullOrWhiteSpace($App) -or [string]::IsNullOrWhiteSpace($Title)) { return $null }

    $timestamp = $StartedAt.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    # No commas between these — a comma after a bare (command-syntax) function call is
    # PowerShell's array-argument operator, not a list separator, and it silently
    # swallows everything after it as more arguments to that call. Newline-separated
    # statements inside @(...) is the safe way to build a multi-element array here; this
    # was found and confirmed by an actual reproduction, not a style preference.
    $fields = @(
        '"t":' + (ConvertTo-JsonStringLiteral $timestamp)
        '"app":' + (ConvertTo-JsonStringLiteral $App)
        '"title":' + (ConvertTo-JsonStringLiteral $Title)
        '"dwell_s":' + $DwellSeconds
        '"active_s":' + $ActiveSeconds
    )
    # @($Snapshots).Count rather than $Snapshots.Count — guards the single-element and
    # $null cases, where PowerShell would otherwise unwrap to a scalar with no .Count.
    if (@($Snapshots).Count -gt 0) {
        $items = @()
        foreach ($s in $Snapshots) {
            $items += $(if ($s.json) { $s.json } else { Format-AmbientSnapshot -Stamp $s.t -Text $s.text })
        }
        $fields += '"contents":[' + ($items -join ',') + ']'
    }
    return '{' + ($fields -join ',') + '}'
}

function Write-AmbientBlock {
    param(
        [Parameter(Mandatory)] [string]$Path,
        [Parameter(Mandatory)] [AllowEmptyString()] [string]$App,
        [Parameter(Mandatory)] [AllowEmptyString()] [string]$Title,
        [Parameter(Mandatory)] [datetime]$StartedAt,
        [Parameter(Mandatory)] [int]$DwellSeconds,
        [Parameter(Mandatory)] [int]$ActiveSeconds,
        $Snapshots = @()
    )
    $line = Format-AmbientBlock -App $App -Title $Title -StartedAt $StartedAt `
        -DwellSeconds $DwellSeconds -ActiveSeconds $ActiveSeconds -Snapshots $Snapshots
    if ($null -eq $line) { return }
    Add-AmbientLine -Path $Path -Line $line -What "block"
}

function Get-LivePath {
    return Join-Path $env:USERPROFILE ".ambient\live.json"
}

function Write-AmbientLive {
    <# live.json: what the log does not hold yet. A block reaches the log only when it
       closes, so without this the window in front right now — often the one worked in for
       the last hour — is invisible to the app until focus moves, and the dashboard's figures
       only ever caught up the moment it was clicked. This is the open block exactly as it
       would be written if it closed now, and the last input, so the app can see the idle
       run in progress too. Rewritten every few seconds, replaced whole; the app drops it
       once it is stale, and prefers the log's line once the block has closed.

       Never allowed to stop the collector: a snapshot that cannot be written this time is
       skipped, and the next one is seconds away. #>
    param(
        $Block = $null,
        $IdleSince = $null
    )
    try {
        $now = Get-Date
        # Newline-separated, never comma-separated — see the note in Format-AmbientBlock.
        $fields = @(
            '"v":1'
            '"observed":' + (ConvertTo-JsonStringLiteral $now.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ"))
            '"pid":' + $PID
        )
        if ($null -ne $IdleSince) {
            $fields += '"idle_since":' + (ConvertTo-JsonStringLiteral $IdleSince.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ"))
        }
        if ($null -ne $Block) {
            $dwell = [int]($now - $Block.startedAt).TotalSeconds
            if ($dwell -lt 0) { $dwell = 0 }
            $line = Format-AmbientBlock -App $Block.app -Title $Block.title -StartedAt $Block.startedAt `
                -DwellSeconds $dwell -ActiveSeconds ([Math]::Min($dwell, [int]($Block.activeMs / 1000))) -Snapshots $Block.snapshots
            if ($null -ne $line) { $fields += '"block":' + $line }
        }
        $path = Get-LivePath
        $tmp = "$path.tmp"
        [System.IO.File]::WriteAllText($tmp, '{' + ($fields -join ',') + '}', (New-Object System.Text.UTF8Encoding($false)))
        # [NullString]::Value, not $null: PowerShell hands a .NET string parameter $null as
        # "", which Replace rejects as a backup path, and the failure would vanish into the
        # catch below with only the very first snapshot ever written.
        if ([System.IO.File]::Exists($path)) { [System.IO.File]::Replace($tmp, $path, [NullString]::Value) } else { [System.IO.File]::Move($tmp, $path) }
    } catch {
        # A reader holding the file at the wrong instant; the next snapshot will land.
    }
}

function Remove-AmbientLive {
    try { [System.IO.File]::Delete((Get-LivePath)) } catch { }
}

function Add-AmbientLine {
    <# Appends one finished JSON line to the log.

       Anything else holding the log open can make this fail on Windows even though no other
       process is writing to it — and the app reads the log on every dashboard request, so
       that is not a rare collision, it is one a day of collecting will hit. With
       $ErrorActionPreference = "Stop" a single such failure terminates the whole collector,
       which is exactly how a run died mid-morning after 102 blocks.

       So retry briefly, and if the file is still not writable, drop this one line and carry
       on. Losing one window's record is a small, visible cost; losing the rest of the day
       because a reader blinked is not. #>
    param(
        [Parameter(Mandatory)] [string]$Path,
        [Parameter(Mandatory)] [string]$Line,
        [string]$What = "line"
    )
    for ($attempt = 1; $attempt -le 5; $attempt++) {
        try {
            Add-Content -Path $Path -Value $Line -Encoding utf8 -ErrorAction Stop
            return
        } catch {
            if ($attempt -eq 5) {
                Write-Host ("[{0}] log was locked, dropped one {1}: {2}" -f `
                    (Get-Date -Format "HH:mm:ss"), $What, $_.Exception.Message)
                return
            }
            Start-Sleep -Milliseconds (100 * $attempt)
        }
    }
}

function Write-AmbientEvent {
    <# The non-block lines of the log — see the "Log format" note at the top of the file.
       "start" opens a collector run; "idle" is one run of no input at least
       -IdleFloorSeconds long; "away" is a stretch nobody was observed at all (the session was
       locked, or the machine slept). Every one has a "kind", which is how the app tells them
       from focus blocks, and a UTC "t" like every block. #>
    param(
        [Parameter(Mandatory)] [string]$Path,
        [Parameter(Mandatory)] [string]$Kind,
        [Parameter(Mandatory)] [datetime]$At,
        [int]$Seconds = -1,
        [string]$Why = $null,
        [int]$IdleFloor = -1,
        [int]$Version = -1
    )
    $stamp = $At.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    # Newline-separated, never comma-separated — see the note in Write-AmbientBlock.
    $fields = @(
        '"kind":' + (ConvertTo-JsonStringLiteral $Kind)
    )
    if ($Version -ge 0) { $fields += '"v":' + $Version }
    $fields += '"t":' + (ConvertTo-JsonStringLiteral $stamp)
    if ($Seconds -ge 0) { $fields += '"s":' + $Seconds }
    if (-not [string]::IsNullOrEmpty($Why)) { $fields += '"why":' + (ConvertTo-JsonStringLiteral $Why) }
    if ($IdleFloor -ge 0) { $fields += '"idle_floor_s":' + $IdleFloor }
    $line = '{' + ($fields -join ',') + '}'
    Add-AmbientLine -Path $Path -Line $line -What $Kind
}

# --- main loop -------------------------------------------------------------------------

$logPath = Get-AmbientLogPath
Write-Host "Ambient collector running. No network calls are made by this script."
if ($null -ne $ContentApps) {
    Write-Host "Content extraction is limited to: $($ContentApps -join ', ')"
} else {
    Write-Host "Content extraction is on for every foreground app."
}
if ($ExcludeApps.Count -gt 0) {
    Write-Host "  except: $($ExcludeApps -join ', ')"
}
Write-Host "Writing to: $logPath"
Write-Host "Idle runs of $IdleFloorSeconds s or more are recorded; the app decides what counts as idle."
Write-Host "Press Ctrl+C to stop if this window has focus, or create this file to stop it from anywhere:"
Write-Host "  $(Get-StopFlagPath)"
Write-Host ""

# Clear a stale stop flag left over from a previous run so this run doesn't exit instantly.
if (Test-Path (Get-StopFlagPath)) { Remove-Item (Get-StopFlagPath) -Force -ErrorAction SilentlyContinue }

# Three independent cadences, decoupled on purpose: how often the loop wakes up to
# sample input (tight, cheap), how often it re-checks which window has focus (a bit
# looser — still fast enough to catch a sub-10s glance the old 10s poll would have
# missed entirely), and how often it re-extracts screen content while staying in the
# same block (loosest, since a UIA walk is the expensive part).
$tickSeconds = 1
$pollSeconds = 2
$contentSeconds = 30
# How often live.json is rewritten while a block stays open (and once more whenever one
# opens). The app reads it on a one-minute refresh; this keeps it well inside that.
$liveSeconds = 15
# A block that runs long enough to hit this cap has been open for ~10+ minutes at the
# $contentSeconds cadence — dropping the second-oldest (never the newest, never the
# first) keeps the block's opening and its most recent moments, trimming the middle.
$maxSnapshotsPerBlock = 20
# A tick that took longer than this did not run late — it did not run at all. The loop
# sleeps for one second, so nothing legitimate comes close: the slowest honest tick is a
# UI Automation walk hitting its own 1500ms deadline. Anything past this means the process
# was not being scheduled, which in practice means the machine slept, hibernated or was
# suspended, and everything between the two ticks is time the collector did not observe.
$suspendThresholdMs = 30 * 1000
$current = $null      # @{ app; title; startedAt; activeMs; snapshots; msSinceContent }
$blocksWritten = 0
$lastInputAt = $null   # absolute tick (ms) of the most recently detected input event
$lastTickAt = $null    # [Environment]::TickCount as of the previous loop iteration
$lastSeenAt = Get-Date # wall clock as of the previous tick — where a block ends if the machine sleeps
$msSincePoll = 0
$msSinceLive = 0
# Wall-clock instant of the most recent input event, as of the previous tick. The stretch
# from here to the next input event is one idle run; if it is long enough it gets its own
# line. $null after a lock or a sleep, so the first input afterwards cannot be read as the
# end of a run that spanned the gap.
$lastInputWall = $null
# Lock state. $lockCandidateAt is the wall clock of the first poll that looked locked;
# $lockedSince is set once -LockPollsToConfirm polls agree, and cleared on unlock.
$lockPolls = 0
$nullPolls = 0
$lockCandidateAt = $null
$lockedSince = $null

# Opens the run: every later line is read against this header. v2 is the first format with
# "kind" lines at all.
Write-AmbientEvent -Path $logPath -Kind "start" -At (Get-Date) -Version 2 -IdleFloor $IdleFloorSeconds

function Close-IdleRun {
    <# Writes the idle run that began at the last input event, if it reached the floor.
       $EndedAt is the moment input resumed, the lock began, or the last tick before sleep. #>
    param([Parameter(Mandatory)] [datetime]$EndedAt)
    if ($null -eq $script:lastInputWall) { return }
    $seconds = [int]($EndedAt - $script:lastInputWall).TotalSeconds
    if ($seconds -ge $IdleFloorSeconds) {
        Write-AmbientEvent -Path (Get-AmbientLogPath) -Kind "idle" -At $script:lastInputWall -Seconds $seconds
        Write-Host ("[{0}] idle {1:N0} min (from {2:HH:mm:ss})" -f (Get-Date -Format "HH:mm:ss"), ($seconds / 60), $script:lastInputWall)
    }
}

function Close-CurrentBlock {
    param(
        [Parameter(Mandatory)] $Block,
        [Parameter(Mandatory)] [string]$Path,
        # When the block stopped being observed. Defaults to now, which is right for every
        # ordinary close; the suspend path passes the last tick before the gap instead, so a
        # block that was open when the machine slept records the time it was actually
        # watched rather than the wall-clock span up to the moment someone came back.
        [datetime]$EndedAt = (Get-Date)
    )
    $dwell = [int]($EndedAt - $Block.startedAt).TotalSeconds
    if ($dwell -lt 0) { $dwell = 0 }
    # activeMs accumulates in real elapsed milliseconds, not whole-tick counts — the
    # clamp to dwell is the same invariant as before, just at finer resolution.
    $activeSeconds = [Math]::Min($dwell, [int]($Block.activeMs / 1000))
    Write-AmbientBlock -Path $Path -App $Block.app -Title $Block.title `
        -StartedAt $Block.startedAt -DwellSeconds $dwell -ActiveSeconds $activeSeconds -Snapshots $Block.snapshots
    return $dwell
}

try {
    while ($true) {
        Start-Sleep -Seconds $tickSeconds

        if (Test-Path (Get-StopFlagPath)) {
            Remove-Item (Get-StopFlagPath) -Force -ErrorAction SilentlyContinue
            Write-Host "Stop flag found. Shutting down cleanly."
            break
        }

        # Milliseconds actually elapsed since the previous tick, not the nominal
        # $tickSeconds — a slow tick (Get-VisibleText's own 1500ms deadline, a system
        # hiccup) is attributed correctly instead of being silently lost or double
        # counted, the way a fixed-tick model would.
        $now = [Environment]::TickCount
        $elapsedMs = if ($null -ne $lastTickAt) { $now - $lastTickAt } else { $tickSeconds * 1000 }
        # [Environment]::TickCount wraps every ~49.7 days of uptime; treat a negative
        # delta as one nominal tick rather than a nonsensical elapsed duration — the same
        # trade-off Get-IdleMilliseconds already makes for the same reason.
        if ($elapsedMs -lt 0) { $elapsedMs = $tickSeconds * 1000 }
        $lastTickAt = $now
        $wallNow = Get-Date

        # The machine was asleep (or the process otherwise suspended) between the previous
        # tick and this one.
        #
        # Both of this loop's clocks lie about that stretch, in opposite directions, and
        # the combination is what made an overnight sleep read as a full working night:
        # GetTickCount keeps counting through sleep, so $elapsedMs spans the whole night,
        # while the loop plainly did not run — the block it left open collected no content
        # snapshots for nine hours. Worse, the keypress that wakes the machine lands inside
        # this one tick, so $inputHappened is true and the entire night would be added to
        # activeMs in a single go and then clamped to dwell. That is how nine hours of sleep
        # became "9.01h with input" on a Facebook tab.
        #
        # So: end the open block at the last moment it was actually watched, credit nothing
        # as active, and drop the input baseline so the wake event cannot be read as input
        # spanning the gap. The sleep then belongs to no block at all, which makes it an
        # untracked gap downstream — bare track on the day band. That is the honest
        # description: not idle, not away, not observed.
        if ($elapsedMs -gt $suspendThresholdMs) {
            if ($null -ne $current) {
                $dwell = Close-CurrentBlock -Block $current -Path (Get-AmbientLogPath) -EndedAt $lastSeenAt
                $blocksWritten++
                # Plain ASCII on purpose: this string reaches a console whose codepage is
                # not ours to assume, unlike the comments around it which only ever have to
                # survive the parser.
                Write-Host ("[{0}] {1,-10} {2}  (closed at {3:HH:mm:ss}, {4}s - asleep {5:N0} min, not counted)" -f `
                    (Get-Date -Format "HH:mm:ss"), $current.app, $current.title, $lastSeenAt, $dwell, ($elapsedMs / 60000))
                $current = $null
            }
            # The idle run that was open when the machine went down ends where observation
            # did; the sleep itself is written as away time, so the app can draw it as such
            # rather than inferring it from a hole.
            Close-IdleRun -EndedAt $lastSeenAt
            if ($null -ne $lockedSince) {
                # Locked, then slept: one away stretch from the lock, not two.
                Write-AmbientEvent -Path (Get-AmbientLogPath) -Kind "away" -At $lockedSince -Seconds ([int]($wallNow - $lockedSince).TotalSeconds) -Why "lock"
                $lockedSince = $null
            } else {
                Write-AmbientEvent -Path (Get-AmbientLogPath) -Kind "away" -At $lastSeenAt -Seconds ([int]($wallNow - $lastSeenAt).TotalSeconds) -Why "sleep"
            }
            $lockPolls = 0
            $lockCandidateAt = $null
            $lastSeenAt = $wallNow
            $lastInputAt = $null
            $lastInputWall = $null
            $msSincePoll = 0
            continue
        }

        $lastSeenAt = $wallNow
        $msSincePoll += $elapsedMs
        $msSinceLive += $elapsedMs

        # Active means "at least one input event landed since the last tick", detected by
        # a change in the absolute tick of the last event rather than a threshold — exact,
        # nothing to tune, and still strictly presence/timing: GetLastInputInfo reports
        # only *when* the last event happened, never *what* it was.
        $idleMs = Get-IdleMilliseconds
        $inputAt = $now - $idleMs
        $inputHappened = ($null -ne $lastInputAt) -and ($inputAt -ne $lastInputAt)
        $lastInputAt = $inputAt
        $inputWall = $wallNow.AddMilliseconds(-$idleMs)

        if ($inputHappened) {
            # The stretch between the previous input event and this one is one idle run;
            # only the long ones are worth a line.
            Close-IdleRun -EndedAt $inputWall
        }
        if ($null -eq $lockedSince) { $lastInputWall = $inputWall }

        if ($null -ne $current) {
            if ($inputHappened) { $current.activeMs += $elapsedMs }
            $current.msSinceContent += $elapsedMs
        }

        if ($msSincePoll -lt ($pollSeconds * 1000)) { continue }
        $msSincePoll = 0

        $log = Get-AmbientLogPath  # re-derive each poll so the file rolls over at midnight
        $seen = Get-ForegroundWindowInfo

        # Lock detection. Three signals, any one of which means nobody is at this desktop:
        # the interactive desktop is not "Default" (the lock screen, the sign-in screen),
        # the lock screen's own app is in front, or there has been no foreground window at
        # all for several polls. A locked session used to look exactly like a window left
        # open: the block in front kept accruing dwell for the whole lock, so three hours
        # locked read as three hours tracked with no input. It is away time, and it is
        # written as such.
        if ($null -eq $seen) { $nullPolls++ } else { $nullPolls = 0 }
        $looksLocked = (Test-SecureDesktop) -or ($nullPolls -ge 3) -or `
            ($null -ne $seen -and ($seen.app -eq "LockApp" -or $seen.app -eq "LogonUI"))
        if ($looksLocked) {
            if ($lockPolls -eq 0) { $lockCandidateAt = $wallNow }
            $lockPolls++
            if ($null -eq $lockedSince -and $lockPolls -ge $LockPollsToConfirm) {
                $lockedSince = $lockCandidateAt
                if ($null -ne $current) {
                    $dwell = Close-CurrentBlock -Block $current -Path $log -EndedAt $lockedSince
                    $blocksWritten++
                    Write-Host ("[{0}] {1,-10} {2}  (closed at {3:HH:mm:ss}, {4}s - session locked)" -f `
                        (Get-Date -Format "HH:mm:ss"), $current.app, $current.title, $lockedSince, $dwell)
                    $current = $null
                }
                Close-IdleRun -EndedAt $lockedSince
                $lastInputWall = $null
            }
            continue
        }
        $lockPolls = 0
        $lockCandidateAt = $null
        if ($null -ne $lockedSince) {
            $awaySeconds = [int]($wallNow - $lockedSince).TotalSeconds
            Write-AmbientEvent -Path $log -Kind "away" -At $lockedSince -Seconds $awaySeconds -Why "lock"
            Write-Host ("[{0}] unlocked - away {1:N0} min (locked at {2:HH:mm:ss})" -f (Get-Date -Format "HH:mm:ss"), ($awaySeconds / 60), $lockedSince)
            $lockedSince = $null
            # The unlock keypress must not be read as the end of an idle run spanning the lock.
            $lastInputAt = $null
            $lastInputWall = $null
        }
        if ($null -eq $seen) { continue }

        if ($null -eq $current -or $current.app -ne $seen.app -or $current.title -ne $seen.title) {
            if ($null -ne $current) {
                $dwell = Close-CurrentBlock -Block $current -Path $log
                $blocksWritten++
                Write-Host ("[{0}] {1,-10} {2}  ({3} blocks written)" -f `
                    (Get-Date -Format "HH:mm:ss"), $current.app, $current.title, $blocksWritten)
            }
            # msSinceContent starts already at the threshold so a brand-new block always
            # gets its first extraction attempt on the very poll that creates it, the same
            # as the old "$null -eq $current.content" immediate-extraction behaviour.
            $current = @{ app = $seen.app; title = $seen.title; startedAt = Get-Date; activeMs = 0; snapshots = (New-Object System.Collections.ArrayList); msSinceContent = [double]($contentSeconds * 1000) }
            # The new block goes into live.json on this same poll, below, once its first
            # extraction is in, so a switch shows up in the app without waiting a cycle.
            $msSinceLive = [double]($liveSeconds * 1000)
        }

        if (Test-ContentEnabled -App $seen.app) {
            if ($current.msSinceContent -ge ($contentSeconds * 1000)) {
                $extracted = Get-VisibleText -Hwnd $seen.handle
                # Some apps' accessibility trees don't populate for an unregistered caller
                # (notably Chromium-based browsers, which gate this behind their own
                # accessibility setting) — the walk still "succeeds" but returns nothing
                # beyond the window title itself. Storing that would look like real
                # content while carrying none, so treat "not meaningfully longer than the
                # title" as no extraction rather than a fake win.
                if ($null -ne $extracted -and $extracted.Trim().Length -gt ($seen.title.Length + 15)) {
                    $snapshotCount = $current.snapshots.Count
                    $lastSnapshot = if ($snapshotCount -gt 0) { $current.snapshots[$snapshotCount - 1] } else { $null }
                    # A static screen re-sampled 30s later shouldn't cost anything —
                    # dedup at the source rather than passing an identical snapshot down
                    # the pipeline for the reader to notice and discard later.
                    if ($null -eq $lastSnapshot -or $lastSnapshot.text -ne $extracted) {
                        $stamp = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
                        [void]$current.snapshots.Add(@{ t = $stamp; text = $extracted; json = (Format-AmbientSnapshot -Stamp $stamp -Text $extracted) })
                        if ($current.snapshots.Count -gt $maxSnapshotsPerBlock) {
                            # Drop the second-oldest, never the newest and never the
                            # first — a 3-hour block should still show how it opened, not
                            # just its most recent moments.
                            $current.snapshots.RemoveAt(1)
                        }
                    }
                }
                $current.msSinceContent = 0
            }
        }

        if ($msSinceLive -ge ($liveSeconds * 1000)) {
            Write-AmbientLive -Block $current -IdleSince $lastInputWall
            $msSinceLive = 0
        }
    }
} finally {
    # Flush whatever block was still open when Ctrl+C landed, so the last few minutes
    # of a session are never silently lost. Same for an open idle run and an open lock.
    if ($null -ne $current) {
        Close-CurrentBlock -Block $current -Path (Get-AmbientLogPath) | Out-Null
        $blocksWritten++
    }
    if ($null -ne $lockedSince) {
        Write-AmbientEvent -Path (Get-AmbientLogPath) -Kind "away" -At $lockedSince -Seconds ([int]((Get-Date) - $lockedSince).TotalSeconds) -Why "lock"
    } else {
        Close-IdleRun -EndedAt (Get-Date)
    }
    # Everything the snapshot described is in the log now.
    Remove-AmbientLive
    Write-Host ""
    Write-Host "Stopped. $blocksWritten blocks written to $logPath"
}
