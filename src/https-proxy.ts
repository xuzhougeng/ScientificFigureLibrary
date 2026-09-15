import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

export const HTTPS_PROXY_SCHEMA = "figure-library.https-proxy.v1" as const;
export const HTTPS_PROXY_ENV = "SFL_HTTPS_PROXY" as const;

export interface LoopbackHttpProxy {
  href: string;
  host: string;
  port: number;
}

export interface HttpsProxyStatus {
  schema: typeof HTTPS_PROXY_SCHEMA;
  proxyUrl: string | null;
  source: "environment" | "file" | "none";
}

type Environment = Record<string, string | undefined>;

function ipv4Loopback(hostname: string) {
  const parts = hostname.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/u.test(part))) return false;
  const octets = parts.map(Number);
  return octets[0] === 127 && octets.every((octet) => octet <= 255);
}

export function parseLoopbackHttpProxy(raw: string, label = "HTTPS proxy"): LoopbackHttpProxy {
  const value = raw.trim();
  if (!value) throw new Error(`${label} is empty`);
  if (value.length > 200) throw new Error(`${label} is too long`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} is invalid: ${value}`);
  }
  if (url.protocol !== "http:") throw new Error(`${label} must be an http:// loopback CONNECT proxy`);
  if (url.username || url.password) throw new Error(`${label} cannot contain credentials`);
  if (url.hash || url.search) throw new Error(`${label} cannot contain a query or fragment`);
  if (url.pathname && url.pathname !== "/") throw new Error(`${label} cannot contain a path`);
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  if (hostname !== "localhost" && hostname !== "::1" && !ipv4Loopback(hostname)) {
    throw new Error(`${label} must be a loopback address such as http://127.0.0.1:7890`);
  }
  const port = url.port ? Number(url.port) : 80;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${label} has an invalid port`);
  }
  const host = hostname === "::1" ? "::1" : hostname;
  const href = host.includes(":") ? `http://[${host}]:${port}` : `http://${host}:${port}`;
  return { href, host, port };
}

export function resolveHttpsProxy(env: Environment = process.env): LoopbackHttpProxy | undefined {
  if (Object.prototype.hasOwnProperty.call(env, HTTPS_PROXY_ENV)) {
    const explicit = env[HTTPS_PROXY_ENV]?.trim() ?? "";
    return explicit ? parseLoopbackHttpProxy(explicit, HTTPS_PROXY_ENV) : undefined;
  }
  for (const key of ["HTTPS_PROXY", "https_proxy"] as const) {
    const value = env[key]?.trim();
    if (!value) continue;
    try {
      return parseLoopbackHttpProxy(value, key);
    } catch {
      continue;
    }
  }
  return undefined;
}

export function httpsProxyConfigRoot(env: Environment = process.env, platform = process.platform) {
  if (platform === "win32") {
    return path.join(env.APPDATA?.trim() || path.join(os.homedir(), "AppData", "Roaming"), "ScientificFigureLibrary");
  }
  return path.join(env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), ".config"), "scientific-figure-library");
}

export function httpsProxyFile(configRoot = httpsProxyConfigRoot()) {
  return path.join(configRoot, "https-proxy.json");
}

export async function loadStoredHttpsProxy(file = httpsProxyFile()): Promise<string | null> {
  try {
    const raw = JSON.parse(await fs.readFile(file, "utf8")) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("HTTPS proxy file is invalid");
    const value = raw as Record<string, unknown>;
    if (value.schema !== HTTPS_PROXY_SCHEMA) throw new Error("HTTPS proxy file schema is unsupported");
    if (value.proxyUrl === null || value.proxyUrl === "") return null;
    if (typeof value.proxyUrl !== "string") throw new Error("HTTPS proxy file proxyUrl is invalid");
    return parseLoopbackHttpProxy(value.proxyUrl, "stored HTTPS proxy").href;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function applyStoredHttpsProxy(env: Environment = process.env) {
  if (Object.prototype.hasOwnProperty.call(env, HTTPS_PROXY_ENV)) return resolveHttpsProxy(env);
  const stored = await loadStoredHttpsProxy();
  if (stored) env[HTTPS_PROXY_ENV] = stored;
  return resolveHttpsProxy(env);
}

export async function httpsProxyStatus(env: Environment = process.env): Promise<HttpsProxyStatus> {
  if (Object.prototype.hasOwnProperty.call(env, HTTPS_PROXY_ENV)) {
    const proxy = resolveHttpsProxy(env);
    return { schema: HTTPS_PROXY_SCHEMA, proxyUrl: proxy?.href ?? null, source: "environment" };
  }
  const stored = await loadStoredHttpsProxy();
  if (stored) return { schema: HTTPS_PROXY_SCHEMA, proxyUrl: stored, source: "file" };
  const inherited = resolveHttpsProxy(env);
  return {
    schema: HTTPS_PROXY_SCHEMA,
    proxyUrl: inherited?.href ?? null,
    source: inherited ? "environment" : "none",
  };
}

export async function saveHttpsProxy(proxyUrl: string, env: Environment = process.env) {
  const trimmed = proxyUrl.trim();
  const parsed = trimmed ? parseLoopbackHttpProxy(trimmed, "HTTPS proxy") : undefined;
  const file = httpsProxyFile();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(
    file,
    `${JSON.stringify({ schema: HTTPS_PROXY_SCHEMA, proxyUrl: parsed?.href ?? null }, null, 2)}\n`,
    { mode: 0o600 },
  );
  if (parsed) env[HTTPS_PROXY_ENV] = parsed.href;
  else delete env[HTTPS_PROXY_ENV];
  return { schema: HTTPS_PROXY_SCHEMA, proxyUrl: parsed?.href ?? null, source: parsed ? "file" as const : "none" as const };
}

export function connectTarget(hostname: string, port: number) {
  const host = hostname.replace(/^\[|\]$/gu, "");
  return net.isIP(host) === 6 ? `[${host}]:${port}` : `${host}:${port}`;
}

export function openLoopbackProxyTunnel(options: {
  proxy: LoopbackHttpProxy;
  hostname: string;
  port: number;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<net.Socket> {
  const target = connectTarget(options.hostname, options.port);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", abort);
      callback();
    };
    const fail = (error: Error) => {
      request.destroy();
      finish(() => reject(error));
    };
    const abort = () => fail(new Error("HTTPS proxy CONNECT was aborted"));
    const request = http.request({
      host: options.proxy.host,
      port: options.proxy.port,
      method: "CONNECT",
      path: target,
      headers: { Host: target, "User-Agent": "ScientificFigureLibrary-provider-source/0.6" },
    });
    request.setTimeout(options.timeoutMs, () => fail(new Error(`HTTPS proxy CONNECT timed out after ${options.timeoutMs}ms`)));
    request.once("connect", (response, socket, head) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        fail(new Error(`HTTPS proxy CONNECT failed with status ${response.statusCode ?? 0}`));
        return;
      }
      if (head.byteLength) socket.unshift(head);
      finish(() => resolve(socket));
    });
    request.once("error", (error) => fail(error instanceof Error ? error : new Error(String(error))));
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    request.end();
  });
}
