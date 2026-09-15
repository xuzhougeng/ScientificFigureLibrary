import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  HTTPS_PROXY_ENV,
  HTTPS_PROXY_SCHEMA,
  applyStoredHttpsProxy,
  loadStoredHttpsProxy,
  openLoopbackProxyTunnel,
  parseLoopbackHttpProxy,
  resolveHttpsProxy,
  saveHttpsProxy,
} from "../src/https-proxy.ts";

function listen(server: net.Server) {
  return new Promise<number>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") reject(new Error("server did not bind a TCP port"));
      else resolve(address.port);
    });
    server.once("error", reject);
  });
}

test("loopback HTTP proxy URLs are accepted and public or credentialed proxies are rejected", () => {
  assert.deepEqual(parseLoopbackHttpProxy("http://127.0.0.1:7890"), {
    href: "http://127.0.0.1:7890",
    host: "127.0.0.1",
    port: 7890,
  });
  assert.equal(parseLoopbackHttpProxy("http://localhost:8080").host, "localhost");
  assert.equal(parseLoopbackHttpProxy("http://[::1]:1080").href, "http://[::1]:1080");
  assert.throws(() => parseLoopbackHttpProxy("https://127.0.0.1:7890"), /http:\/\//u);
  assert.throws(() => parseLoopbackHttpProxy("http://127.0.0.1:7890/cache"), /path/u);
  assert.throws(() => parseLoopbackHttpProxy("http://user:pass@127.0.0.1:7890"), /credentials/u);
  assert.throws(() => parseLoopbackHttpProxy("http://8.8.8.8:7890"), /loopback/u);
  assert.throws(() => parseLoopbackHttpProxy("http://10.0.0.1:7890"), /loopback/u);
});

test("SFL_HTTPS_PROXY wins, empty disables, and non-loopback HTTPS_PROXY is ignored", () => {
  assert.equal(resolveHttpsProxy({ [HTTPS_PROXY_ENV]: "http://127.0.0.1:7890", HTTPS_PROXY: "http://10.0.0.1:8080" })?.port, 7890);
  assert.equal(resolveHttpsProxy({ [HTTPS_PROXY_ENV]: "", HTTPS_PROXY: "http://127.0.0.1:8080" }), undefined);
  assert.equal(resolveHttpsProxy({ HTTPS_PROXY: "http://127.0.0.1:8118" })?.port, 8118);
  assert.equal(resolveHttpsProxy({ HTTPS_PROXY: "http://proxy.example:8080" }), undefined);
});

test("stored HTTPS proxy file is loaded unless SFL_HTTPS_PROXY is already set", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-https-proxy-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const previous = {
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    APPDATA: process.env.APPDATA,
  };
  process.env.XDG_CONFIG_HOME = root;
  process.env.APPDATA = root;
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const env: Record<string, string | undefined> = { XDG_CONFIG_HOME: root, APPDATA: root };
  assert.equal(await loadStoredHttpsProxy(), null);
  const saved = await saveHttpsProxy("http://127.0.0.1:7890", env);
  assert.equal(saved.schema, HTTPS_PROXY_SCHEMA);
  assert.equal(saved.proxyUrl, "http://127.0.0.1:7890");
  assert.equal(env[HTTPS_PROXY_ENV], "http://127.0.0.1:7890");
  assert.equal(await loadStoredHttpsProxy(), "http://127.0.0.1:7890");
  delete env[HTTPS_PROXY_ENV];
  const applied = await applyStoredHttpsProxy(env);
  assert.equal(applied?.href, "http://127.0.0.1:7890");
  env[HTTPS_PROXY_ENV] = "";
  assert.equal(await applyStoredHttpsProxy(env), undefined);
});

test("loopback CONNECT tunnel forwards bytes to the target", async (t) => {
  const target = net.createServer((socket) => {
    socket.write("pong");
    socket.end();
  });
  t.after(() => new Promise<void>((resolve) => target.close(() => resolve())));
  const targetPort = await listen(target);
  const proxy = http.createServer();
  proxy.on("connect", (request, socket) => {
    const destination = net.connect({ host: "127.0.0.1", port: targetPort }, () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      socket.pipe(destination);
      destination.pipe(socket);
    });
    destination.on("error", () => socket.destroy());
  });
  t.after(() => new Promise<void>((resolve) => proxy.close(() => resolve())));
  const proxyPort = await listen(proxy);
  const tunnel = await openLoopbackProxyTunnel({
    proxy: { href: `http://127.0.0.1:${proxyPort}`, host: "127.0.0.1", port: proxyPort },
    hostname: "127.0.0.1",
    port: targetPort,
    timeoutMs: 2_000,
  });
  t.after(() => tunnel.destroy());
  const chunk = await new Promise<string>((resolve, reject) => {
    tunnel.once("data", (bytes) => resolve(Buffer.from(bytes).toString("utf8")));
    tunnel.once("error", reject);
    tunnel.once("end", () => resolve(""));
  });
  assert.equal(chunk, "pong");
});
