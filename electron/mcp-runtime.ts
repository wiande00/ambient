import { app } from "electron";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RotatingLog } from "./log";
import { mcpRuntimeDir } from "./paths";

/**
 * A copy of this executable, kept outside the install folder, for Claude to run the MCP
 * server with.
 *
 * Claude Desktop starts the server once and never restarts it. An update's installer stops
 * every process whose path is inside the install folder, so a server started from there
 * died with each update, and Claude Desktop showed it as failed until it was restarted.
 * Started from `~/.ambient/mcp/` it is out of the installer's reach: it answers "Ambient is
 * not running" for the moment the app is down and works again once the new build is up,
 * since it finds the app afresh on every call.
 *
 * In Node mode the executable needs only its ICU data and V8 snapshots beside it, not the
 * rest of Electron. The name differs from the app's, so the installer's fallback (killing
 * by image name, where CIM is unavailable) passes it by too.
 *
 * The server script is plain JavaScript read at start, so it is refreshed whenever it
 * changes. The executable set is replaced only as a whole, and only when no server is
 * running from it: Windows refuses to replace a running executable, which is the signal,
 * and an old executable with a new snapshot would not start.
 */

export const MCP_EXE = "ambient-mcp.exe";
export const MCP_SCRIPT = "server.cjs";
/** The executable first: if it is in use, nothing else is touched. */
const RUNTIME_FILES: { from: string; to: string }[] = [
  { from: "", to: MCP_EXE },
  { from: "icudtl.dat", to: "icudtl.dat" },
  { from: "snapshot_blob.bin", to: "snapshot_blob.bin" },
  { from: "v8_context_snapshot.bin", to: "v8_context_snapshot.bin" },
];
const MARKER = "runtime.json";

export function mcpExePath(): string {
  return join(mcpRuntimeDir(), MCP_EXE);
}

export function mcpScriptPath(): string {
  return join(mcpRuntimeDir(), MCP_SCRIPT);
}

/** Whether a runtime was ever set up here, which means someone uses the connector. */
export function mcpRuntimeExists(): boolean {
  return existsSync(mcpExePath());
}

function markerVersion(): string | null {
  try {
    const parsed = JSON.parse(readFileSync(join(mcpRuntimeDir(), MARKER), "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

let inFlight: Promise<void> | null = null;

/** Make sure the runtime is there and the script is current. Safe to call often; concurrent calls share one run. */
export function ensureMcpRuntime(log: RotatingLog | null): Promise<void> {
  inFlight ??= run(log).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function run(log: RotatingLog | null): Promise<void> {
  const dir = mcpRuntimeDir();
  await mkdir(dir, { recursive: true });

  const script = join(process.resourcesPath, "mcp", MCP_SCRIPT);
  const wanted = await readFile(script);
  const current = await readFile(mcpScriptPath()).catch(() => null);
  if (!current || !current.equals(wanted)) {
    await copyFile(script, `${mcpScriptPath()}.tmp`);
    await rename(`${mcpScriptPath()}.tmp`, mcpScriptPath());
    log?.write(`[connector] MCP server script refreshed in ${dir}`);
  }

  const version = app.getVersion();
  if (mcpRuntimeExists() && markerVersion() === version) return;

  const installDir = dirname(process.execPath);
  const staged = RUNTIME_FILES.map(({ from, to }) => ({ src: from ? join(installDir, from) : process.execPath, dest: join(dir, to) }));
  try {
    for (const { src, dest } of staged) await copyFile(src, `${dest}.tmp`);
    for (const { dest } of staged) await rename(`${dest}.tmp`, dest);
  } catch (error) {
    // Renaming over the executable fails while Claude runs a server from it. That copy still
    // works; the swap is tried again on the next start.
    await Promise.all(staged.map(({ dest }) => rm(`${dest}.tmp`, { force: true })));
    if (mcpRuntimeExists()) {
      log?.write(`[connector] MCP runtime left at its old version for now: ${String(error)}`);
      return;
    }
    throw error;
  }
  writeFileSync(join(dir, MARKER), `${JSON.stringify({ version }, null, 2)}\n`, "utf8");
  log?.write(`[connector] MCP runtime ${version} set up in ${dir}`);
}
