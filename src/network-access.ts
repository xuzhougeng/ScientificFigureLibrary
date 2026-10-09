import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { randomUUID, createHash } from "node:crypto";
import { promisify } from "node:util";
import { fetchWithOptionalProxy } from "./proxy-fetch.ts";

const execFile = promisify(execFileCallback);
export const NETWORK_ACCESS_SCHEMA = "figure-library.network-access.v1" as const;

export interface NetworkAccessSettings {
  schema: typeof NETWORK_ACCESS_SCHEMA;
  useSystemProxy: boolean;
  httpsProxy: string;
}

export interface NetworkAccessStatus extends NetworkAccessSettings {
  revision: string;
  detectedProxy: string | null;
  activeProxy: string | null;
  source: "off" | "saved" | "system";
  configured: boolean;
  reachable: boolean | null;
  forwardingTested: boolean | null;
  scope: "same-user-and-machine";
  configurationError?: string;
}

let loaded: NetworkAccessSettings = { schema: NETWORK_ACCESS_SCHEMA, useSystemProxy: false, httpsProxy: "" };
let detectedCache = "";
let testOverride = false;
const defaults: NetworkAccessSettings = { schema: NETWORK_ACCESS_SCHEMA, useSystemProxy: false, httpsProxy: "" };
const revisionOf = (value: NetworkAccessSettings) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function configRoot() {
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA?.trim() || path.join(os.homedir(), "AppData", "Roaming"), "ScientificFigureLibrary");
  }
  return path.join(process.env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), ".config"), "scientific-figure-library");
}

export function networkAccessFile(root = configRoot()) {
  return path.join(root, "network-access.json");
}

export function parseLoopbackHttpProxy(value: string | undefined | null): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return "";
  let url: URL;
  try { url = new URL(trimmed); } catch { throw new Error("proxy URL is invalid"); }
  if (url.protocol !== "http:") throw new Error("proxy must be an http:// loopback address");
  if (url.username || url.password) throw new Error("proxy cannot contain credentials");
  if (url.hash || url.search || (url.pathname && url.pathname !== "/")) {
    throw new Error("proxy URL must not include a path or query");
  }
  const host = url.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    throw new Error("proxy must be a loopback HTTP address such as http://127.0.0.1:7897");
  }
  const port = url.port ? Number(url.port) : 80;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error("proxy port is invalid");
  return `http://127.0.0.1:${port}`;
}

function envProxy(env: NodeJS.ProcessEnv = process.env) {
  for (const key of ["SFL_HTTPS_PROXY", "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"]) {
    const value = env[key]?.trim();
    if (!value) continue;
    try { return parseLoopbackHttpProxy(value); } catch { /* ignore unusable values */ }
  }
  return "";
}

async function macosSystemProxy() {
  if (process.platform !== "darwin") return "";
  try {
    const { stdout } = await execFile("/usr/sbin/scutil", ["--proxy"], { timeout: 2000 });
    const httpsOn = /HTTPSEnable\s*:\s*1\b/u.test(stdout);
    const httpOn = /HTTPEnable\s*:\s*1\b/u.test(stdout);
    const host = (httpsOn ? stdout.match(/HTTPSProxy\s*:\s*(\S+)/u) : httpOn ? stdout.match(/HTTPProxy\s*:\s*(\S+)/u) : null)?.[1];
    const port = (httpsOn ? stdout.match(/HTTPSPort\s*:\s*(\d+)/u) : httpOn ? stdout.match(/HTTPPort\s*:\s*(\d+)/u) : null)?.[1];
    if (!host || !port) return "";
    return parseLoopbackHttpProxy(`http://${host}:${port}`);
  } catch {
    return "";
  }
}

export async function detectSystemHttpProxy(env: NodeJS.ProcessEnv = process.env) {
  const fromEnv = envProxy(env);
  if (fromEnv) return fromEnv;
  return macosSystemProxy();
}

export function getActiveHttpsProxy() {
  if (!loaded.useSystemProxy) return undefined;
  return (loaded.httpsProxy ? parseLoopbackHttpProxy(loaded.httpsProxy) : detectedCache) || undefined;
}

async function readSettings(): Promise<NetworkAccessSettings> {
  if (testOverride) return { ...loaded };
  let raw: Partial<NetworkAccessSettings>;
  try { raw = JSON.parse(await fs.readFile(networkAccessFile(), "utf8")) as Partial<NetworkAccessSettings>; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...defaults };
    throw error;
  }
  return {
    schema: NETWORK_ACCESS_SCHEMA,
    useSystemProxy: raw.useSystemProxy === true,
    httpsProxy: raw.httpsProxy === undefined || raw.httpsProxy === null ? "" : String(raw.httpsProxy),
  };
}

/** Resolve once at an operation boundary; callers retain this value across redirects. */
export async function networkProxySnapshot(): Promise<string | undefined> {
  const settings = await readSettings();
  loaded = settings;
  if (!settings.useSystemProxy) return undefined;
  const proxy = settings.httpsProxy ? parseLoopbackHttpProxy(settings.httpsProxy) : await detectSystemHttpProxy();
  if (!proxy) throw new Error("Proxy is enabled, but no supported loopback HTTP proxy is configured on this machine");
  detectedCache = proxy;
  return proxy;
}

