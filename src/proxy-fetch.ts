import http from "node:http";
import https from "node:https";
import type { IncomingHttpHeaders } from "node:http";
import type { Duplex } from "node:stream";
import tls from "node:tls";
import { networkProxySnapshot, parseLoopbackHttpProxy } from "./network-access.ts";

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
  const headers = headerRecord(init);
  const port = target.port ? Number(target.port) : 443;
  const connectAuthority = `${target.hostname}:${port}`;

  return new Promise((resolve, reject) => {
    let settled = false;
    let connect: http.ClientRequest | undefined;
    let tunnel: Duplex | undefined;
    let tlsSocket: tls.TLSSocket | undefined;
    let request: http.ClientRequest | undefined;
    let incoming: http.IncomingMessage | undefined;
    // CONNECT hands its socket to TLS. Destroying only the original HTTP
    // request cannot cancel a stalled TLS handshake after that hand-off.
    const finish = (error?: Error, response?: Response) => {
      if (settled) return;
      settled = true;
      init.signal?.removeEventListener("abort", abort);
      incoming?.destroy();
      request?.destroy();
      tlsSocket?.destroy();
      tunnel?.destroy();
      connect?.destroy();
      if (error) reject(error); else resolve(response!);
    };
    const abort = () => finish(new Error("proxy fetch was aborted", { cause: init.signal?.reason }));
    if (init.signal?.aborted) { abort(); return; }
    init.signal?.addEventListener("abort", abort, { once: true });
    connect = http.request({
      host: "127.0.0.1",
      port: Number(proxy.port) || 80,
      method: "CONNECT",
      path: connectAuthority,
      headers: { Host: connectAuthority },
    });

    connect.on("connect", (response, socket, head) => {
      if (settled) { socket.destroy(); return; }
      tunnel = socket;
      socket.on("error", error => finish(error));
      socket.once("close", () => finish(new Error("proxy tunnel closed before completion")));
      if ((response.statusCode ?? 0) !== 200) {
        finish(new Error(`proxy CONNECT failed with status ${response.statusCode}`));
        return;
      }
      if (head.length) socket.unshift(head);
      tlsSocket = tls.connect({ socket, servername: target.hostname }, () => {
        if (settled) return;
        request = https.request(
          target,
          {
            method: "GET",
            createConnection: () => tlsSocket!,
            headers: {
              Accept: "application/octet-stream, */*",
              "Accept-Encoding": "identity",
              "User-Agent": "Scientific-Figure-Library",
              ...headers,
            },
          },
          (response) => {
            if (settled) { response.destroy(); return; }
            incoming = response;
            const chunks: Buffer[] = [];
            let bytes = 0;
            let ended = false;
            incoming.on("data", (chunk: Buffer) => {
              bytes += chunk.byteLength;
              if (bytes > MAX_BYTES) {
                finish(new Error("downloaded archive exceeds 100 MiB"));
                return;
              }
              chunks.push(Buffer.from(chunk));
            });
            incoming.on("end", () => {
              ended = true;
              try {
                finish(undefined, nodeResponse(response.statusCode ?? 0, response.headers, new Uint8Array(Buffer.concat(chunks))));
              } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
            });
            incoming.on("error", (error) => finish(error));
            incoming.on("close", () => {
              if (!ended) finish(new Error("proxy fetch response closed before completion"));
            });
          },
        );
        request.on("error", (error) => finish(error));
        request.end();
      });
      tlsSocket.on("error", (error) => finish(error));
      tlsSocket.once("close", () => finish(new Error("proxy TLS connection closed before completion")));
    });
    connect.on("error", (error) => finish(error));
    connect.end();
  });
}

async function fetchViaLoopbackProxy(url: string, proxyHref: string, init: RequestInit): Promise<Response> {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new Error(`proxy fetch timed out after ${DEFAULT_TIMEOUT_MS}ms`)), DEFAULT_TIMEOUT_MS);
  const signal = init.signal ? AbortSignal.any([init.signal, deadline.signal]) : deadline.signal;
  try {
    return await followProxyRedirects(url, proxyHref, { ...init, signal });
  } finally { clearTimeout(timer); }
}

async function followProxyRedirects(url: string, proxyHref: string, init: RequestInit): Promise<Response> {
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
  snapshot?: { proxy: string | undefined },
): Promise<Response> {
  // An explicit undefined proxy means the operation selected direct access;
  // it must not be confused with a missing snapshot and re-read mid-redirect.
  const proxy = snapshot ? snapshot.proxy : await networkProxySnapshot();
  if (!proxy) return fetch(input, init);
  const url = input instanceof Request ? input.url : String(input);
  const signal = init.signal === undefined && input instanceof Request ? input.signal : init.signal;
  return fetchViaLoopbackProxy(url, proxy, { ...init, signal });
}
