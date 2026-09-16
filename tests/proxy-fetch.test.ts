import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { resetNetworkAccessForTests, setNetworkAccessForTests } from "../src/network-access.ts";
import { fetchWithOptionalProxy } from "../src/proxy-fetch.ts";

test("proxy fetch uses global fetch when the system proxy is off", async (t) => {
  resetNetworkAccessForTests();
  const previous = globalThis.fetch;
  let called = "";
  globalThis.fetch = (async (input: string | URL | Request) => {
    called = String(input);
    return new Response("ok");
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = previous;
  });
  const response = await fetchWithOptionalProxy("https://example.com/archive.zip", { redirect: "error" });
  assert.equal(called, "https://example.com/archive.zip");
  assert.equal(await response.text(), "ok");
});

test("proxy fetch sends CONNECT to the saved loopback proxy instead of direct fetch", async (t) => {
  const seen: string[] = [];
  const server = http.createServer();
  server.on("connect", (request, socket) => {
    seen.push(request.url ?? "");
    socket.write("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
    socket.end();
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  t.after(() => new Promise<void>((resolve) => {
    server.close(() => resolve());
  }));
  const port = (server.address() as AddressInfo).port;
  setNetworkAccessForTests({ useSystemProxy: true, httpsProxy: `http://127.0.0.1:${port}` });
  t.after(() => resetNetworkAccessForTests());
  const previous = globalThis.fetch;
  let directFetch = 0;
  globalThis.fetch = (async () => {
    directFetch += 1;
    throw new Error("direct fetch should not run when a proxy is configured");
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = previous;
  });
  await assert.rejects(
    fetchWithOptionalProxy(
      "https://raw.githubusercontent.com/jarxunlai/ScientificFigureLibrary-personal/commit/archives/batch-boxplot-signif.zip",
      { redirect: "error", signal: AbortSignal.timeout(5_000) },
    ),
    /proxy CONNECT failed with status 502/u,
  );
  assert.equal(directFetch, 0);
  assert.deepEqual(seen, ["raw.githubusercontent.com:443"]);
});