export function currentNetworkAccess(): NetworkAccessSettings {
  return { ...loaded };
}

async function persist(settings: NetworkAccessSettings) {
  const file = networkAccessFile();
  await fs.mkdir(path.dirname(file), { recursive: true });
  const staging = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(staging, `${JSON.stringify(settings, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await fs.rename(staging, file);
  } finally { await fs.rm(staging, { force: true }); }
  loaded = settings;
}

export async function withConfigLock<T>(file: string, action: () => Promise<T>): Promise<T> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const handle = await fs.open(lock, "wx", 0o600);
      try { return await action(); }
      finally { await handle.close(); await fs.rm(lock, { force: true }); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const stat = await fs.stat(lock).catch(() => undefined);
      if (stat && Date.now() - stat.mtimeMs > 30_000) await fs.rm(lock, { force: true });
      await new Promise(resolve => setTimeout(resolve, 25 + Math.random() * 25));
    }
  }
  throw new Error("Network settings are busy; retry the save");
}

export async function loadNetworkAccess() {
  loaded = await readSettings();
  return inspectNetworkAccess();
}

export async function inspectNetworkAccess(): Promise<NetworkAccessStatus> {
  loaded = await readSettings();
  const detected = await detectSystemHttpProxy();
  detectedCache = detected;
  let saved = "", configurationError: string | undefined;
  try { saved = loaded.httpsProxy ? parseLoopbackHttpProxy(loaded.httpsProxy) : ""; }
  catch (error) { configurationError = error instanceof Error ? error.message : String(error); }
  const active = !loaded.useSystemProxy || configurationError ? null : saved || detected || null;
  return {
    ...loaded,
    revision: revisionOf(loaded),
    detectedProxy: detected || null,
    activeProxy: active,
    source: !loaded.useSystemProxy ? "off" : saved ? "saved" : detected ? "system" : "off",
    configured: loaded.useSystemProxy && Boolean(active),
    reachable: null,
    forwardingTested: null,
    scope: "same-user-and-machine",
    ...(configurationError ? { configurationError } : {}),
  };
}

export async function saveNetworkAccess(input: { useSystemProxy?: boolean; httpsProxy?: string; revision?: string }) {
  await withConfigLock(networkAccessFile(), async () => {
    const current = await readSettings();
    if (input.revision !== undefined && input.revision !== revisionOf(current)) throw new Error("Network settings changed in another process; reload and retry");
    const httpsProxy = input.httpsProxy === undefined ? current.httpsProxy : parseLoopbackHttpProxy(input.httpsProxy);
    await persist({ schema: NETWORK_ACCESS_SCHEMA, useSystemProxy: input.useSystemProxy === true, httpsProxy });
  });
  return inspectNetworkAccess();
}

/** One bounded, explicit probe to a fixed SFL endpoint; never takes a user URL. */
export async function testNetworkAccess(): Promise<NetworkAccessStatus & { message: string }> {
  const status = await inspectNetworkAccess();
  if (status.useSystemProxy && !status.activeProxy) return { ...status, reachable: false, forwardingTested: false, message: "Enabled proxy has no usable local address" };
  if (status.activeProxy) {
    const proxy = new URL(status.activeProxy);
    status.reachable = await new Promise<boolean>(resolve => {
      const socket = net.connect({ host: "127.0.0.1", port: Number(proxy.port) || 80 });
      socket.setTimeout(1500);
      socket.once("connect", () => { socket.destroy(); resolve(true); });
      socket.once("timeout", () => { socket.destroy(); resolve(false); });
      socket.once("error", () => { socket.destroy(); resolve(false); });
    });
    if (!status.reachable) return { ...status, forwardingTested: false, message: "Configured local proxy is unreachable" };
  }
  try {
    const response = await fetchWithOptionalProxy("https://api.github.com/repos/xuzhougeng/ScientificFigureLibrary/releases/latest", {
      redirect: "error", signal: AbortSignal.timeout(8000), headers: { Accept: "application/vnd.github+json", "User-Agent": "ScientificFigureLibrary-network-test" },
    }, { proxy: status.activeProxy ?? undefined });
    status.forwardingTested = response.ok;
    await response.body?.cancel();
    return { ...status, message: response.ok ? "GitHub release endpoint responded" : `GitHub release endpoint returned HTTP ${response.status}` };
  } catch (error) {
    return { ...status, forwardingTested: false, message: error instanceof Error ? error.message : String(error) };
  }
}

export function resetNetworkAccessForTests() {
  testOverride = false;
  loaded = { schema: NETWORK_ACCESS_SCHEMA, useSystemProxy: false, httpsProxy: "" };
  detectedCache = "";
}

export function setNetworkAccessForTests(settings: { useSystemProxy: boolean; httpsProxy?: string }) {
  testOverride = true;
  loaded = {
    schema: NETWORK_ACCESS_SCHEMA,
    useSystemProxy: settings.useSystemProxy,
    httpsProxy: settings.httpsProxy ? parseLoopbackHttpProxy(settings.httpsProxy) : "",
  };
}
