import { NextResponse } from "next/server";
import { buildCandidates, toChunkInput } from "@/lib/ambient/chunks";
import { buildTimeline } from "@/lib/ambient/timeline";
import type { AmbientDayResponse } from "@/lib/ambient/types";
import { loadConfig } from "../config";
import { loadDay } from "../days";
import { loadProjects } from "../projects";
import { isValidDateStamp, listLogDates, todayStamp } from "../store";

export const runtime = "nodejs";

/**
 * Everything measured about one day: totals, the band, and the candidates the day cuts
 * into. No model call, no API key, no network — it paints in full from local disk alone.
 * All of it is the day with the person's edits applied, the same day the chunks are laid
 * over. `?debug=1` adds the exact input the labelling route would send, which is cut from
 * the day without them, for checking a cut against the log.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const requested = url.searchParams.get("date");
  if (requested !== null && !isValidDateStamp(requested)) {
    return NextResponse.json({ status: "error", message: "Invalid date." } satisfies AmbientDayResponse, { status: 400 });
  }
  const debug = url.searchParams.get("debug") === "1";

  try {
    const today = todayStamp();
    const date = requested ?? today;
    const { config } = await loadConfig();
    const [day, days] = await Promise.all([loadDay(date, config.afkSeconds), listLogDates()]);

    if (!day || day.measure.intervals.length === 0) {
      return NextResponse.json({ status: "empty", date, today, days } satisfies AmbientDayResponse);
    }

    const { candidates, segments } = buildCandidates(day.edited, config.breakMinutes);
    const band = buildTimeline(day.edited.intervals);
    // With every stretch removed there is nothing left to span; say what was observed.
    const span = day.edited.intervals.length > 0 ? day.edited : day.measure;

    const response: AmbientDayResponse = {
      status: "ready",
      date,
      today,
      days,
      totals: {
        ...day.edited.totals,
        from: new Date(span.firstMs).toISOString(),
        to: new Date(span.lastMs).toISOString(),
      },
      segments,
      candidates: candidates.map(({ blocks, ...rest }) => {
        void blocks;
        return rest;
      }),
      band,
      format: day.measure.format,
    };

    if (debug) {
      const projects = await loadProjects();
      const raw = day.edited === day.measure ? candidates : buildCandidates(day.measure, config.breakMinutes).candidates;
      return NextResponse.json({ ...response, input: toChunkInput(raw, projects.file.projects, config.afkSeconds) });
    }
    return NextResponse.json(response);
  } catch (error) {
    return NextResponse.json({
      status: "error",
      message: error instanceof Error ? error.message : "The day failed to load.",
    } satisfies AmbientDayResponse);
  }
}
