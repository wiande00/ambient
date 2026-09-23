import { NextResponse } from "next/server";
import { FALLBACK_BUCKETS, isFallbackBucket } from "@/lib/ambient/projects";
import type { AmbientOffComputerResponse } from "@/lib/ambient/types";
import { activeSession, readOffComputer, startOffComputer, stopOffComputer } from "../offComputer";
import { loadProjects } from "../projects";
import { todayStamp } from "../store";

export const runtime = "nodejs";

/**
 * The "working off computer" switch. `GET` says whether a session is running and lists
 * today's; `PUT {on: true, project, note}` starts one (closing any still open) and
 * `PUT {on: false}` ends it. Nothing here touches the collector: the session is folded in
 * when the day is measured.
 */

async function describe(): Promise<AmbientOffComputerResponse> {
  const [file, projects] = await Promise.all([readOffComputer(), loadProjects()]);
  const today = todayStamp();
  const [y, m, d] = today.split("-").map(Number);
  const dayStartMs = new Date(y, m - 1, d).getTime();
  return {
    status: "ready",
    active: activeSession(file),
    today: file.sessions.filter((session) => new Date(session.to ?? Date.now()).getTime() >= dayStartMs),
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
  const b = body && typeof body === "object" ? (body as { on?: unknown; project?: unknown; note?: unknown }) : {};
  if (typeof b.on !== "boolean") {
    return NextResponse.json({ status: "error", message: "Expected on: true or false." } satisfies AmbientOffComputerResponse, { status: 400 });
  }

  try {
    if (b.on) {
      const project = typeof b.project === "string" && b.project.trim() ? b.project.trim() : "other";
      const projects = await loadProjects();
      if (!isFallbackBucket(project) && !projects.file.projects.some((p) => p.key === project)) {
        const known = [...projects.file.projects.map((p) => p.key), ...FALLBACK_BUCKETS].join(", ");
        return NextResponse.json({ status: "error", message: `Unknown project "${project}". Known: ${known}.` } satisfies AmbientOffComputerResponse, { status: 400 });
      }
      await startOffComputer(project, typeof b.note === "string" ? b.note : "");
    } else {
      await stopOffComputer();
    }
    return NextResponse.json(await describe());
  } catch (error) {
    return NextResponse.json({ status: "error", message: error instanceof Error ? error.message : "Failed to save." } satisfies AmbientOffComputerResponse);
  }
}
