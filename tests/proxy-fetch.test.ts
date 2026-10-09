import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import fs from "node:fs/promises";
import { getEventListeners } from "node:events";
import tls from "node:tls";
import type { Duplex } from "node:stream";
import type { AddressInfo } from "node:net";
import test, { type TestContext } from "node:test";
import { resetNetworkAccessForTests, setNetworkAccessForTests, testNetworkAccess } from "../src/network-access.ts";
import { fetchWithOptionalProxy } from "../src/proxy-fetch.ts";

async function within<T>(promise: Promise<T>, milliseconds = 2_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("test watchdog: operation did not settle")), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

async function proxyFixture(t: TestContext, stage: "connect" | "tls" | "headers" | "body" | "success" | "redirect" | "close") {
  const originalCAs = tls.getCACertificates();
  const cert = await fs.readFile(new URL("fixtures/proxy-test-cert.pem", import.meta.url), "utf8");
  const key = await fs.readFile(new URL("fixtures/proxy-test-key.pem", import.meta.url), "utf8");
  tls.setDefaultCACertificates([...originalCAs, cert]);
  const sockets = new Set<Duplex>();
  let ready!: () => void;
  const reached = new Promise<void>(resolve => { ready = resolve; });
  let requests = 0;
  const target = https.createServer({ key, cert }, (request, response) => {
    requests++;
    if (stage === "success") response.end("fixture bytes");
    else if (stage === "redirect" && request.url === "/start") {
      response.writeHead(302, { location: "https://api.github.com/final" }); response.end();
    } else if (stage === "body") { response.writeHead(200); response.write("partial"); }
    else if (stage === "close") response.destroy();
    ready();
  });
  const proxy = http.createServer();
  proxy.on("connection", socket => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket));
    socket.on("end", () => socket.end());
  });
  proxy.on("connect", (_request, socket) => {
    if (stage === "connect") { socket.resume(); ready(); return; }
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (stage === "tls") socket.once("data", ready);
    else target.emit("connection", socket);
  });
  await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
  setNetworkAccessForTests({ useSystemProxy: true, httpsProxy: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}` });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    target.closeAllConnections();
    await new Promise<void>(resolve => proxy.close(() => resolve()));
    tls.setDefaultCACertificates(originalCAs); resetNetworkAccessForTests();
  });
  return { proxy, reached, sockets, requests: () => requests };
}

async function assertClosed(sockets: Set<Duplex>) {
  await within((async () => {
    while (sockets.size) await new Promise(resolve => setTimeout(resolve, 10));
  })());
}

test("proxy fetch uses global fetch when the system proxy is off", async (t) => {
  setNetworkAccessForTests({ useSystemProxy: false });
  const previous = globalThis.fetch;
  let called = "";
  globalThis.fetch = (async (input: string | URL | Request) => {
    called = String(input);
    return new Response("ok");
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = previous;
    resetNetworkAccessForTests();
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

for (const stage of ["connect", "tls", "headers", "body"] as const) {
  test(`proxy cancellation settles and closes sockets during ${stage}`, async t => {
    const fixture = await proxyFixture(t, stage);
    const controller = new AbortController();
    // Attach the rejection handler immediately, before aborting the transport.
    const rejected = assert.rejects(within(fetchWithOptionalProxy("https://api.github.com/start", { signal: controller.signal })), /aborted|cancelled/u);
    await within(fixture.reached);
    controller.abort();
    await rejected;
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    await assertClosed(fixture.sockets);
  });
}

test("an already-aborted caller signal opens no proxy connection", async t => {
  const fixture = await proxyFixture(t, "success");
  await assert.rejects(fetchWithOptionalProxy("https://api.github.com/start", { signal: AbortSignal.abort() }), /aborted/u);
  assert.equal(fixture.requests(), 0);
  await assertClosed(fixture.sockets);
});

test("proxy success and connection failure remove abort listeners and close sockets", async t => {
  for (const stage of ["success", "close"] as const) await t.test(stage, async child => {
    const fixture = await proxyFixture(child, stage);
    const controller = new AbortController();
    const request = fetchWithOptionalProxy("https://api.github.com/start", { signal: controller.signal });
    if (stage === "success") assert.equal(await (await within(request)).text(), "fixture bytes");
    else await assert.rejects(within(request), /closed|hang up|reset/u);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    await assertClosed(fixture.sockets);
  });
});

test("a caller deadline also bounds a redirected HTTPS request", async t => {
  const fixture = await proxyFixture(t, "redirect");
  await assert.rejects(within(fetchWithOptionalProxy("https://api.github.com/start", { signal: AbortSignal.timeout(300) })), /aborted|timed out/u);
  assert.equal(fixture.requests(), 2);
  await assertClosed(fixture.sockets);
});

test("the fixed network diagnostic endpoint stops a stalled TLS handshake at its eight-second deadline", async t => {
  const fixture = await proxyFixture(t, "tls");
  const started = Date.now();
  const result = await within(testNetworkAccess(), 11_000);
  assert.equal(result.reachable, true);
  assert.equal(result.forwardingTested, false);
  assert.match(result.message, /aborted|timed out/u);
  assert.ok(Date.now() - started < 11_000);
  await assertClosed(fixture.sockets);
});

test("the default whole-operation deadline covers TLS even without a caller signal", { timeout: 5_000 }, async t => {
  const fixture = await proxyFixture(t, "tls");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const rejected = assert.rejects(fetchWithOptionalProxy("https://api.github.com/start"), /aborted|timed out/u);
  await fixture.reached;
  t.mock.timers.tick(60_000);
  await rejected;
  t.mock.timers.reset();
  await assertClosed(fixture.sockets);
});

test("a Request object's signal cancels TLS and releases its socket", async t => {
  const fixture = await proxyFixture(t, "tls");
  const controller = new AbortController();
  const rejected = assert.rejects(within(fetchWithOptionalProxy(new Request("https://api.github.com/start", { signal: controller.signal }))), /aborted/u);
  await within(fixture.reached);
  controller.abort();
  await rejected;
  await assertClosed(fixture.sockets);
});

test("the network diagnostic uses the proxy it inspected even if settings change during its TCP probe", async t => {
  const fixture = await proxyFixture(t, "success");
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("diagnostic switched to direct access"); };
  t.after(() => { globalThis.fetch = previousFetch; });
  fixture.proxy.once("connection", () => setNetworkAccessForTests({ useSystemProxy: false }));
  const result = await within(testNetworkAccess());
  assert.equal(result.configured, true);
  assert.equal(result.reachable, true);
  assert.equal(result.forwardingTested, true);
  assert.equal(fixture.requests(), 1);
  await assertClosed(fixture.sockets);
});
