import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { keyForName, FALLBACK_BUCKETS, type AmbientProject } from "../src/lib/ambient/projects";
import type {
  AmbientChunksResponse,
  AmbientDayResponse,
  AmbientEditsResponse,
  AmbientOffComputerResponse,
  AmbientProjectsResponse,
  AmbientSettingsResponse,
  AmbientWeekResponse,
} from "../src/lib/ambient/types";

/**
 * Ambient as an MCP server, so Claude can read where the hours went and keep the projects
 * list without anyone opening the app, and correct a day's chunks when the collector or the
 * model got one wrong. It is a thin client: every tool calls the dashboard
 * server the desktop app already runs on loopback, which is where the measuring, the
 * labelling and the caches live. Nothing is duplicated here and nothing leaves the machine.
 *
 * The app writes `~/.ambient/dashboard.json` with its server's URL when it starts; the
 * default port is the fallback. If the app is not running, every tool says so.
 *
 * Runs over stdio: `Ambient.exe resources/mcp/server.cjs` with ELECTRON_RUN_AS_NODE=1 from
 * an installed app, or `node dist-electron/mcp.cjs` from a checkout.
 */

const DEFAULT_URL = "http://127.0.0.1:47821";
const BUCKETS: Record<(typeof FALLBACK_BUCKETS)[number], string> = {
  personal: "Personal (shopping, games, errands)",
  admin: "Admin (receipts, accounts, machine setup)",
  other: "Other (belongs to no project)",
};

function baseUrl(): string {
  try {
    const info = JSON.parse(readFileSync(join(homedir(), ".ambient", "dashboard.json"), "utf8")) as { url?: unknown };
    if (typeof info.url === "string" && info.url.startsWith("http://127.0.0.1")) return info.url;
  } catch {
    // Not running, or an older app: fall through to the default port.
  }
  return DEFAULT_URL;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const url = `${baseUrl()}${path}`;
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch {
    throw new Error(`Ambient is not running (nothing answered at ${url}). Start the Ambient app and try again.`);
  }
  const body = (await response.json()) as T;
  return body;
}

const round = (n: number) => Math.round(n * 10) / 10;

function text(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function fail(message: string) {
  return { isError: true as const, content: [{ type: "text" as const, text: message }] };
}

async function loadProjects(): Promise<{ projects: AmbientProject[]; path: string }> {
  const res = await api<AmbientProjectsResponse>("/api/ambient/projects");
  if (res.status !== "ready") throw new Error(res.message);
  if (res.error) throw new Error(`The projects file cannot be used: ${res.error}. Fix it in Ambient's Settings first.`);
  return { projects: res.projects, path: res.path };
}

async function saveProjects(projects: AmbientProject[]): Promise<AmbientProject[]> {
  const res = await api<AmbientProjectsResponse>("/api/ambient/projects", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projects }),
  });
  if (res.status !== "ready") throw new Error(res.message);
  return res.projects;
}

function describeProjects(projects: AmbientProject[]) {
  return {
    projects: projects.map((p) => ({ key: p.key, name: p.name, description: p.description, hints: p.hints })),
    buckets: Object.entries(BUCKETS).map(([key, meaning]) => ({ key, meaning })),
    note: "Chunks are labelled with one project key or one bucket. Editing projects relabels each day the next time it is opened.",
  };
}

const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD")
  .optional()
  .describe("Local calendar date as YYYY-MM-DD. Defaults to today.");

const time = (what: string) =>
  z
    .string()
    .min(1)
    .describe(`${what}: a local clock time on the date, "HH:MM" or "HH:MM:SS" ("24:00" for midnight at its end), or a full ISO instant as get_day gives it.`);

