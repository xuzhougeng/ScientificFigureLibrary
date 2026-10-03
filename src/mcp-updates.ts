import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { networkAccessFile, withConfigLock } from "./network-access.ts";
import { createClientUpdateChecker, isNewerStableVersion, RELEASES_URL } from "./local/updates.ts";
import { VERSION } from "./version.ts";

const SOURCE = "github:xuzhougeng/ScientificFigureLibrary:stable";
const SUCCESS_TTL = 24 * 60 * 60 * 1000;
const FAILURE_TTL = 60 * 60 * 1000;
type Cache = { source: typeof SOURCE; checkedAt: string; latestVersion?: string; releaseUrl?: string; error?: string };
export type McpUpdateStatus = {
  currentVersion: string; latestVersion: string | null; releaseUrl: string | null;
  checkedAt: string | null; checkStatus: "fresh" | "stale" | "error" | "unchecked";
  stale: boolean; noticesEnabled: boolean; message?: string;
};

function cacheFile() { return path.join(path.dirname(networkAccessFile()), "mcp-update-cache.json"); }
function parseCache(raw: unknown): Cache | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const value = raw as Partial<Cache>;
  if (value.source !== SOURCE || typeof value.checkedAt !== "string" || !Number.isFinite(Date.parse(value.checkedAt))) return undefined;
  if (typeof value.latestVersion === "string" && typeof value.releaseUrl === "string") {
    try {
      isNewerStableVersion(value.latestVersion, VERSION);
      if ([`v${value.latestVersion}`, value.latestVersion].some(tag => value.releaseUrl === `${RELEASES_URL}/tag/${encodeURIComponent(tag)}`)) return value as Cache;
    } catch { /* corrupted cache */ }
  }
  if (typeof value.error === "string") return { source: SOURCE, checkedAt: value.checkedAt, error: value.error };
  return undefined;
}
async function readCache() {
  try { return parseCache(JSON.parse(await fs.readFile(cacheFile(), "utf8")) as unknown); }
  catch { return undefined; }
}
async function writeCache(value: Cache) {
  const file = cacheFile();
  await withConfigLock(file, async () => {
    const current = await readCache();
    if (current && Date.parse(current.checkedAt) > Date.parse(value.checkedAt)) return;
    const stage = `${file}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(stage, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      await fs.rename(stage, file);
    } finally { await fs.rm(stage, { force: true }); }
  });
}

/** One monitor per MCP server session. Background work never blocks initialize or ordinary tool calls. */
export function createMcpUpdateMonitor(options: {
  currentVersion?: string; now?: () => number; cachePath?: string;
  checker?: ReturnType<typeof createClientUpdateChecker>; noticesEnabled?: boolean;
} = {}) {
  const currentVersion = options.currentVersion ?? VERSION;
  const now = options.now ?? Date.now;
  const checker = options.checker ?? createClientUpdateChecker({ currentVersion });
  const noticesEnabled = options.noticesEnabled ?? !/^(?:0|false|off)$/iu.test(process.env.SFL_MCP_UPDATE_NOTICES?.trim() ?? "");
  let cached: Cache | undefined;
  let pending: Promise<McpUpdateStatus> | undefined;
  let announcedVersion = "";
  const file = options.cachePath ?? cacheFile();
  async function load() {
    try { cached = parseCache(JSON.parse(await fs.readFile(file, "utf8")) as unknown); }
    catch { cached = undefined; }
  }
  function status(): McpUpdateStatus {
    const age = cached ? now() - Date.parse(cached.checkedAt) : Infinity;
    const stale = age >= (cached?.error ? FAILURE_TTL : SUCCESS_TTL) || age < 0;
    return {
      currentVersion, latestVersion: cached?.latestVersion ?? null, releaseUrl: cached?.releaseUrl ?? null,
      checkedAt: cached?.checkedAt ?? null,
      checkStatus: !cached ? "unchecked" : cached.error ? "error" : stale ? "stale" : "fresh",
      stale, noticesEnabled, ...(cached?.error ? { message: cached.error } : {}),
    };
  }
  function refresh(force = false): Promise<McpUpdateStatus> {
    if (pending) return pending;
    if (!force && !status().stale) return Promise.resolve(status());
    pending = (async () => {
      const result = await checker(true);
      const value: Cache = result.status === "error"
        ? { source: SOURCE, checkedAt: result.checkedAt, error: result.message }
        : { source: SOURCE, checkedAt: result.checkedAt, latestVersion: result.latestVersion, releaseUrl: result.releaseUrl };
      cached = value;
      if (file === cacheFile()) await writeCache(value);
      else {
        await withConfigLock(file, async () => {
          const stage = `${file}.${randomUUID()}.tmp`;
          try { await fs.writeFile(stage, `${JSON.stringify(value)}\n`, { flag: "wx", mode: 0o600 }); await fs.rename(stage, file); }
          finally { await fs.rm(stage, { force: true }); }
        });
      }
      return status();
    })().finally(() => { pending = undefined; });
    return pending;
  }
  function begin() {
    if (noticesEnabled && status().stale) void refresh().catch(() => { /* status remains unknown */ });
  }
  function notice(): string | undefined {
    if (!noticesEnabled || status().checkStatus !== "fresh" || !cached?.latestVersion || !cached.releaseUrl) return undefined;
    if (!isNewerStableVersion(cached.latestVersion, currentVersion) || announcedVersion === cached.latestVersion) return undefined;
    announcedVersion = cached.latestVersion;
    return `SFL update available: running ${currentVersion}; latest stable ${cached.latestVersion}. Read/download: ${cached.releaseUrl}. Update your installation using its documented method, then restart this MCP process.`;
  }
  return { begin, load, refresh, status, notice };
}
