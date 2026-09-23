export const en = {
  ambient: {
    meta: {
      title: "Ambient",
      description: "Where the hours went, from the window that had focus.",
    },
    nav: {
      day: "Day",
      week: "Week",
      settings: "Settings",
      /** Above the three screen buttons. */
      heading: "Views",
      /** The switch in the title bar names the mode it would move to, not the one in use. */
      toLight: "Light",
      toDark: "Dark",
      collector: {
        heading: "Collector",
        /** {time} is a clock time. */
        running: "Running since {time}",
        stopped: "Stopped",
        /** {seconds} until the next attempt. */
        restarting: "Restarting in {seconds} s",
        unmanaged: "Not managed by this app",
        /** {version} is the running build. The second half is the whole point of the app. */
        privacy: "v{version} · nothing leaves this machine",
        /** In a browser there is no shell to ask, so the card says where it does run. */
        web: "Runs with the desktop app",
      },
    },
    error: {
      title: "Something failed.",
    },
    empty: {
      title: "Nothing tracked yet.",
      body: "Leave the collector running while you work. The first figures appear once a window has held focus for a while.",
      /** Shown in a browser only; the desktop app runs the collector itself. */
      bodyWeb: "Start the collector and leave it running while you work, then reload this page.",
      command: "powershell -File collector/collect.ps1",
      pathLabel: "It writes to:",
    },
    emptyDay: {
      title: "Not observed.",
      body: "The collector wasn't running on this day, or its log has since been removed. Untracked time isn't idle time — it was simply not observed.",
    },
    day: {
      /** Above the date. The day screen opens on today and says so. */
      eyebrowToday: "Today",
      eyebrowPast: "Day",
      /** Follows the observed span on the same line. */
      since: "tracking since {since}",
      /** Over the band. */
      shape: "The shape of the day",
      /** Beside that heading: the observed span, set in mono. */
      shapeRange: "{from} → {to}",
      legend: {
        idle: "Idle",
        away: "Away",
      },
      nav: {
        label: "Day",
        previous: "Previous day",
        next: "Next day",
        today: "Today",
      },
      active: "active",
      idle: "idle",
      away: "away",
      /** Under the headline: the observed span. */
      span: "Observed {from}–{to}",
      /**
       * Shown when any idle figure came from the estimate for logs written before the
       * collector recorded idle runs. Names the limitation rather than hiding it.
       */
      estimatedNote: "Idle is estimated for this day: its log predates idle recording, so each window's input-free time is assumed to be one stretch.",
    },
    offComputer: {
      label: "Working off computer",
      hint: "Pen and paper, a book, a whiteboard. While this is on, the time counts as active work on the project you pick, whatever the screen shows.",
      project: "Project",
      note: "What (optional)",
      notePlaceholder: "e.g. chapter 4 exercises",
      /** {time} is a clock time, {project} the project name. */
      since: "Off computer since {time} · {project}",
      /** Follows `since` while the switch is on. */
      onHint: "This time counts as active work however long the keyboard is untouched.",
      /** {message} is the server's reason. */
      failed: "Could not save: {message}",
    },
    labels: {
      /** Shown while the model is still labelling. Pending is not absence and must not read as one. */
      pending: "Working out what this was…",
      noKey: "Add your Anthropic API key in Settings to label this stretch.",
      unavailable: "Not labelled yet.",
      notLabelled: "Not labelled",
      /** Under an unlabelled stretch: ask the model now instead of waiting for the next label. */
      labelNow: "Label now",
      labelNowHint: "Ask the model what this was now, rather than waiting for the stretch to grow. One call, about a cent.",
      /** The model answered, but not in a shape that fits the stretch. */
      labelRejected: "The answer did not fit this stretch. Try again in a moment.",
      /** {message} is the reason the call failed. */
      labelFailed: "Could not label: {message}",
      unclear: "Unclear from the screen",
      /** e.g. "2h 10 active · 25 min idle". */
      activeIdle: "{active} active · {idle} idle",
    },
    band: {
      label: "The day, hour by hour",
      /** Clock range of one segment, e.g. "12:07–12:47". An en dash, not a hyphen. */
      range: "{from}–{to}",
      breakLabel: "Break — idle",
      lock: "Locked",
      sleep: "Asleep",
      unobserved: "Not observed",
      /** A stretch the person took out of the day. */
      removed: "Removed",
      quickSwitching: "Quick switching",
    },
    chunks: {
      heading: "What you did",
      range: "{from}–{to}",
      breakRow: "Break · {duration} idle",
      /** e.g. "Locked · 1h 18". */
      awayRow: "{why} · {duration}",
      /** Under the sentence, when the stretch had idle time in it. */
      idleIn: "{duration} idle",
      /** {name} is another project inside the same stretch, {duration} its active time there. */
      alsoProject: "also {name} {duration}",
      /** The share of the stretch that was active, as a bar. */
      activeShare: "{active} active of {total}",
    },
    /** Correcting the day by hand: editing a chunk, adding one, taking one out. */
    edit: {
      /** Beside the list's heading. */
      add: "Add a stretch",
      /** On a break or a gap: say what that time really was. */
      addHere: "Add",
      /** {range} is a clock range. */
      addHereLabel: "Add what you did {range}",
      /** The pencil on a chunk. */
      editLabel: "Edit this stretch",
      /** Under an edited chunk's sentence, where the evidence would be. */
      edited: "Edited by you",
      /** On a removed stretch's row. */
      restore: "Restore",
      from: "From",
      to: "To",
      project: "Project",
      sentence: "What you did",
      sentencePlaceholder: "e.g. Worked through chapter 4 on paper",
      countActive: "Count the idle time as active",
      countActiveHint: "For time spent on paper or in a book while the keyboard sat untouched.",
      /** Under an added stretch's fields. */
      addHint: "Counts as active work on this project, whatever the screen showed.",
      save: "Save",
      saving: "Saving…",
      cancel: "Cancel",
      delete: "Delete",
      /** On an edited chunk: back to what Ambient measured and the model said. */
      undo: "Undo my edit",
      invalidRange: "The end has to be after the start.",
      sentenceRequired: "Say what you did.",
      /** {message} is the server's reason. */
      failed: "Could not save: {message}",
    },
    projects: {
      heading: "By project",
      rowTitle: "{active} active, {idle} idle",
      /** Under a bar on the day screen: how much of the day's active time this project holds. */
      share: "{percent}% of active",
      buckets: {
        personal: "Personal",
        admin: "Admin",
        other: "Other",
      },
      none: "No projects yet. Add ~/.ambient/projects.json to total hours per project — see projects.example.json.",
      fileError: "projects.json: {message}",
    },
    week: {
      /** e.g. "26 August–1 September". */
      range: "{from}–{to}",
      /** Above the date range. */
      eyebrowThis: "This week",
      eyebrowPast: "Week",
      active: "active",
      idle: "idle",
      /** The third figure: active hours divided by the days that were observed. */
      average: "average day",
      /** Over the seven bars. */
      byProject: "Seven days, by project",
      /** {duration} is the tallest day's tracked time, which the bars are drawn against. */
      tallest: "Tallest day {duration}",
      /** Over the per-project totals. */
      whereWent: "Where the week went",
      /** The callout under the week. */
      worthKnowing: "Worth knowing",
      /** {date} is a weekday, {duration} its active time. */
      longest: "{date} was the longest day at {duration} active.",
      /** Said plainly, because a zero bar and an unobserved day mean very different things. */
      unobservedNote: "A day with no bar isn't a zero — the collector wasn't running, so it was never observed.",
      /** e.g. "6 days observed · 1 day the collector wasn't running". */
      observedDays: "{count} days observed",
      observedOne: "1 day observed",
      missingDays: "{count} days the collector wasn't running",
      missingOne: "one day the collector wasn't running",
      nav: {
        label: "Week",
        previous: "Previous week",
        next: "Next week",
        thisWeek: "This week",
      },
      empty: "Nothing tracked in these seven days.",
      notObserved: "Not observed",
      unlabelled: "{duration} on {count} days isn't labelled yet. Open a day to label it.",
      unlabelledOne: "{duration} on 1 day isn't labelled yet. Open it to label it.",
      /** Per-bar tooltip. */
      bar: "{date}: {active} active, {idle} idle, {away} away",
    },
    /** The banner across the top of every screen once a newer build is verified and waiting. */
    updateBanner: {
      /** {version} is the newer version. */
      title: "Ambient {version} is ready to install.",
      body: "Updating restarts Ambient. The collector writes what it has first, so nothing tracked is lost.",
      install: "Update now",
      later: "Later",
      /** {version} is the version being installed. */
      installing: "Installing Ambient {version}. It will restart in a moment.",
    },
    settings: {
      title: "Settings",
      loading: "Loading settings…",
      apiKey: {
        label: "Anthropic API key",
        hintUnset:
          "Optional. Without it every measured figure still shows; only the sentence and project per chunk are absent. Stored on this machine and sent only to the Anthropic API.",
        /** {masked} is the recognisable part of the key. */
        hintSet: "A key is set ({masked}). Paste a new one to replace it.",
        hintEnv: "A key is set in the environment (.env.local). Saving one here overrides it.",
        placeholder: "sk-ant-…",
        clear: "Remove the key",
        keep: "Keep the key",
      },
      afk: {
        label: "Idle after",
        unit: "seconds",
        hint:
          "Seconds without input after which the stretch since the last input counts as idle. Measured figures update on the next load. A day already labelled keeps its chunks until the day has changed enough to be worth relabelling.",
        /** {min} and {max} are the allowed bounds. */
        invalid: "A whole number between {min} and {max}.",
      },
      breakAfter: {
        label: "Break after",
        unit: "minutes",
        hint:
          "How long you have to be away from the machine for it to count as a break and end a chunk, rather than a pause inside one. Applies whether the screen locked or a window simply sat there untouched. Lower it and short breaks show as their own rows; raise it and they fold into the work around them. Days whose stretches this moves are relabelled on the next load.",
        /** {min} and {max} are the allowed bounds. */
        invalid: "A whole number between {min} and {max}.",
      },
      openAtLogin: {
        label: "Start Ambient when I sign in to Windows",
        hint: "Opens the dashboard and starts the collector at sign-in.",
        desktopOnly: "Available in the desktop app only.",
        overridden: "Windows has turned this off in Settings › Apps › Startup. Turn it on there for this to take effect.",
      },
      excludeApps: {
        label: "Never read text from these apps",
        hint: "Process names, comma-separated. Password managers are excluded by default. Changing this restarts the collector.",
      },
      collector: {
        label: "Collector",
        /** {pid} and {since}: process id and a clock time. */
        running: "Running (pid {pid}) since {since}",
        stopped: "Stopped",
        /** {seconds} until the next attempt, {attempt} how many so far. */
        restarting: "Restarting in {seconds} s (attempt {attempt})",
        disabled: "Not managed by this app",
        restart: "Restart collector",
        /** {dir} is the folder with the collector and server logs. */
        logs: "Logs in {dir}",
      },
      update: {
        label: "Version",
        /** {current} is the running version. */
        current: "Ambient {current}",
        notChecked: "Not checked yet.",
        checking: "Checking for updates…",
        /** {time} is a clock time. */
        upToDate: "Up to date (checked {time}).",
        /** {version} is the newer version waiting. */
        ready: "Ambient {version} is ready to install.",
        installing: "Installing Ambient {version}…",
        /** {message} says what went wrong. */
        error: "Could not check for updates: {message}",
        check: "Check for updates",
        /** {version} is the newer version. */
        install: "Update to {version}",
        /** {dir} is the folder downloaded updates wait in. */
        channel: "Ambient checks GitHub for a new release every fifteen minutes and downloads it to {dir}.",
        desktopOnly: "Available in the desktop app only.",
      },
      connector: {
        label: "Claude connector",
        hint: "An MCP server that lets Claude read where your hours went and add, edit or remove projects. It talks to this app on this machine only, so Ambient has to be running.",
        desktopOnly: "Available in the desktop app only.",
        desktop: {
          "not-installed": "Claude Desktop is not set up on this machine.",
          absent: "Not added to Claude Desktop yet.",
          waiting:
            "Added. Quit Claude Desktop from its tray icon and open it again to load it. Until then Ambient keeps the entry in place, since Claude Desktop rewrites that file while it runs.",
          current: "Added to Claude Desktop.",
          outdated: "Claude Desktop points at an older copy. Add it again to refresh.",
          unreadable: "Claude Desktop's config file could not be read.",
        },
        install: "Add to Claude Desktop",
        installing: "Adding…",
        /** {message} says what went wrong. */
        failed: "Could not write the config: {message}",
        codeHint: "For Claude Code, run this once in a terminal:",
      },
      projects: {
        title: "Projects",
        intro:
          "What your hours are totalled against. The model reads the description and hints to decide which project a stretch belongs to. Saving relabels each day the next time it is opened; a removed project's hours move to Other.",
        loading: "Loading projects…",
        /** {path} is the projects file. */
        storedAt: "Stored in {path}",
        /** {message} is why the file could not be read. */
        fileError: "The projects file could not be read: {message}. Saving here replaces it.",
        name: "Name",
        namePlaceholder: "e.g. Thesis",
        /** {key} is the identifier chunks refer to. */
        key: "Key: {key}",
        description: "What it is",
        descriptionPlaceholder: "One or two sentences on what work on this looks like.",
        hints: "Hints",
        hintsHint: "Words, window titles, paths, product names, comma-separated.",
        remove: "Remove",
        add: "Add a project",
        empty: "No projects yet. Everything lands in Personal, Admin or Other until you add one.",
        nameRequired: "Every project needs a name.",
        save: "Save projects",
        saving: "Saving…",
        saved: "Saved.",
        /** {message} is the server's reason. */
        failed: "Could not save: {message}",
      },
      /** {path} is the settings file. */
      storedAt: "Stored in {path}",
      save: "Save",
      saving: "Saving…",
      saved: "Saved.",
      /** {message} is the server's reason. */
      failed: "Could not save: {message}",
    },
  },
} as const;

export type Strings = typeof en;