function localToday(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

/** A clock time on `day`, or an ISO instant, as a UTC ISO instant; null when it is neither. */
function instantOn(day: string, value: string): string | null {
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (match) {
    const [y, m, d] = day.split("-").map(Number);
    const at = new Date(y, m - 1, d, Number(match[1]), Number(match[2]), Number(match[3] ?? 0));
    return Number.isFinite(at.getTime()) ? at.toISOString() : null;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

type ReadyChunks = Extract<AmbientChunksResponse, { status: "ready" }>;

function describeChunks(chunks: ReadyChunks) {
  const name = (key: string) => (key in BUCKETS ? BUCKETS[key as keyof typeof BUCKETS] : (chunks.projectNames[key] ?? key));
  return chunks.chunks.map((c) => ({
    from: c.from,
    to: c.to,
    minutes: round(c.minutes),
    activeMinutes: round(c.activeMinutes),
    idleMinutes: round(c.idleMinutes),
    project: c.project,
    projectName: name(c.project),
    // The stretch's headline project is the one that held most of it. When it held more than
    // one, this is where its minutes actually went — the totals are counted from here.
    alsoProjects:
      c.projects && new Set(c.projects.map((p) => p.project)).size > 1
        ? [...c.projects.reduce((by, p) => by.set(p.project, round((by.get(p.project) ?? 0) + p.activeMinutes)), new Map<string, number>())].map(([key, activeMinutes]) => ({
            project: key,
            projectName: name(key),
            activeMinutes,
          }))
        : undefined,
    sentence: c.label ?? "(not labelled yet)",
    what: c.what || undefined,
    unclear: c.unclear || undefined,
    editedByYou: c.edit ? true : undefined,
    countedAsActive: c.edit?.active || undefined,
  }));
}

/** Makes one edit through the dashboard, then answers with the day's chunks as they now stand. */
async function editDay(day: string, body: Record<string, unknown>) {
  const res = await api<AmbientEditsResponse>("/api/ambient/edits", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ date: day, ...body }),
  });
  if (res.status !== "ready") return fail(res.message);
  const chunks = await api<AmbientChunksResponse>(`/api/ambient/chunks?date=${day}`);
  return text({
    date: day,
    savedEdits: res.edits.length,
    chunks: chunks.status === "ready" ? describeChunks(chunks) : `unavailable: ${chunks.status === "error" ? chunks.message : chunks.status}`,
  });
}

/** The day, and both ends of a stretch on it as instants, or a message saying which is wrong. */
function stretch(requested: string | undefined, from: string, to: string): { day: string; from: string; to: string } | string {
  const day = requested ?? localToday();
  const fromIso = instantOn(day, from);
  const toIso = instantOn(day, to);
  if (!fromIso) return `Could not read "${from}" as a time.`;
  if (!toIso) return `Could not read "${to}" as a time.`;
  return { day, from: fromIso, to: toIso };
}

const server = new McpServer({ name: "ambient", version: "0.4.0" });

server.registerTool(
  "get_day",
  {
    title: "Get a day",
    description:
      "Where the hours went on one day: tracked, active, idle and away minutes; the day cut into chunks, each with a plain sentence, the project it belonged to and its measured minutes; and active minutes per project. Labels come from the model and may still be pending for today. Chunks the person corrected are marked editedByYou; stretches they took out are listed under removedByYou.",
    inputSchema: { date },
  },
  async ({ date: requested }) => {
    const query = requested ? `?date=${requested}` : "";
    const [day, chunks] = await Promise.all([
      api<AmbientDayResponse>(`/api/ambient/day${query}`),
      api<AmbientChunksResponse>(`/api/ambient/chunks${query}`),
    ]);
    if (day.status === "error") return fail(day.message);
    if (day.status === "empty") {
      return text({ date: day.date, today: day.today, tracked: false, message: "Nothing was tracked that day.", daysWithData: day.days });
    }
    const names = chunks.status === "ready" ? chunks.projectNames : {};
    const name = (key: string) => (key in BUCKETS ? BUCKETS[key as keyof typeof BUCKETS] : (names[key] ?? key));
    return text({
      date: day.date,
      today: day.today,
      observed: { from: day.totals.from, to: day.totals.to },
      minutes: {
        tracked: round(day.totals.trackedMinutes),
        active: round(day.totals.activeMinutes),
        idle: round(day.totals.idleMinutes),
        away: round(day.totals.awayMinutes),
        idleEstimated: day.totals.estimatedIdle,
      },
      labels:
        chunks.status === "ready"
          ? chunks.pending > 0
            ? `pending for ${chunks.pending} stretch(es)`
            : "ready"
          : chunks.status === "not_configured"
            ? "no Anthropic API key set in Ambient, so chunks carry no sentences"
            : chunks.status === "error"
              ? `unavailable: ${chunks.message}`
              : "pending",
      chunks:
        chunks.status === "ready"
          ? describeChunks(chunks)
          : day.candidates.map((c) => ({ from: c.from, to: c.to, minutes: round(c.minutes), sentence: "(not labelled yet)" })),
      removedByYou: day.segments
        .filter((s) => s.kind === "away" && s.why === "removed")
        .map((s) => ({ from: s.from, to: s.to, minutes: round(s.minutes) })),
      byProject:
        chunks.status === "ready"
          ? chunks.projects.map((p) => ({ project: p.project, name: name(p.project), activeMinutes: round(p.activeMinutes), idleMinutes: round(p.idleMinutes) }))
          : [],
      projectsFileError: chunks.status === "ready" ? (chunks.projectsError ?? undefined) : undefined,
      labellingSpend:
        chunks.status === "ready" && chunks.usage
          ? { calls: chunks.usage.calls, inputTokens: chunks.usage.input_tokens, outputTokens: chunks.usage.output_tokens, estimatedUsd: Number(chunks.usage.estimated_usd.toFixed(4)) }
          : undefined,
    });
  },
);

