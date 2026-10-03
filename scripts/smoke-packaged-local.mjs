#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { unzipSync } from "fflate";

const archive = process.argv[2];
if (!archive) throw new Error("Usage: node scripts/smoke-packaged-local.mjs <windows-client.zip>");
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-packaged-local-smoke-"));
let child;
try {
  const entries = unzipSync(new Uint8Array(await fs.readFile(archive)));
  let packageRoot = "";
  for (const [name, bytes] of Object.entries(entries)) {
    const parts = name.split("/");
    assert.ok(parts.length >= 2 && parts.every(part => part && part !== "." && part !== ".." && !part.includes("\\")), `Unsafe ZIP entry ${name}`);
    packageRoot ||= parts[0];
    assert.equal(parts[0], packageRoot);
    const target = path.join(scratch, ...parts);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, bytes);
  }
  const root = path.join(scratch, packageRoot);
  const state = path.join(scratch, "user-state");
  const env = { ...process.env };
  for (const key of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME"]) env[key] = state;
  delete env.FIGURE_LIBRARY_DIR; delete env.FIGURE_WORKSPACE_DIR;
  env.SFL_DIAGNOSTICS_DIR = path.join(scratch, "diagnostics");
  env.SFL_WORKSPACE_LOCATOR_PATH = path.join(state, "workspace.json");
  env.SFL_PREVIEW_CACHE_DIR = path.join(scratch, "preview-cache");
  env.SFL_OPEN_FIGURE_AUTO_REFRESH = "0";
  env.SFL_MCP_UPDATE_NOTICES = "0";
  env.SFL_NO_BROWSER = "1";
  const bundledNode = path.join(root, "runtime/node.exe");
  const executable = await fs.access(bundledNode).then(() => bundledNode, () => process.execPath);
  child = spawn(executable, [path.join(root, "dist/index.js"), "--local", "--no-open"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const launched = await Promise.race([
    new Promise((resolve, reject) => {
      let stdout = "", stderr = "";
      child.stdout.on("data", chunk => { stdout += chunk; if (stdout.includes("\n")) {
        try { resolve(JSON.parse(stdout.split("\n")[0])); } catch (error) { reject(error); }
      } });
      child.stderr.on("data", chunk => { stderr += chunk; });
      child.once("exit", code => reject(new Error(`Packaged local client exited ${code}: ${stderr}`)));
    }),
    new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("Packaged local client launch timed out")), 25_000); timer.unref(); }),
  ]);
  assert.equal(launched.schema, "figure-library.local-launch.v1");
  const page = await fetch(`${launched.origin}/`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /rel="icon"[^>]*href="\/favicon\.svg"/u);
  assert.match(html, /id="test-proxy"/u);
  const icon = await fetch(`${launched.origin}/favicon.svg`);
  assert.equal(icon.status, 200);
  assert.match(icon.headers.get("content-type") ?? "", /image\/svg\+xml/u);
  assert.equal(await icon.text(), await fs.readFile(path.join(root, "assets/brand/sfl-logo.svg"), "utf8"));
  const api = async (route, body) => {
    const response = await fetch(`${launched.origin}/api/${route}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${launched.token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, data: await response.json() };
  };
  const first = await api("network-access");
  assert.equal(first.status, 200);
  const saved = await api("network-access", { useSystemProxy: true, httpsProxy: "http://127.0.0.1:9", revision: first.data.revision });
  assert.equal(saved.status, 200);
  const stale = await api("network-access", { useSystemProxy: false, revision: first.data.revision });
  assert.equal(stale.status, 400);
  assert.match(stale.data.error, /changed in another process/u);
  const tested = await api("network-access/test", {});
  assert.equal(tested.status, 200);
  assert.equal(tested.data.configured, true);
  assert.equal(tested.data.reachable, false);
  assert.equal(tested.data.forwardingTested, false);
  await api("shutdown", {});
  console.log(`PACKAGED_LOCAL_OK ${path.basename(archive)} (${executable === bundledNode ? "bundled" : "system"} Node): HTML, favicon bytes, save conflict, and bounded proxy test`);
} finally {
  child?.kill();
  await fs.rm(scratch, { recursive: true, force: true });
}
