import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { networkAccessFile, inspectNetworkAccess, saveNetworkAccess, resetNetworkAccessForTests, setNetworkAccessForTests, testNetworkAccess } from "../src/network-access.ts";
import { fetchWithOptionalProxy } from "../src/proxy-fetch.ts";
import { createClientUpdateChecker } from "../src/local/updates.ts";
import { SecureProviderSourceFetcher } from "../src/provider-source-fetch.ts";

test("an already-running independent process reloads saves; revision conflicts and legacy files are safe", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-live-proxy-"));
  const oldApp = process.env.APPDATA, oldXdg = process.env.XDG_CONFIG_HOME;
  process.env.APPDATA = root; process.env.XDG_CONFIG_HOME = root;
  resetNetworkAccessForTests();
  const env = { ...process.env, APPDATA: root, XDG_CONFIG_HOME: root };
  const moduleUrl = pathToFileURL(path.resolve(import.meta.dirname, "../src/network-access.ts")).href;
  const script = `import { networkProxySnapshot } from ${JSON.stringify(moduleUrl)}; process.stdin.setEncoding('utf8'); process.stdin.on('data', async () => { try { console.log(JSON.stringify(await networkProxySnapshot() ?? null)); } catch (error) { console.log(JSON.stringify({error:error.message})); } });`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let buffer = ""; const queue: string[] = []; const waiters: Array<(value: string) => void> = [];
  child.stdout.setEncoding("utf8"); child.stdout.on("data", chunk => {
    buffer += chunk;
    while (buffer.includes("\n")) {
      const index = buffer.indexOf("\n"); const line = buffer.slice(0, index).trim(); buffer = buffer.slice(index + 1);
      const next = waiters.shift(); if (next) next(line); else queue.push(line);
    }
  });
  const ask = async () => {
    child.stdin.write("go\n");
    return JSON.parse(queue.shift() ?? await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("child proxy check timed out")), 5000);
      waiters.push(value => { clearTimeout(timer); resolve(value); });
    })) as unknown;
  };
  t.after(async () => {
    child.kill(); resetNetworkAccessForTests();
    if (oldApp === undefined) delete process.env.APPDATA; else process.env.APPDATA = oldApp;
    if (oldXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = oldXdg;
    await fs.rm(root, { recursive: true, force: true });
  });
  assert.equal(await ask(), null);
  const initial = await inspectNetworkAccess();
  const first = await saveNetworkAccess({ useSystemProxy: true, httpsProxy: "http://127.0.0.1:7001", revision: initial.revision });
  assert.equal(await ask(), "http://127.0.0.1:7001");
  const writes = await Promise.allSettled([
    saveNetworkAccess({ useSystemProxy: true, httpsProxy: "http://127.0.0.1:7002", revision: first.revision }),
    saveNetworkAccess({ useSystemProxy: true, httpsProxy: "http://127.0.0.1:7003", revision: first.revision }),
  ]);
  assert.deepEqual(writes.map(value => value.status).sort(), ["fulfilled", "rejected"]);
  assert.equal(await ask(), (await inspectNetworkAccess()).activeProxy);
  await fs.writeFile(networkAccessFile(), JSON.stringify({ useSystemProxy: true, httpsProxy: "http://127.0.0.1:7004" }));
  assert.equal(await ask(), "http://127.0.0.1:7004");
  await fs.writeFile(networkAccessFile(), JSON.stringify({ useSystemProxy: true, httpsProxy: "socks5://127.0.0.1:7004" }));
  assert.match(JSON.stringify(await ask()), /proxy must be an http/u);
  const invalid = await inspectNetworkAccess();
  assert.equal(invalid.activeProxy, null);
  assert.match(invalid.configurationError ?? "", /proxy must be an http/u);
});

test("a local CONNECT fixture carries both archive bytes and the stable-release check", async t => {
  const oldCAs = tls.getCACertificates();
  const cert = await fs.readFile(path.resolve(import.meta.dirname, "fixtures/proxy-test-cert.pem"), "utf8");
  const key = await fs.readFile(path.resolve(import.meta.dirname, "fixtures/proxy-test-key.pem"), "utf8");
  tls.setDefaultCACertificates([...oldCAs, cert]);
  const targets: string[] = [];
  const target = https.createServer({ key, cert }, (request, response) => {
    if (request.url === "/repos/xuzhougeng/ScientificFigureLibrary/releases/latest") {
      response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify({ tag_name: "v0.10.0", draft: false, prerelease: false }));
    } else { response.end("archive fixture bytes"); }
  });
  const proxy = http.createServer();
  proxy.on("connect", (request, socket) => {
    targets.push(request.url ?? "");
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    target.emit("connection", socket);
  });
  await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
  const port = (proxy.address() as { port: number }).port;
  setNetworkAccessForTests({ useSystemProxy: true, httpsProxy: `http://127.0.0.1:${port}` });
  t.after(async () => {
    resetNetworkAccessForTests(); tls.setDefaultCACertificates(oldCAs);
    await new Promise<void>(resolve => proxy.close(() => resolve())); target.closeAllConnections();
  });
  assert.equal(await (await fetchWithOptionalProxy("https://raw.githubusercontent.com/sfl/archive.zip")).text(), "archive fixture bytes");
  const update = await createClientUpdateChecker({ currentVersion: "0.9.0" })();
  assert.equal(update.status, "available");
  assert.deepEqual(targets, ["raw.githubusercontent.com:443", "api.github.com:443"]);
  const tested = await testNetworkAccess();
  assert.equal(tested.reachable, true);
  assert.equal(tested.forwardingTested, true);
});

test("provider redirects retain the proxy snapshot taken before the operation", async t => {
  setNetworkAccessForTests({ useSystemProxy: true, httpsProxy: "http://127.0.0.1:7001" });
  t.after(() => resetNetworkAccessForTests());
  const seen: string[] = [];
  const fetcher = new SecureProviderSourceFetcher({ request: async (_url, options) => {
    seen.push(options.proxy ?? "direct");
    if (seen.length === 1) {
      setNetworkAccessForTests({ useSystemProxy: true, httpsProxy: "http://127.0.0.1:7002" });
      return { statusCode: 302, headers: { location: "https://example.com/final" }, body: new Uint8Array() };
    }
    return { statusCode: 200, headers: { "content-type": "application/json" }, body: new TextEncoder().encode("{}") };
  } });
  const result = await fetcher.fetch("https://example.com/start", { maxBytes: 100, mediaTypes: ["application/json"] });
  assert.equal(new TextDecoder().decode(result.bytes), "{}");
  assert.deepEqual(seen, ["http://127.0.0.1:7001", "http://127.0.0.1:7001"]);
});