server.registerTool(
  "get_week",
  {
    title: "Get a week",
    description: "Seven calendar days ending on the given date (default today): per-day tracked, active, idle and away minutes, plus active minutes per project across the days that have been labelled.",
    inputSchema: { date },
  },
  async ({ date: requested }) => {
    const week = await api<AmbientWeekResponse>(`/api/ambient/week${requested ? `?date=${requested}` : ""}`);
    if (week.status !== "ready") return fail(week.message);
    const name = (key: string) => (key in BUCKETS ? BUCKETS[key as keyof typeof BUCKETS] : (week.projectNames[key] ?? key));
    return text({
      from: week.from,
      to: week.to,
      today: week.today,
      days: week.days.map((d) =>
        d.observed
          ? {
              date: d.date,
              tracked: round(d.trackedMinutes),
              active: round(d.activeMinutes),
              idle: round(d.idleMinutes),
              away: round(d.awayMinutes),
              labelled: d.labelled,
            }
          : { date: d.date, tracked: 0, observed: false },
      ),
      byProject: week.projects.map((p) => ({ project: p.project, name: name(p.project), activeMinutes: round(p.activeMinutes) })),
      unlabelledMinutes: round(week.unlabelledMinutes),
    });
  },
);

server.registerTool(
  "list_days",
  {
    title: "List tracked days",
    description: "Every date Ambient has a log for, ascending, and today's date.",
    inputSchema: {},
  },
  async () => {
    const day = await api<AmbientDayResponse>("/api/ambient/day");
    if (day.status === "error") return fail(day.message);
    return text({ today: day.today, days: day.days });
  },
);

server.registerTool(
  "list_projects",
  {
    title: "List projects",
    description: "The projects hours are totalled against — key, name, description and the hints the model uses to recognise each — and the fixed buckets for everything else.",
    inputSchema: {},
  },
  async () => {
    const { projects } = await loadProjects();
    return text(describeProjects(projects));
  },
);

server.registerTool(
  "add_project",
  {
    title: "Add a project",
    description: "Add a project. The key is derived from the name and never changes. Description and hints are what the model reads to decide which stretches belong to it, so be concrete: what the work looks like, window titles, paths, product names.",
    inputSchema: {
      name: z.string().min(1).describe("Shown on screen, e.g. \"Thesis\"."),
      description: z.string().optional().describe("One or two sentences on what work on this project looks like."),
      hints: z.array(z.string()).optional().describe("Words, window titles, paths, product names that mark this project's work."),
    },
  },
  async ({ name, description, hints }) => {
    const { projects } = await loadProjects();
    const key = keyForName(name, projects.map((p) => p.key));
    const saved = await saveProjects([...projects, { key, name: name.trim(), description: (description ?? "").trim(), hints: hints ?? [] }]);
    return text({ added: key, ...describeProjects(saved) });
  },
);

