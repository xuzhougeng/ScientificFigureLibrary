import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { integrationGuide } from "../src/local/integrations.ts";

const execute = promisify(execFile);
test("integration instructions use the active runtime and retain exact native paths", () => {
  for (const platform of ["win32", "darwin"] as const) {
    const node = platform === "win32" ? "C:\\Program Files\\Node's\\node.exe" : "/Applications/Node's bin/node";
    const server = platform === "win32" ? "D:\\SFL App\\dist\\index.js" : "/Applications/SFL App.app/Contents/Resources/sfl/dist/index.js";
    const guide = integrationGuide({ platform, node, server, nodeVersion: "22.23.2" });
    const json = JSON.parse(guide.snippets.find(item => item.id === "json")!.content);
    assert.equal(json.mcpServers["figure-library"].command, node);
    assert.deepEqual(json.mcpServers["figure-library"].args, [server]);
    assert.ok(guide.skillPath.endsWith(platform === "win32" ? "skills\\figure-library\\SKILL.md" : "skills/figure-library/SKILL.md"));
    assert.ok(guide.hosts.every(host => host.snippetIds.every(id => guide.snippets.some(item => item.id === id))));
    assert.deepEqual(guide.hosts.map(host => host.id), ["codex", "claude-code", "claude-desktop", "pi", "dsh", "other"]);
    assert.equal(guide.snippets.find(item => item.id === "pi-command")!.content, "pi install npm:pi-mcp-adapter");
    assert.equal(guide.snippets.find(item => item.id === "dsh-command")!.content, "dsh plugin --profile web add scientific-figure-library");
    const dshPatch = guide.snippets.find(item => item.id === "dsh-patch")!.content;
    assert.match(dshPatch, /@deepseek-ai\/dsh-mcp-client/u);
    assert.equal(dshPatch.includes(JSON.stringify(node)), true);
    assert.equal(dshPatch.includes(JSON.stringify(server)), true);
    assert.match(guide.verificationPrompt, /figure_library_get_candidate_images/u);
    if (platform === "win32") assert.match(guide.snippets.find(item => item.id === "codex-command")!.content, /Node''s/u);
  }
});

test("copyable POSIX commands preserve quotes, spaces and shell metacharacters as literal arguments", { skip: process.platform === "win32" }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-guide-command-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const capture = path.join(root, "capture.mjs"), output = path.join(root, "args.json");
  await fs.writeFile(capture, "import fs from 'node:fs'; fs.writeFileSync(process.env.SFL_CAPTURE_FILE, JSON.stringify(process.argv.slice(2)));\n");
  for (const name of ["codex", "claude"]) await fs.writeFile(path.join(root, name), `#!/bin/sh\nexec '${process.execPath}' '${capture}' "$@"\n`, { mode: 0o755 });
  const node = "/tmp/Node's $(printf BAD) `printf BAD`/node";
  const server = "/tmp/图库 App's/dist/index.js";
  const guide = integrationGuide({ platform: "darwin", node, server });
  for (const id of ["codex-command", "claude-command"]) {
    const snippet = guide.snippets.find(item => item.id === id)!;
    await execute("/bin/sh", ["-c", snippet.content], { env: { ...process.env, PATH: root, SFL_CAPTURE_FILE: output } });
    const args = JSON.parse(await fs.readFile(output, "utf8"));
    assert.deepEqual(args.slice(-3), ["--", node, server]);
    assert.ok(args.includes("figure-library"));
  }
});
