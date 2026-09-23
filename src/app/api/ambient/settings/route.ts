import { NextResponse } from "next/server";
import { applyPatch, maskKey, validatePatch } from "@/lib/ambient/config";
import type { AmbientSettingsResponse } from "@/lib/ambient/types";
import { configPath, loadConfig, saveConfig, type LoadedConfig } from "../config";

export const runtime = "nodejs";

/**
 * The Settings screen's endpoint. `GET` never returns the key itself, only enough to tell
 * that one is set and where it came from. `PUT` takes a partial and merges it into what the
 * file holds — not into the env-derived effective values, so a key that only lives in
 * `.env.local` is never silently copied into the file.
 *
 * The server binds to loopback only, and `PUT` insists on a JSON content type, which a
 * cross-origin page cannot send without a preflight this route does not answer.
 */

function describe(loaded: LoadedConfig): AmbientSettingsResponse {
  const { config } = loaded;
  return {
    status: "ready",
    hasApiKey: config.anthropicApiKey.length > 0,
    apiKeyMasked: maskKey(config.anthropicApiKey),
    apiKeySource: loaded.apiKeySource,
    afkSeconds: config.afkSeconds,
    afkSource: loaded.afkSource,
    breakMinutes: config.breakMinutes,
    breakSource: loaded.breakSource,
    openAtLogin: config.openAtLogin,
    excludeApps: config.collector.excludeApps,
    configPath: configPath(),
  };
}

export async function GET() {
  try {
    return NextResponse.json(describe(await loadConfig()));
  } catch (error) {
    return NextResponse.json({
      status: "error",
      message: error instanceof Error ? error.message : "Settings failed to load.",
    } satisfies AmbientSettingsResponse);
  }
}

export async function PUT(request: Request) {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return NextResponse.json({ status: "error", message: "Expected JSON." } satisfies AmbientSettingsResponse, { status: 415 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ status: "error", message: "The body is not valid JSON." } satisfies AmbientSettingsResponse, { status: 400 });
  }
  const result = validatePatch(body);
  if (!result.ok) {
    return NextResponse.json({ status: "error", message: result.errors.join(" ") } satisfies AmbientSettingsResponse, { status: 400 });
  }

  try {
    const current = await loadConfig();
    await saveConfig(applyPatch(current.stored, result.patch));
    return NextResponse.json(describe(await loadConfig()));
  } catch (error) {
    return NextResponse.json({
      status: "error",
      message: error instanceof Error ? error.message : "Settings failed to save.",
    } satisfies AmbientSettingsResponse);
  }
}
