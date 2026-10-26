import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { DefaultProviderRegistry, FigureYaProviderAdapter, LocalPublishedProviderAdapter } from "../src/provider-registry.ts";
import { createServer } from "../src/server.ts";
import { includesTool, PROFILE_TOOL_NAMES, resolveToolProfile, TOOL_PROFILE_ENV, type ToolProfile } from "../src/tool-profiles.ts";
// @ts-expect-error The release helper is an untyped ESM script.
import { STANDARD_TOOL_NAMES } from "../scripts/package-release-lib.mjs";

const standard = new Set<string>(STANDARD_TOOL_NAMES as string[]);

test("tool profile resolution defaults to full and rejects unknown values", () => {
  assert.equal(resolveToolProfile({}), "full");
  assert.equal(resolveToolProfile({ [TOOL_PROFILE_ENV]: " " }), "full");
  for (const value of ["use", "author", "full"]) assert.equal(resolveToolProfile({ [TOOL_PROFILE_ENV]: value }), value);
  assert.throws(() => resolveToolProfile({ [TOOL_PROFILE_ENV]: "minimal" }), /SFL_TOOL_PROFILE must be one of use, author, full/u);
  assert.equal(includesTool("full", "figure_library_tool_added_later"), true);
  assert.equal(includesTool("use", "figure_library_plan_publish"), false);
});

test("profile lists only name standard tools and nest use inside author", () => {
  for (const [profile, names] of Object.entries(PROFILE_TOOL_NAMES)) {
    for (const name of names) assert.ok(standard.has(name), `${profile} lists unknown tool ${name}`);
  }
  for (const name of PROFILE_TOOL_NAMES.use) assert.ok(PROFILE_TOOL_NAMES.author.has(name), `${name} is in use but not author`);
  // The App's own component tools must stay registered wherever the App can open.
  for (const name of ["figure_library_preview_exact", "figure_library_confirm_selection", "figure_library_record_ui_event"]) {
    assert.ok(PROFILE_TOOL_NAMES.use.has(name));
  }
  assert.equal(PROFILE_TOOL_NAMES.use.has("figure_library_plan_publish"), false);
  assert.equal(PROFILE_TOOL_NAMES.author.has("figure_library_plan_publish"), true);
  assert.equal(PROFILE_TOOL_NAMES.author.has("figure_library_plan_open_figure_module_pr"), false);
});

test("MCP server registers exactly the selected profile and says so in its instructions", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-tool-profiles-"));
  const overrides = {
    FIGURE_LIBRARY_DIR: path.join(root, "library"), FIGURE_WORKSPACE_DIR: path.join(root, "workspace"),
    SFL_WORKSPACE_LOCATOR_PATH: path.join(root, "config/workspace-locator.json"),
    SFL_DIAGNOSTICS_DIR: path.join(root, "diagnostics"),
    XDG_CONFIG_HOME: path.join(root, "config"), XDG_DATA_HOME: path.join(root, "data"),
    APPDATA: path.join(root, "config"), LOCALAPPDATA: path.join(root, "data"),
    // No background update check or catalog refresh may write into root while it is removed.
    SFL_OPEN_FIGURE_AUTO_REFRESH: "0", SFL_MCP_UPDATE_NOTICES: "0",
  };
  const previous = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  const listed = async (toolProfile: ToolProfile) => {
    const server = await createServer({ toolProfile, registry: new DefaultProviderRegistry([new LocalPublishedProviderAdapter(), new FigureYaProviderAdapter()]) });
    const client = new Client({ name: "profile-host", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    await client.connect(a);
    try {
      const tools = (await client.listTools()).tools;
      return { names: tools.map((tool) => tool.name).sort(), bytes: JSON.stringify(tools).length, instructions: client.getInstructions() ?? "" };
    } finally {
      await client.close();
      await server.close();
    }
  };
  try {
    const full = await listed("full");
    assert.deepEqual(full.names, [...standard].sort());
    assert.doesNotMatch(full.instructions, /tool profile/u);
    for (const profile of ["use", "author"] as const) {
      const result = await listed(profile);
      assert.deepEqual(result.names, [...PROFILE_TOOL_NAMES[profile]].sort());
      assert.match(result.instructions, new RegExp(`'${profile}' tool profile`, "u"));
      assert.ok(result.bytes < full.bytes);
    }
    // The use profile drops most of the schema payload a host has to load per session.
    assert.ok((await listed("use")).bytes < full.bytes * 0.4);
  } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await fs.rm(root, { recursive: true, force: true });
  }
});
