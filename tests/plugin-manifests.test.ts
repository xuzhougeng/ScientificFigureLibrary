import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { VERSION } from "../src/version.ts";

const root = path.resolve(import.meta.dirname, "..");

function readJson(relative: string) {
  return JSON.parse(fs.readFileSync(path.join(root, relative), "utf8")) as Record<string, unknown>;
}

test("host plugin manifests share version, skill, and MCP identity", () => {
  const pkg = readJson("package.json");
  const wisp = readJson(".wisp-plugin/plugin.json");
  const codex = readJson(".codex-plugin/plugin.json");
  const claude = readJson(".claude-plugin/plugin.json");
  const mcp = readJson(".mcp.json");
  assert.equal(pkg.version, VERSION);
  assert.equal(wisp.version, VERSION);
  assert.equal(codex.version, VERSION);
  assert.equal(claude.version, VERSION);
  assert.equal(wisp.id, "figure-library");
  assert.equal(codex.name, "figure-library");
  assert.equal(claude.name, "figure-library");
  assert.equal(codex.skills, "./skills/");
  assert.equal(codex.mcpServers, "./.mcp.json");
  assert.deepEqual(wisp.skills, ["skills/figure-library"]);
  const servers = mcp.mcpServers as Record<string, { command?: string; args?: string[] }>;
  assert.equal(servers["figure-library"]?.command, "node");
  assert.deepEqual(servers["figure-library"]?.args, ["dist/index.js"]);
});
