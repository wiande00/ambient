import { NextResponse } from "next/server";
import { daySegments, projectTotals, type AmbientChunk } from "@/lib/ambient/chunks";
import { dayShape, leftOnRanges, leftOnThreshold, markLeftOn, withoutLeftOn } from "@/lib/ambient/shape";
import { dayFocus } from "@/lib/ambient/focus";
import { attachThreads, dayThreadTotals, threadTotals, type AmbientThreadLine } from "@/lib/ambient/threads";
import type { AmbientWeekDay, AmbientWeekResponse } from "@/lib/ambient/types";
import { readChunkCache } from "../chunkCache";
import { loadConfig } from "../config";
import { loadDay, shiftDays, withEdits } from "../days";
import { loadProjects } from "../projects";
import { isValidDateStamp, todayStamp } from "../store";

export const runtime = "nodejs";

/**
 * The Monday-to-Sunday week (Swedish calendar) containing `?date=` (today by default):
 * measured totals per day — later days of the current week come back unobserved — and
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
    const anchor = requested ?? today;
    const from = mondayOf(anchor);
    const to = shiftDays(from, WINDOW_DAYS - 1);
    const dates = Array.from({ length: WINDOW_DAYS }, (_, i) => shiftDays(from, i));

    const allChunks: AmbientChunk[] = [];
    // Threads of every observed day: from the labelled chunks where there are some, so they
    // carry a project, and straight off the day where nobody has labelled it.
    const threadSources: { threads: AmbientThreadLine[] }[] = [];
    let unlabelledMinutes = 0;
    const { config } = await loadConfig();
    const [projects, days] = await Promise.all([
      loadProjects(),
      Promise.all(
        dates.map(async (date): Promise<AmbientWeekDay> => {
          const [day, cache] = await Promise.all([loadDay(date, config.afkSeconds), readChunkCache(date)]);
          if (!day || day.measure.intervals.length === 0) return { date, observed: false };
          // Left-on time out of idle and tracked, as on the day screen; the cut is untouched.
          const threshold = leftOnThreshold(config.breakMinutes);
          const leftOn = leftOnRanges(day.edited, threshold);
          const totals = withoutLeftOn(day.edited, leftOn);
          const shape = dayShape(markLeftOn(daySegments(day.edited, config.breakMinutes), leftOn), totals.activeMinutes, threshold);
          const chunks = cache ? attachThreads(withEdits(cache.chunks, day, config.breakMinutes), day.edited) : null;
          if (chunks) {
            allChunks.push(...chunks);
            threadSources.push(...chunks);
          } else {
            unlabelledMinutes += totals.trackedMinutes;
            threadSources.push({
              threads: dayThreadTotals(day.edited, Number.POSITIVE_INFINITY).map((total) => ({ ...total, project: "" })),
            });
          }
          const focus = dayFocus(day.edited);
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
            activeByHour: focus.activeByHour,
            focus: {
              firstActiveAt: focus.firstActiveAt,
              lastActiveAt: focus.lastActiveAt,
              switchesPerHour: focus.switchesPerHour,
              glanceShare: focus.glanceShare,
              meetingMinutes: focus.meetingMinutes,
              videoMinutes: focus.videoMinutes,
            },
            leftOnMinutes: totals.leftOnMinutes,
            shape,
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
      threads: threadTotals(threadSources),
    } satisfies AmbientWeekResponse);
  } catch (error) {
    return NextResponse.json({
      status: "error",
      message: error instanceof Error ? error.message : "The week failed to load.",
    } satisfies AmbientWeekResponse);
  }
}

/** The Monday on or before `stamp` — weeks run Monday to Sunday. */
function mondayOf(stamp: string): string {
  const [y, m, d] = stamp.split("-").map(Number);
  const sinceMonday = (new Date(y, m - 1, d).getDay() + 6) % 7;
  return shiftDays(stamp, -sinceMonday);
}
