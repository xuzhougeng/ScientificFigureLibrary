import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
export const NETWORK_ACCESS_SCHEMA = "figure-library.network-access.v1" as const;

export interface NetworkAccessSettings {
  schema: typeof NETWORK_ACCESS_SCHEMA;
  useSystemProxy: boolean;
  httpsProxy: string;
}

export interface NetworkAccessStatus extends NetworkAccessSettings {
  detectedProxy: string | null;
  activeProxy: string | null;
  source: "off" | "saved" | "system";
}

let loaded: NetworkAccessSettings = { schema: NETWORK_ACCESS_SCHEMA, useSystemProxy: false, httpsProxy: "" };
let detectedCache = "";

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
  try {
    return parseLoopbackHttpProxy(loaded.httpsProxy) || detectedCache || undefined;
  } catch {
    return detectedCache || undefined;
  }
}

export function currentNetworkAccess(): NetworkAccessSettings {
  return { ...loaded };
}

async function persist(settings: NetworkAccessSettings) {
  const file = networkAccessFile();
  await fs.mkdir(path.dirname(file), { recursive: true });
  const staging = `${file}.${Date.now()}.tmp`;
  await fs.writeFile(staging, `${JSON.stringify(settings, null, 2)}\n`, { flag: "wx" });
  await fs.rename(staging, file);
  loaded = settings;
}

export async function loadNetworkAccess() {
  try {
    const raw = JSON.parse(await fs.readFile(networkAccessFile(), "utf8")) as Partial<NetworkAccessSettings>;
    loaded = {
      schema: NETWORK_ACCESS_SCHEMA,
      useSystemProxy: raw.useSystemProxy === true,
      httpsProxy: raw.httpsProxy ? parseLoopbackHttpProxy(String(raw.httpsProxy)) : "",
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    loaded = { schema: NETWORK_ACCESS_SCHEMA, useSystemProxy: false, httpsProxy: "" };
  }
  return inspectNetworkAccess();
}

export async function inspectNetworkAccess(): Promise<NetworkAccessStatus> {
  const detected = await detectSystemHttpProxy();
  detectedCache = detected;
  const saved = loaded.httpsProxy ? parseLoopbackHttpProxy(loaded.httpsProxy) : "";
  const active = !loaded.useSystemProxy ? null : saved || detected || null;
  return {
    ...loaded,
    detectedProxy: detected || null,
    activeProxy: active,
    source: !loaded.useSystemProxy ? "off" : saved ? "saved" : detected ? "system" : "off",
  };
}

export async function saveNetworkAccess(input: { useSystemProxy?: boolean; httpsProxy?: string }) {
  const httpsProxy = input.httpsProxy === undefined ? loaded.httpsProxy : parseLoopbackHttpProxy(input.httpsProxy);
  const useSystemProxy = input.useSystemProxy === true;
  await persist({ schema: NETWORK_ACCESS_SCHEMA, useSystemProxy, httpsProxy: useSystemProxy ? httpsProxy : httpsProxy });
  if (useSystemProxy && !httpsProxy) {
    const detected = await detectSystemHttpProxy();
    if (detected) await persist({ schema: NETWORK_ACCESS_SCHEMA, useSystemProxy: true, httpsProxy: detected });
  }
  return inspectNetworkAccess();
}

export function resetNetworkAccessForTests() {
  loaded = { schema: NETWORK_ACCESS_SCHEMA, useSystemProxy: false, httpsProxy: "" };
  detectedCache = "";
}

export function setNetworkAccessForTests(settings: { useSystemProxy: boolean; httpsProxy?: string }) {
  loaded = {
    schema: NETWORK_ACCESS_SCHEMA,
    useSystemProxy: settings.useSystemProxy,
    httpsProxy: settings.httpsProxy ? parseLoopbackHttpProxy(settings.httpsProxy) : "",
  };
}
