import { NextResponse } from "next/server";
import { round1 } from "@/lib/ambient/intervals";
import { threadTotals, type AmbientThreadLine } from "@/lib/ambient/threads";
import type { AmbientSearchDay, AmbientSearchResponse } from "@/lib/ambient/types";
import { loadConfig } from "../config";
import { shiftDays } from "../days";
import { readDigest } from "../digest";
import { loadProjects } from "../projects";
import { listLogDates, todayStamp } from "../store";

export const runtime = "nodejs";

/**
 * Where the time went on anything matching a query, across days: "how long have I spent on
 * the report", "when did I last open that course". Matches every word of `q`, ignoring
 * case, against what each stretch held — conversation, page and document names — and what
 * it was labelled — its sentence, its "what" and its project. A thread counts when it, or
 * the stretch it sits in, matches; threads tile their stretch, so nothing is counted twice.
 *
 * Measured, from the day digests (`digest.ts`); it never calls the model and needs no key.
 * `days` is how far back to look, 30 by default.
 */

const DEFAULT_DAYS = 30;
const MAX_DAYS = 366;
const MAX_STRETCHES = 20;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const query = (url.searchParams.get("q") ?? "").trim();
  if (query.length === 0) {
    return NextResponse.json({ status: "error", message: "Give something to search for." } satisfies AmbientSearchResponse, { status: 400 });
  }
  const rawDays = Number(url.searchParams.get("days"));
  const days = Number.isFinite(rawDays) && rawDays >= 1 ? Math.min(Math.floor(rawDays), MAX_DAYS) : DEFAULT_DAYS;

  try {
    const today = todayStamp();
    const from = shiftDays(today, -(days - 1));
    const [{ config }, projects, allDates] = await Promise.all([loadConfig(), loadProjects(), listLogDates()]);
    const names = Object.fromEntries(projects.file.projects.map((p) => [p.key, p.name]));
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const matches = (text: string) => {
      const haystack = text.toLowerCase();
      return terms.every((term) => haystack.includes(term));
    };

    const dates = allDates.filter((date) => date >= from && date <= today);
    const byDay: AmbientSearchDay[] = [];
    const hits: { threads: AmbientThreadLine[] }[] = [];
    const stretches: Extract<AmbientSearchResponse, { status: "ready" }>["stretches"] = [];
    let searched = 0;
    // One day at a time: each digest is small, but building a missing one parses a whole log.
    for (const date of dates) {
      const digest = await readDigest(date, config.afkSeconds, config.breakMinutes);
      if (!digest) continue;
      searched++;
      let minutes = 0;
      let activeMinutes = 0;
      for (const stretch of digest.stretches) {
        const context = [stretch.label ?? "", stretch.what, stretch.project, names[stretch.project] ?? ""].join(" ");
        const stretchMatches = matches(context);
        const matched = stretch.threads.filter((line) => !line.rest && (stretchMatches || matches(`${line.name} ${line.app} ${context}`)));
        // A stretch with no threads — time off the computer — counts whole when its words match.
        const restLine = stretch.threads.find((line) => line.rest);
        let stretchMinutes = matched.reduce((sum, line) => sum + line.minutes, 0) + (stretchMatches && restLine ? restLine.minutes : 0);
        let stretchActive = matched.reduce((sum, line) => sum + line.activeMinutes, 0) + (stretchMatches && restLine ? restLine.activeMinutes : 0);
        if (stretch.threads.length === 0 && stretchMatches) {
          stretchMinutes = stretch.minutes;
          stretchActive = stretch.activeMinutes;
        }
        if (stretchMinutes <= 0) continue;
        minutes += stretchMinutes;
        activeMinutes += stretchActive;
        hits.push({ threads: matched });
        if (stretch.label) {
          stretches.push({ date, from: stretch.from, to: stretch.to, project: stretch.project, label: stretch.label, what: stretch.what, minutes: round1(stretchMinutes) });
        }
      }
      if (minutes > 0) byDay.push({ date, minutes: round1(minutes), activeMinutes: round1(activeMinutes) });
    }

    byDay.sort((a, b) => b.date.localeCompare(a.date));
    stretches.sort((a, b) => b.from.localeCompare(a.from));
    return NextResponse.json({
      status: "ready",
      query,
      from: dates[0] ?? from,
      to: dates[dates.length - 1] ?? today,
      daysSearched: searched,
      minutes: round1(byDay.reduce((sum, day) => sum + day.minutes, 0)),
      activeMinutes: round1(byDay.reduce((sum, day) => sum + day.activeMinutes, 0)),
      byDay,
      threads: threadTotals(hits, 10),
      stretches: stretches.slice(0, MAX_STRETCHES),
      projectNames: names,
    } satisfies AmbientSearchResponse);
  } catch (error) {
    return NextResponse.json({
      status: "error",
      message: error instanceof Error ? error.message : "The search failed.",
    } satisfies AmbientSearchResponse);
  }
}
