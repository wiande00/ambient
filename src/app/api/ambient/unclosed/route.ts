import { NextResponse } from "next/server";
import { buildCandidates, toChunkInput } from "@/lib/ambient/chunks";
import { round1 } from "@/lib/ambient/intervals";
import type { AmbientUnclosedDay, AmbientUnclosedResponse } from "@/lib/ambient/types";
import { readChunkCache } from "../chunkCache";
import { loadConfig } from "../config";
import { loadDay } from "../days";
import { dueCandidates, keyCandidates, salvageLegacy, type LabelStore } from "../labelling";
import { loadProjects } from "../projects";
import { listLogDates, todayStamp } from "../store";

export const runtime = "nodejs";

/** How many days back a pass looks. A day older than this is left as it is. */
const DEFAULT_WINDOW = 7;
const MAX_WINDOW = 30;

/**
 * Which past days still have a stretch the model has never seen.
 *
 * A day is labelled only when someone opens it, because a model call costs money and the
 * week screen is not allowed to spend any. The consequence is quiet and easy to miss: a day
 * whose dashboard was last open at lunchtime has an afternoon that no chunk covers, so its
 * hours are in the day's own totals and in none of the project totals, and nothing says so.
 *
 * This route finds those days. It asks exactly the question the chunks route asks —
 * `dueCandidates` over the same candidates and the same cached labels — so "unclosed" here
 * means precisely "opening this day would call the model". It makes no call itself and needs
 * no key: it reads logs and caches and reports. The desktop shell runs it after it starts
 * and once an hour, and closes what it finds (`electron/day-closer.ts`).
 */
export async function GET(request: Request) {
  const raw = Number(new URL(request.url).searchParams.get("days"));
  const window = Number.isFinite(raw) && raw >= 1 ? Math.min(Math.floor(raw), MAX_WINDOW) : DEFAULT_WINDOW;

  try {
    const today = todayStamp();
    const { config } = await loadConfig();
    const projects = await loadProjects();
    // Today closes itself: its last stretch is still growing, and the chunks route already
    // re-labels it as it does. Only a day that has stopped moving can be finished.
    const dates = (await listLogDates()).filter((date) => date < today).slice(-window);

    const nowMs = Date.now();
    const unclosed: AmbientUnclosedDay[] = [];
    for (const date of dates) {
      const day = await loadDay(date, config.afkSeconds);
      if (!day || day.measure.intervals.length === 0) continue;
      const { candidates } = buildCandidates(day.measure, config.breakMinutes);
      const input = toChunkInput(candidates, projects.file.projects, config.afkSeconds);
      const keyed = keyCandidates(candidates, input, projects.raw);
      const cached = await readChunkCache(date);
      // The same reading the chunks route gives a cache, salvage of the older shape and all,
      // or a day whose labels only need carrying forward would be reported as needing a call.
      const labels: LabelStore = cached?.version === 4 ? cached.labels : cached ? salvageLegacy(cached, keyed) : {};
      const due = dueCandidates(keyed, labels, nowMs);
      if (due.length === 0) continue;
      unclosed.push({
        date,
        candidates: due.length,
        minutes: round1(due.reduce((sum, item) => sum + item.candidate.minutes, 0)),
        everLabelled: Object.keys(labels).length > 0,
      });
    }

    return NextResponse.json({
      status: "ready",
      today,
      labellingConfigured: config.anthropicApiKey.length > 0,
      dates: unclosed,
    } satisfies AmbientUnclosedResponse);
  } catch (error) {
    return NextResponse.json({
      status: "error",
      message: error instanceof Error ? error.message : "The unclosed days could not be read.",
    } satisfies AmbientUnclosedResponse);
  }
}
