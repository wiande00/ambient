import { NextResponse } from "next/server";
import { projectTotals, type AmbientChunk } from "@/lib/ambient/chunks";
import type { AmbientWeekDay, AmbientWeekResponse } from "@/lib/ambient/types";
import { readChunkCache } from "../chunkCache";
import { loadConfig } from "../config";
import { loadDay, shiftDays, withEdits } from "../days";
import { loadProjects } from "../projects";
import { isValidDateStamp, todayStamp } from "../store";

export const runtime = "nodejs";

/**
 * Seven calendar days ending on `?date=` (today by default): measured totals per day, and
 * project totals summed from whatever chunk caches exist. Never calls the model — the day
 * screen is where a day gets labelled — so a day nobody has opened contributes its hours to
 * the bars and to `unlabelledMinutes`, not to any project.
 */

const WINDOW_DAYS = 7;

export async function GET(request: Request) {
  const requested = new URL(request.url).searchParams.get("date");
  if (requested !== null && !isValidDateStamp(requested)) {
    return NextResponse.json({ status: "error", message: "Invalid date." } satisfies AmbientWeekResponse, { status: 400 });
  }

  try {
    const today = todayStamp();
    const to = requested ?? today;
    const from = shiftDays(to, -(WINDOW_DAYS - 1));
    const dates = Array.from({ length: WINDOW_DAYS }, (_, i) => shiftDays(from, i));

    const allChunks: AmbientChunk[] = [];
    let unlabelledMinutes = 0;
    const { config } = await loadConfig();
    const [projects, days] = await Promise.all([
      loadProjects(),
      Promise.all(
        dates.map(async (date): Promise<AmbientWeekDay> => {
          const [day, cache] = await Promise.all([loadDay(date, config.afkSeconds), readChunkCache(date)]);
          if (!day || day.measure.intervals.length === 0) return { date, observed: false };
          const totals = day.edited.totals;
          const chunks = cache ? withEdits(cache.chunks, day, config.breakMinutes) : null;
          if (chunks) allChunks.push(...chunks);
          else unlabelledMinutes += totals.trackedMinutes;
          return {
            date,
            observed: true,
            trackedMinutes: totals.trackedMinutes,
            activeMinutes: totals.activeMinutes,
            idleMinutes: totals.idleMinutes,
            awayMinutes: totals.awayMinutes,
            estimatedIdle: totals.estimatedIdle,
            labelled: chunks !== null,
            projects: chunks ? projectTotals(chunks) : [],
          };
        }),
      ),
    ]);

    return NextResponse.json({
      status: "ready",
      from,
      to,
      today,
      days,
      projects: projectTotals(allChunks),
      unlabelledMinutes: Math.round(unlabelledMinutes * 10) / 10,
      projectNames: Object.fromEntries(projects.file.projects.map((p) => [p.key, p.name])),
    } satisfies AmbientWeekResponse);
  } catch (error) {
    return NextResponse.json({
      status: "error",
      message: error instanceof Error ? error.message : "The week failed to load.",
    } satisfies AmbientWeekResponse);
  }
}
