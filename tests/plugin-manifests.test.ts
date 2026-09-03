import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { VERSION } from "../src/version.ts";
// @ts-expect-error -- the packaging helper is an intentionally untyped .mjs module.
const { assertPersonalSnapshotInventory, commonPluginFiles } = await import("../scripts/plugin-package-lib.mjs");

const root = path.resolve(import.meta.dirname, "..");

function readJson(relative: string) {
  return JSON.parse(fs.readFileSync(path.join(root, relative), "utf8")) as Record<string, unknown>;
}

test("host plugin manifests share version, skill, and MCP identity", () => {
  const pkg = readJson("package.json");
  const wisp = readJson(".wisp-plugin/plugin.json");
  const codex = readJson(".codex-plugin/plugin.json");
  const claude = readJson(".claude-plugin/plugin.json");
  const codexMcp = readJson(".codex-plugin/mcp.json");
  const claudeMcp = readJson(".claude-plugin/mcp.json");
  assert.equal(pkg.version, VERSION);
  assert.equal(wisp.version, VERSION);
  assert.equal(codex.version, VERSION);
  assert.equal(claude.version, VERSION);
  assert.equal(wisp.id, "figure-library");
  assert.equal(codex.name, "figure-library");
  assert.equal(claude.name, "figure-library");
  assert.equal((pkg.files as string[]).includes(".mcp.json"), false);
  assert.equal((pkg.files as string[]).includes(".codex-plugin"), true);
  assert.equal((pkg.files as string[]).includes(".claude-plugin"), true);
  assert.equal(codex.skills, "./skills/");
  assert.equal(codex.mcpServers, "./.codex-plugin/mcp.json");
  assert.equal(claude.mcpServers, "./.claude-plugin/mcp.json");
  assert.deepEqual(wisp.skills, ["skills/figure-library"]);
  assert.equal(fs.existsSync(path.join(root, ".mcp.json")), false);

  const codexServers = codexMcp.mcpServers as Record<
    string,
    { command?: string; args?: string[]; cwd?: string }
  >;
  assert.equal(codexServers["figure-library"]?.command, "node");
  assert.deepEqual(codexServers["figure-library"]?.args, ["dist/index.js"]);
  assert.equal(codexServers["figure-library"]?.cwd, ".");

  const claudeServer = claudeMcp["figure-library"] as {
    command?: string;
    args?: string[];
    cwd?: string;
  };
  assert.equal(claudeServer.command, "node");
  assert.deepEqual(claudeServer.args, ["${CLAUDE_PLUGIN_ROOT}/dist/index.js"]);
  assert.equal(claudeServer.cwd, undefined);

  const wispServers = wisp.mcp_servers as Array<{
    id?: string;
    command?: string;
    args?: string[];
    cwd?: string;
  }>;
  assert.equal(wispServers[0]?.id, "figure-library");
  assert.equal(wispServers[0]?.command, "node");
  assert.deepEqual(wispServers[0]?.args, ["${WISP_PLUGIN_ROOT}/dist/index.js"]);
  assert.equal(wispServers[0]?.cwd, ".");

  const hostConfigs = JSON.stringify({ codexMcp, claudeMcp, wisp });
  assert.doesNotMatch(hostConfigs, /[A-Za-z]:[\\/](?:Users|home|scientific-figure-dev)[\\/]/u);
});

test("bundled personal module snapshot is declared without archive ZIPs", () => {
  const snapshot = path.join(root, "assets", "personal-modules");
  for (const relative of [
    "module-catalog.json",
    "module-preview.manifest.json",
    "module-source-pack.manifest.json",
    "PERSONAL_MODULES_LICENSE.txt",
  ]) {
    assert.equal(fs.existsSync(path.join(snapshot, relative)), true, relative);
  }
  const walk = (directory: string): string[] =>
    fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const absolute = path.join(directory, entry.name);
      return entry.isDirectory() ? walk(absolute) : [absolute];
    });
  assert.equal(
    walk(snapshot).some((file) => file.toLocaleLowerCase("en-US").endsWith(".zip")),
    false,
  );
});

test("plugin packaging rejects personal archives and undeclared snapshot files", async () => {
  const files = await commonPluginFiles();
  assert.ok(files.includes("assets/personal-modules/module-catalog.json"));
  assert.ok(files.includes("assets/personal-modules/PERSONAL_MODULES_LICENSE.txt"));
  assert.equal(files.some((file: string) => file.endsWith(".zip")), false);
  assert.throws(
    () =>
      assertPersonalSnapshotInventory(
        ["assets/personal-modules/archives/example.zip"],
        files,
      ),
    /must not enter a plugin/u,
  );
  assert.throws(
    () =>
      assertPersonalSnapshotInventory(
        ["assets/personal-modules/private-state.json"],
        files,
      ),
    /unexpected personal module snapshot file/u,
  );
  assert.throws(
    () =>
      assertPersonalSnapshotInventory(
        [],
        ["assets/personal-modules/previews/example/preview.png"],
      ),
    /missing declared personal module snapshot file/u,
  );
});
