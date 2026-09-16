import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  getActiveHttpsProxy,
  inspectNetworkAccess,
  loadNetworkAccess,
  parseLoopbackHttpProxy,
  resetNetworkAccessForTests,
  saveNetworkAccess,
} from "../src/network-access.ts";

test("loopback HTTP CONNECT proxy URLs are accepted and public or private LAN proxies are rejected", () => {
  assert.equal(parseLoopbackHttpProxy("http://127.0.0.1:7897"), "http://127.0.0.1:7897");
  assert.equal(parseLoopbackHttpProxy("http://localhost:7897"), "http://127.0.0.1:7897");
  assert.equal(parseLoopbackHttpProxy(""), "");
  assert.throws(() => parseLoopbackHttpProxy("http://8.8.8.8:8080"), /loopback/u);
  assert.throws(() => parseLoopbackHttpProxy("http://192.168.1.1:7897"), /loopback/u);
  assert.throws(() => parseLoopbackHttpProxy("https://127.0.0.1:7897"), /http:\/\//u);
  assert.throws(() => parseLoopbackHttpProxy("http://127.0.0.1:7897/path"), /path/u);
});

test("system proxy is off by default even when HTTPS_PROXY is set", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-network-access-"));
  const previousHome = process.env.XDG_CONFIG_HOME;
  const previousProxy = process.env.HTTPS_PROXY;
  process.env.XDG_CONFIG_HOME = root;
  process.env.HTTPS_PROXY = "http://127.0.0.1:7897";
  t.after(() => {
    resetNetworkAccessForTests();
    if (previousHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousHome;
    if (previousProxy === undefined) delete process.env.HTTPS_PROXY;
    else process.env.HTTPS_PROXY = previousProxy;
  });
  const loaded = await loadNetworkAccess();
  assert.equal(loaded.useSystemProxy, false);
  assert.equal(loaded.activeProxy, null);
  assert.equal(getActiveHttpsProxy(), undefined);
  const enabled = await saveNetworkAccess({ useSystemProxy: true, httpsProxy: "" });
  assert.equal(enabled.useSystemProxy, true);
  assert.equal(enabled.activeProxy, "http://127.0.0.1:7897");
  assert.equal(getActiveHttpsProxy(), "http://127.0.0.1:7897");
  const inspected = await inspectNetworkAccess();
  assert.ok(inspected.detectedProxy === "http://127.0.0.1:7897" || inspected.source === "saved");
});
