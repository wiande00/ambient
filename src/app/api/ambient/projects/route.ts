import { NextResponse } from "next/server";
import { parseProjectsFile, type AmbientProject } from "@/lib/ambient/projects";
import type { AmbientProjectsResponse } from "@/lib/ambient/types";
import { loadProjects, projectsPath, saveProjects } from "../projects";

export const runtime = "nodejs";

/**
 * The Settings screen's projects editor. `GET` returns the list as the file holds it, or
 * the reason the file could not be used. `PUT` takes the whole list, runs it through the
 * same validation the reader applies, and writes it back. Every route reads the file per
 * request and the chunk cache is keyed on its text, so a saved change relabels each day the
 * next time it is opened; nothing else needs restarting.
 */

function describe(projects: AmbientProject[], error: string | null): AmbientProjectsResponse {
  return { status: "ready", projects, error, path: projectsPath() };
}

export async function GET() {
  try {
    const loaded = await loadProjects();
    return NextResponse.json(describe(loaded.file.projects, loaded.error));
  } catch (error) {
    return NextResponse.json({
      status: "error",
      message: error instanceof Error ? error.message : "Projects failed to load.",
    } satisfies AmbientProjectsResponse);
  }
}

export async function PUT(request: Request) {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return NextResponse.json({ status: "error", message: "Expected JSON." } satisfies AmbientProjectsResponse, { status: 415 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ status: "error", message: "The body is not valid JSON." } satisfies AmbientProjectsResponse, { status: 400 });
  }
  const projects = body && typeof body === "object" && "projects" in body ? (body as { projects: unknown }).projects : undefined;
  if (!Array.isArray(projects)) {
    return NextResponse.json({ status: "error", message: "Expected a projects array." } satisfies AmbientProjectsResponse, { status: 400 });
  }

  // The same rules the reader applies, so nothing can be saved that could not be read back.
  let file;
  try {
    file = parseProjectsFile(JSON.stringify({ version: 1, projects }));
  } catch (error) {
    return NextResponse.json(
      { status: "error", message: error instanceof Error ? error.message : "The projects are not valid." } satisfies AmbientProjectsResponse,
      { status: 400 },
    );
  }

  try {
    await saveProjects(file);
    const loaded = await loadProjects();
    return NextResponse.json(describe(loaded.file.projects, loaded.error));
  } catch (error) {
    return NextResponse.json({
      status: "error",
      message: error instanceof Error ? error.message : "Projects failed to save.",
    } satisfies AmbientProjectsResponse);
  }
}
