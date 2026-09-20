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
  const candidate = listed[0]!;
  assert.equal(candidate.name, "figure-library");
  assert.match(candidate.description, /Scientific Figure Library/u);
  assertDshCandidate(candidate, provider.name);

  const skill = await provider.get(candidate);
  assert.equal(skill?.name, "figure-library");
  assert.equal(skill?.provider, "figure-library");
  assert.equal(typeof skill?.source, "string");
  assert.equal(skill?.source, "bundled");
  assert.deepEqual(skill?.invocation, { modelInvocable: true, userInvocable: true });
  assert.deepEqual(skill?.resourceBase, {
    kind: "directory",
    path: path.join(root, "skills", "figure-library"),
  });
  assert.equal(skill?.path, path.join(root, "skills", "figure-library", "SKILL.md"));
  assert.match(skill?.content ?? "", /^# Scientific Figure Library /u);
  assert.doesNotMatch(skill?.content ?? "", /^---/u);
  assert.equal(await provider.get({ name: "missing" }), undefined);
});

function assertDshCandidate(candidate: {
  name?: unknown;
  description?: unknown;
  invocation?: { modelInvocable?: unknown; userInvocable?: unknown };
  source?: unknown;
  provider?: unknown;
  rank?: unknown;
  path?: unknown;
}, providerName: string) {
  assert.equal(typeof candidate.name, "string");
  assert.equal(typeof candidate.description, "string");
  assert.ok((candidate.description as string).length > 0);
  assert.equal(typeof candidate.source, "string", "dsh rejects a missing or non-string source");
  assert.equal(typeof candidate.provider, "string");
  assert.equal(candidate.provider, providerName);
  assert.equal(typeof candidate.rank, "number");
  assert.equal(Number.isFinite(candidate.rank), true);
  assert.equal(typeof candidate.invocation, "object");
  assert.equal(typeof candidate.invocation?.modelInvocable, "boolean");
  assert.equal(typeof candidate.invocation?.userInvocable, "boolean");
  if (candidate.path !== undefined) assert.equal(typeof candidate.path, "string");
}

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