server.registerTool(
  "update_project",
  {
    title: "Update a project",
    description: "Change a project's name, description or hints. Fields left out stay as they are; hints given replace the whole list. The key stays the same.",
    inputSchema: {
      key: z.string().describe("The project key, from list_projects."),
      name: z.string().min(1).optional(),
      description: z.string().optional(),
      hints: z.array(z.string()).optional(),
    },
  },
  async ({ key, name, description, hints }) => {
    const { projects } = await loadProjects();
    const current = projects.find((p) => p.key === key);
    if (!current) return fail(`No project has the key "${key}". Keys: ${projects.map((p) => p.key).join(", ") || "(none)"}.`);
    const next = projects.map((p) =>
      p.key === key ? { ...p, name: name?.trim() ?? p.name, description: description?.trim() ?? p.description, hints: hints ?? p.hints } : p,
    );
    return text({ updated: key, ...describeProjects(await saveProjects(next)) });
  },
);

server.registerTool(
  "remove_project",
  {
    title: "Remove a project",
    description: "Remove a project. Stretches already labelled with it move to the Other bucket the next time each day is opened.",
    inputSchema: { key: z.string().describe("The project key, from list_projects.") },
  },
  async ({ key }) => {
    const { projects } = await loadProjects();
    if (!projects.some((p) => p.key === key)) return fail(`No project has the key "${key}".`);
    return text({ removed: key, ...describeProjects(await saveProjects(projects.filter((p) => p.key !== key))) });
  },
);

server.registerTool(
  "edit_chunk",
  {
    title: "Correct a chunk",
    description:
      "Say what a stretch of a day really was, when Ambient's label or project is wrong. Overrides the label for exactly from–to: pass a chunk's own from and to from get_day to correct that chunk, or other times to relabel part of one. The rest of the day keeps its labels, nothing is sent to the model, and the measured minutes stay as they were unless countIdleAsActive is set — use that when the idle time in the stretch was really work away from the keyboard (writing on paper, reading), so all of it counts as active. Project and sentence left out are kept from the chunk there now. Only time Ambient tracked is relabelled; for time it did not see, use add_chunk.",
    inputSchema: {
      date,
      from: time("Start"),
      to: time("End"),
      project: z.string().optional().describe("A project key from list_projects, or a bucket (personal, admin, other)."),
      sentence: z.string().optional().describe("One plain past-tense sentence saying what the stretch was."),
      countIdleAsActive: z.boolean().optional().describe("Count the whole stretch as worked, idle time included. Default false."),
    },
  },
  async ({ date: requested, from, to, project, sentence, countIdleAsActive }) => {
    const at = stretch(requested, from, to);
    if (typeof at === "string") return fail(at);
    let label = sentence?.trim();
    let key = project?.trim();
    if (!label || !key) {
      // Keep what the chunk covering most of the stretch says now.
      const chunks = await api<AmbientChunksResponse>(`/api/ambient/chunks?date=${at.day}`);
      if (chunks.status === "ready") {
        const fromMs = Date.parse(at.from);
        const toMs = Date.parse(at.to);
        const overlap = (c: ReadyChunks["chunks"][number]) => Math.max(0, Math.min(toMs, Date.parse(c.to)) - Math.max(fromMs, Date.parse(c.from)));
        const current = [...chunks.chunks].sort((a, b) => overlap(b) - overlap(a))[0];
        if (current && overlap(current) > 0) {
          label = label || current.label || undefined;
          key = key || current.project;
        }
      }
    }
    if (!label) return fail("Give a sentence: the stretch has no label to keep.");
    return editDay(at.day, { op: "label", from: at.from, to: at.to, project: key ?? "other", label, active: countIdleAsActive === true });
  },
);

server.registerTool(
  "add_chunk",
  {
    title: "Add a chunk",
    description:
      "Add a stretch of work the collector did not see as work — pen and paper, a book, a phone call, a whiteboard — on a past or current day. It counts as fully active on the project whatever the screen showed at the time (idle, away, or other windows), and takes the place of whatever Ambient had for from–to. For a stretch still going on now, use start_off_computer instead.",
    inputSchema: {
      date,
      from: time("Start"),
      to: time("End"),
      project: z.string().describe("A project key from list_projects, or a bucket (personal, admin, other)."),
      sentence: z.string().min(1).describe("One plain past-tense sentence saying what was done, e.g. \"Worked through chapter 4 exercises on paper\"."),
    },
  },
  async ({ date: requested, from, to, project, sentence }) => {
    const at = stretch(requested, from, to);
    if (typeof at === "string") return fail(at);
    return editDay(at.day, { op: "label", from: at.from, to: at.to, project, label: sentence, active: true });
  },
);

