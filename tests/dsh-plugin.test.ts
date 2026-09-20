import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
// @ts-expect-error -- host adapters are plain JS modules without declarations.
import { apply, createSkillProvider, mcpClientConfig } from "../.dsh-plugin/index.js";

const root = path.resolve(import.meta.dirname, "..");

test("DSH adapter exposes the core Skill with a directory resource base", async () => {
  const provider = createSkillProvider();
  assert.equal(provider.name, "figure-library");
  const listed = await provider.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.name, "figure-library");
  assert.match(listed[0]?.description ?? "", /Scientific Figure Library/u);

  const skill = await provider.get(listed[0]!);
  assert.equal(skill?.name, "figure-library");
  assert.equal(skill?.provider, "figure-library");
  assert.equal(skill?.source, "bundled");
  assert.deepEqual(skill?.resourceBase, {
    kind: "directory",
    path: path.join(root, "skills", "figure-library"),
  });
  assert.match(skill?.content ?? "", /^---\r?\nname: figure-library\r?\n/u);
  assert.equal(await provider.get({ name: "missing" }), undefined);
});

test("DSH apply mounts the official MCP client against this package", () => {
  const config = mcpClientConfig();
  assert.equal(config.serverName, "figure-library");
  assert.equal(config.transport, "stdio");
  assert.equal(config.command, process.execPath);
  assert.deepEqual(config.args, [path.join(root, "dist", "index.js")]);
  assert.equal(config.failOnStartupError, false);

  const providers: unknown[] = [];
  const plugins: Array<{ name: string; config: unknown }> = [];
  const dispose = apply({
    skills: {
      registerProvider(create: () => unknown) {
        providers.push(create());
        return () => {};
      },
    },
    plugin(name: string, pluginConfig: unknown) {
      plugins.push({ name, config: pluginConfig });
      return () => {};
    },
  });
  assert.equal(providers.length, 1);
  assert.deepEqual(plugins, [{ name: "@deepseek-ai/dsh-mcp-client", config }]);
  assert.equal(typeof dispose, "function");
  dispose();
});
