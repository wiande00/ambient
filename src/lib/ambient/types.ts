import type { AmbientCandidate, AmbientChunk, AmbientDaySegment, AmbientProjectTotal } from "./chunks";
import type { ChunkEdit } from "./edits";
import type { AmbientDayTotals } from "./intervals";
import type { OffComputerSession } from "./offComputer";
import type { AmbientProject } from "./projects";
import type { AmbientTimeline } from "./timeline";

/**
 * The shapes the three routes answer with, shared between each route handler and the
 * screen that renders it. Everything in `day` and `week` is measured — arithmetic over the
 * collector's own log, no key and no network needed. `chunks` is the one interpreted
 * response, and the screens are built to stand without it.
 */

/** `/api/ambient/day` — one day, measured. */
export type AmbientDayResponse =
  | {
      status: "ready";
      date: string;
      /** Today's actual local date, so the view can tell whether it is looking at the past. */
      today: string;
      /** Every date with a log, ascending. */
      days: string[];
      totals: AmbientDayTotals & { from: string; to: string };
      /** The day in order: candidates, breaks and away gaps. */
      segments: AmbientDaySegment[];
      candidates: Omit<AmbientCandidate, "blocks">[];
      band: AmbientTimeline | null;
      format: 1 | 2;
    }
  | { status: "empty"; date: string; today: string; days: string[] }
  | { status: "error"; message: string };

/** What one day's labelling has cost so far: every model call summed, with the price worked out at the model's rates. */
export type AmbientLabelUsage = {
  calls: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  estimated_usd: number;
};

/** `/api/ambient/chunks` — the day's chunks, labelled by the model, plus per-project totals. */
export type AmbientChunksResponse =
  | {
      status: "ready";
      date: string;
      chunks: AmbientChunk[];
      projects: AmbientProjectTotal[];
      /** True when served from the on-disk cache without a model call in this request. */
      cached: boolean;
      /** Stretches the model has yet to label; they show as unlabelled until a call for them lands. */
      pending: number;
      /**
       * The candidates, by clock range, that show as unlabelled in whole or in part and that
       * "Label now" (`POST`) would send to the model. Empty without an API key.
       */
      unlabelled: { from: string; to: string }[];
      /** What this day's labels have cost, or null when nothing has been paid for yet. */
      usage: AmbientLabelUsage | null;
      /** Set when `~/.ambient/projects.json` exists but could not be used. */
      projectsError: string | null;
      /** Display name per project key from projects.json. Buckets are named by the UI. */
      projectNames: Record<string, string>;
    }
  | { status: "empty"; date: string }
  | { status: "not_configured" }
  | { status: "error"; message: string };

export type AmbientWeekDay =
  | { date: string; observed: false }
  | {
      date: string;
      observed: true;
      trackedMinutes: number;
      activeMinutes: number;
      idleMinutes: number;
      awayMinutes: number;
      estimatedIdle: boolean;
      /** Whether a chunk cache exists for the day, i.e. its hours are in the project totals. */
      labelled: boolean;
      /**
       * This day's hours split by project, so the bar can be stacked the way the week's
       * totals are coloured. Empty until the day has been labelled — the bar then draws its
       * active time as one unattributed block rather than claiming a project it doesn't know.
       */
      projects: AmbientProjectTotal[];
    };

/** `/api/ambient/projects` — the projects file as the Settings screen edits it. */
export type AmbientProjectsResponse =
  | {
      status: "ready";
      projects: AmbientProject[];
      /** Set when the file exists but could not be used; the list is then empty. */
      error: string | null;
      /** Where the file lives, for the screen to say so. */
      path: string;
    }
  | { status: "error"; message: string };

/** `/api/ambient/offcomputer` — the "working off computer" switch and today's sessions. */
export type AmbientOffComputerResponse =
  | {
      status: "ready";
      active: OffComputerSession | null;
      today: OffComputerSession[];
      /** For the project picker. Buckets are named by the UI. */
      projects: { key: string; name: string }[];
    }
  | { status: "error"; message: string };

/** `/api/ambient/edits` — the person's corrections touching one day, as stored. */
export type AmbientEditsResponse =
  | { status: "ready"; date: string; edits: ChunkEdit[] }
  | { status: "error"; message: string };

/** One past day the model has never been shown all of. */
export type AmbientUnclosedDay = {
  date: string;
  /** Stretches of it still waiting for a label. */
  candidates: number;
  /** Their tracked minutes: what is missing from the project totals until the day is closed. */
  minutes: number;
  /** False when the day was never labelled at all, rather than labelled and then grown past. */
  everLabelled: boolean;
};

/** `/api/ambient/unclosed` — past days with a stretch no chunk covers. Reads only; never calls the model. */
export type AmbientUnclosedResponse =
  | { status: "ready"; today: string; labellingConfigured: boolean; dates: AmbientUnclosedDay[] }
  | { status: "error"; message: string };

/** `/api/ambient/settings` — what is configured, without the key itself. */
export type AmbientSettingsResponse =
  | {
      status: "ready";
      hasApiKey: boolean;
      /** Enough of the key to recognise it; empty when none is set. */
      apiKeyMasked: string;
      apiKeySource: "config" | "env" | "default";
      afkSeconds: number;
      afkSource: "config" | "env" | "default";
      breakMinutes: number;
      breakSource: "config" | "env" | "default";
      openAtLogin: boolean;
      excludeApps: string[];
      /** Where the file lives, for the screen to say so. */
      configPath: string;
    }
  | { status: "error"; message: string };

/** `/api/ambient/week` — seven calendar days, measured, with project totals from cached chunks only. */
export type AmbientWeekResponse =
  | {
      status: "ready";
      from: string;
      to: string;
      today: string;
      days: AmbientWeekDay[];
      projects: AmbientProjectTotal[];
      /** Tracked minutes on observed days that have no chunk cache yet. */
      unlabelledMinutes: number;
      projectNames: Record<string, string>;
    }
  | { status: "error"; message: string };