server.registerTool(
  "delete_chunk",
  {
    title: "Delete a chunk",
    description:
      "Take a stretch out of a day: it no longer counts as tracked, active, idle or away, and drops out of the project totals. Pass a chunk's own from and to from get_day to delete that chunk. Undo with undo_chunk_edits over the same times.",
    inputSchema: { date, from: time("Start"), to: time("End") },
  },
  async ({ date: requested, from, to }) => {
    const at = stretch(requested, from, to);
    if (typeof at === "string") return fail(at);
    return editDay(at.day, { op: "remove", from: at.from, to: at.to });
  },
);

server.registerTool(
  "undo_chunk_edits",
  {
    title: "Undo chunk edits",
    description:
      "Forget every correction made inside from–to on a day — edited, added and deleted chunks alike — so that time goes back to what Ambient measured and labelled. Without from and to, the whole day.",
    inputSchema: { date, from: time("Start").optional(), to: time("End").optional() },
  },
  async ({ date: requested, from, to }) => {
    const at = stretch(requested, from ?? "00:00", to ?? "24:00");
    if (typeof at === "string") return fail(at);
    return editDay(at.day, { op: "revert", from: at.from, to: at.to });
  },
);

function describeOffComputer(res: AmbientOffComputerResponse) {
  if (res.status !== "ready") throw new Error(res.message);
  return {
    active: res.active ? { since: res.active.from, project: res.active.project, note: res.active.note || undefined } : null,
    today: res.today.map((s) => ({ from: s.from, to: s.to ?? "(running)", project: s.project, note: s.note || undefined })),
  };
}

server.registerTool(
  "start_off_computer",
  {
    title: "Start working off the computer",
    description:
      "Turn on the \"working off computer\" switch: from now until it is stopped, time counts as active work on the given project whatever the screen shows — pen and paper, a book, a whiteboard. Any session already running is closed first.",
    inputSchema: {
      project: z.string().optional().describe("A project key from list_projects, or a bucket (personal, admin, other). Defaults to other."),
      note: z.string().optional().describe("What, in a few words, e.g. \"chapter 4 exercises\". Becomes the chunk's text."),
    },
  },
  async ({ project, note }) => {
    const res = await api<AmbientOffComputerResponse>("/api/ambient/offcomputer", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ on: true, project: project ?? "other", note: note ?? "" }),
    });
    if (res.status !== "ready") return fail(res.message);
    return text(describeOffComputer(res));
  },
);

server.registerTool(
  "stop_off_computer",
  {
    title: "Stop working off the computer",
    description: "Turn the \"working off computer\" switch off, ending the running session. Safe to call when none is running.",
    inputSchema: {},
  },
  async () => {
    const res = await api<AmbientOffComputerResponse>("/api/ambient/offcomputer", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ on: false }),
    });
    if (res.status !== "ready") return fail(res.message);
    return text(describeOffComputer(res));
  },
);

server.registerTool(
  "get_status",
  {
    title: "Ambient status",
    description: "Whether the Ambient app is reachable, where its server is, and the settings that shape the figures: the idle and break thresholds, and whether labelling is configured.",
    inputSchema: {},
  },
  async () => {
    const [settings, off] = await Promise.all([
      api<AmbientSettingsResponse>("/api/ambient/settings"),
      api<AmbientOffComputerResponse>("/api/ambient/offcomputer"),
    ]);
    if (settings.status !== "ready") return fail(settings.message);
    return text({
      running: true,
      url: baseUrl(),
      offComputer: describeOffComputer(off),
      idleAfterSeconds: settings.afkSeconds,
      breakAfterMinutes: settings.breakMinutes,
      labellingConfigured: settings.hasApiKey,
      openAtLogin: settings.openAtLogin,
      collectorNeverReads: settings.excludeApps,
      settingsFile: settings.configPath,
    });
  },
);

async function main() {
  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  process.stderr.write(`ambient mcp: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
