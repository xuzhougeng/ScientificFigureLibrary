import http from "node:http";
import https from "node:https";
import type { IncomingHttpHeaders } from "node:http";
import tls from "node:tls";
import { getActiveHttpsProxy, parseLoopbackHttpProxy } from "./network-access.ts";

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_BYTES = 100 * 1024 * 1024;
const MAX_REDIRECTS = 3;

function headerRecord(init: RequestInit): Record<string, string> {
  const headers = new Headers(init.headers);
  const output: Record<string, string> = {};
  headers.forEach((value, key) => {
    if (key.toLowerCase() === "host") return;
    output[key] = value;
  });
  return output;
}

function nodeResponse(status: number, headers: IncomingHttpHeaders, body: Uint8Array) {
  const mapped = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined || key.startsWith(":")) continue;
    mapped.set(key, Array.isArray(value) ? value.join(", ") : value);
  }
  return new Response(Buffer.from(body), { status, headers: mapped });
}

function httpsGetViaConnect(url: string, proxyHref: string, init: RequestInit): Promise<Response> {
  const target = new URL(url);
  if (target.protocol !== "https:") throw new Error("proxy fetch only supports https:// URLs");
  const proxy = new URL(parseLoopbackHttpProxy(proxyHref));
  const timeoutMs = DEFAULT_TIMEOUT_MS;
  const headers = headerRecord(init);
  const port = target.port ? Number(target.port) : 443;
  const connectAuthority = `${target.hostname}:${port}`;

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      init.signal?.removeEventListener("abort", abortConnect);
      callback();
    };
    const connect = http.request({
      host: "127.0.0.1",
      port: Number(proxy.port) || 80,
      method: "CONNECT",
      path: connectAuthority,
      headers: { Host: connectAuthority },
      timeout: timeoutMs,
    });
    const abortConnect = () => connect.destroy(new Error("proxy fetch was aborted"));
    init.signal?.addEventListener("abort", abortConnect, { once: true });
    if (init.signal?.aborted) abortConnect();

    connect.on("connect", (response, socket, head) => {
      if ((response.statusCode ?? 0) !== 200) {
        socket.destroy();
        finish(() => reject(new Error(`proxy CONNECT failed with status ${response.statusCode}`)));
        return;
      }
      if (head.length) socket.unshift(head);
      const tlsSocket = tls.connect({ socket, servername: target.hostname }, () => {
        const request = https.request(
          target,
          {
            method: "GET",
            createConnection: () => tlsSocket,
            headers: {
              Accept: "application/octet-stream, */*",
              "Accept-Encoding": "identity",
              "User-Agent": "Scientific-Figure-Library",
              ...headers,
            },
          },
          (incoming) => {
            const chunks: Buffer[] = [];
            let bytes = 0;
            let ended = false;
            incoming.on("data", (chunk: Buffer) => {
              bytes += chunk.byteLength;
              if (bytes > MAX_BYTES) {
                request.destroy(new Error("downloaded archive exceeds 100 MiB"));
                return;
              }
              chunks.push(Buffer.from(chunk));
            });
            incoming.on("end", () => {
              ended = true;
              finish(() => resolve(nodeResponse(
                incoming.statusCode ?? 0,
                incoming.headers,
                new Uint8Array(Buffer.concat(chunks)),
              )));
            });
            incoming.on("error", (error) => finish(() => reject(error)));
            incoming.on("close", () => {
              if (!ended) finish(() => reject(new Error("proxy fetch response closed before completion")));
            });
          },
        );
        const abortRequest = () => request.destroy(new Error("proxy fetch was aborted"));
        init.signal?.addEventListener("abort", abortRequest, { once: true });
        request.setTimeout(timeoutMs, () => {
          request.destroy(new Error(`proxy fetch timed out after ${timeoutMs}ms`));
        });
        request.on("error", (error) => finish(() => reject(error)));
        request.end();
      });
      tlsSocket.on("error", (error) => finish(() => reject(error)));
    });
    connect.on("timeout", () => connect.destroy(new Error(`proxy fetch timed out after ${timeoutMs}ms`)));
    connect.on("error", (error) => finish(() => reject(error)));
    connect.end();
  });
}

async function fetchViaLoopbackProxy(url: string, proxyHref: string, init: RequestInit): Promise<Response> {
  const redirect = init.redirect ?? "follow";
  const visited = new Set<string>();
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (visited.has(current)) throw new Error("proxy fetch redirect loop detected");
    visited.add(current);
    const response = await httpsGetViaConnect(current, proxyHref, init);
    const redirected = [301, 302, 303, 307, 308].includes(response.status);
    if (!redirected) return response;
    if (redirect === "manual") return response;
    if (redirect === "error") throw new Error("unexpected redirect");
    const location = response.headers.get("location");
    if (!location) throw new Error("redirect omitted Location");
    if (hop === MAX_REDIRECTS) throw new Error("proxy fetch redirect limit exceeded");
    const next = new URL(location, current);
    if (next.protocol !== "https:") throw new Error("proxy fetch redirect left HTTPS");
    current = next.href;
  }
  throw new Error("proxy fetch redirect limit exceeded");
}

/** Use the saved loopback CONNECT proxy when enabled; otherwise the global fetch (tests may stub it). */
export async function fetchWithOptionalProxy(
  input: string | URL | Request,
  init: RequestInit = {},
): Promise<Response> {
  const proxy = getActiveHttpsProxy();
  if (!proxy) return fetch(input, init);
  const url = input instanceof Request ? input.url : String(input);
  return fetchViaLoopbackProxy(url, proxy, init);
}
