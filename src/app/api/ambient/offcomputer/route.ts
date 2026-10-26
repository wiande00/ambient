import { NextResponse } from "next/server";
import { sessionEndMs, settledSession } from "@/lib/ambient/offComputer";
import { FALLBACK_BUCKETS, isFallbackBucket } from "@/lib/ambient/projects";
import type { AmbientOffComputerResponse } from "@/lib/ambient/types";
import { activeSession, readOffComputer, setOffComputerUntil, startOffComputer, stopOffComputer } from "../offComputer";
import { loadProjects } from "../projects";
import { todayStamp } from "../store";

export const runtime = "nodejs";

/**
 * The "working off computer" switch. `GET` says whether a session is running and lists
 * today's; `PUT {on: true, project, note, until?}` starts one (closing any still open),
 * `PUT {on: false}` ends it, and `PUT {until}` gives the running one a stop time, or takes
 * it away with null. `until` is an ISO time in the future. Nothing here touches the
 * collector: the session is folded in when the day is measured.
 */

async function describe(): Promise<AmbientOffComputerResponse> {
  const [file, projects] = await Promise.all([readOffComputer(), loadProjects()]);
  const today = todayStamp();
  const [y, m, d] = today.split("-").map(Number);
  const dayStartMs = new Date(y, m - 1, d).getTime();
  const nowMs = Date.now();
  return {
    status: "ready",
    active: activeSession(file, nowMs),
    today: file.sessions.filter((session) => sessionEndMs(session, nowMs) >= dayStartMs).map((session) => settledSession(session, nowMs)),
    projects: projects.file.projects.map((p) => ({ key: p.key, name: p.name })),
  };
}

export async function GET() {
  try {
    return NextResponse.json(await describe());
  } catch (error) {
    return NextResponse.json({ status: "error", message: error instanceof Error ? error.message : "Failed to load." } satisfies AmbientOffComputerResponse);
  }
}

export async function PUT(request: Request) {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return NextResponse.json({ status: "error", message: "Expected JSON." } satisfies AmbientOffComputerResponse, { status: 415 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ status: "error", message: "The body is not valid JSON." } satisfies AmbientOffComputerResponse, { status: 400 });
  }
  const b = body && typeof body === "object" ? (body as { on?: unknown; project?: unknown; note?: unknown; until?: unknown }) : {};
  const settingUntil = b.on === undefined && "until" in b;
  if (typeof b.on !== "boolean" && !settingUntil) {
    return NextResponse.json({ status: "error", message: "Expected on: true or false, or until." } satisfies AmbientOffComputerResponse, { status: 400 });
  }
  // A stop time must be a time still to come: one already past would end the session as it began.
  let untilMs: number | null = null;
  if (b.until !== undefined && b.until !== null) {
    untilMs = typeof b.until === "string" ? Date.parse(b.until) : NaN;
    if (!Number.isFinite(untilMs) || untilMs <= Date.now()) {
      return NextResponse.json({ status: "error", message: "The stop time must be an ISO time in the future." } satisfies AmbientOffComputerResponse, { status: 400 });
    }
  }

  try {
    if (settingUntil) {
      const running = await setOffComputerUntil(untilMs);
      if (!running) {
        return NextResponse.json({ status: "error", message: "No session is running to give a stop time." } satisfies AmbientOffComputerResponse, { status: 409 });
      }
    } else if (b.on) {
      const project = typeof b.project === "string" && b.project.trim() ? b.project.trim() : "other";
      const projects = await loadProjects();
      if (!isFallbackBucket(project) && !projects.file.projects.some((p) => p.key === project)) {
        const known = [...projects.file.projects.map((p) => p.key), ...FALLBACK_BUCKETS].join(", ");
        return NextResponse.json({ status: "error", message: `Unknown project "${project}". Known: ${known}.` } satisfies AmbientOffComputerResponse, { status: 400 });
      }
      await startOffComputer(project, typeof b.note === "string" ? b.note : "", untilMs);
    } else {
      await stopOffComputer();
    }
    return NextResponse.json(await describe());
  } catch (error) {
    return NextResponse.json({ status: "error", message: error instanceof Error ? error.message : "Failed to save." } satisfies AmbientOffComputerResponse);
  }
}
