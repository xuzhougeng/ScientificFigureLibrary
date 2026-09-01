import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const repositoryRoot = path.resolve(import.meta.dirname, "..");
const versionScript = path.join(repositoryRoot, "scripts", "version-set.mjs");

const trackedTargets = [
  "package.json",
  "package-lock.json",
  ".wisp-plugin/plugin.json",
  ".codex-plugin/plugin.json",
  ".claude-plugin/plugin.json",
  "skills/figure-library/SKILL.md",
  "README.md",
  "docs/PROTOCOL.md",
];

async function write(root: string, relative: string, value: string) {
  const destination = path.join(root, relative);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, value, "utf8");
}

async function createFixture(options: { malformedLock?: boolean } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-version-script-"));
  const oldVersion = "7.8.9";
  await fs.mkdir(path.join(root, "scripts"), { recursive: true });
  await fs.copyFile(versionScript, path.join(root, "scripts", "version-set.mjs"));
  await write(root, "package.json", `${JSON.stringify({ name: "fixture", version: oldVersion }, null, 2)}\n`);
  await write(
    root,
    "package-lock.json",
    `${JSON.stringify({
      name: "fixture",
      version: oldVersion,
      lockfileVersion: 3,
      packages: options.malformedLock ? {} : { "": { name: "fixture", version: oldVersion } },
    }, null, 2)}\n`,
  );
  for (const relative of [
    ".wisp-plugin/plugin.json",
    ".codex-plugin/plugin.json",
    ".claude-plugin/plugin.json",
  ]) {
    await write(root, relative, `${JSON.stringify({ name: relative, version: oldVersion }, null, 2)}\n`);
  }
  await write(root, "skills/figure-library/SKILL.md", `# Scientific Figure Library ${oldVersion}\n`);
  const artifacts = [
    `scientific-figure-library-wisp-${oldVersion}.zip`,
    `scientific-figure-library-codex-${oldVersion}.zip`,
    `scientific-figure-library-claude-${oldVersion}.zip`,
    `scientific-figure-library-${oldVersion}.tgz`,
    `figure-library-source-pack-volcano-${oldVersion}.zip`,
  ];
  await write(root, "README.md", `${artifacts.join("\n")}\n`);
  await write(
    root,
    "docs/PROTOCOL.md",
    `${artifacts.join("\n")}\ncannot be packaged as the ${oldVersion} release.\n`,
  );
  return root;
}

async function snapshot(root: string) {
  return new Map(
    await Promise.all(
      trackedTargets.map(async (relative) => [relative, await fs.readFile(path.join(root, relative), "utf8")] as const),
    ),
  );
}

test("version:set synchronizes every release-facing product version from an arbitrary old patch", async (t) => {
  const root = await createFixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const targetVersion = "8.0.4";

  await execFile(process.execPath, [path.join(root, "scripts", "version-set.mjs"), targetVersion], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });

  const packageJson = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
  const lock = JSON.parse(await fs.readFile(path.join(root, "package-lock.json"), "utf8"));
  assert.equal(packageJson.version, targetVersion);
  assert.equal(lock.version, targetVersion);
  assert.equal(lock.packages[""].version, targetVersion);
  for (const relative of [
    ".wisp-plugin/plugin.json",
    ".codex-plugin/plugin.json",
    ".claude-plugin/plugin.json",
  ]) {
    assert.equal(JSON.parse(await fs.readFile(path.join(root, relative), "utf8")).version, targetVersion);
  }
  assert.match(
    await fs.readFile(path.join(root, "skills/figure-library/SKILL.md"), "utf8"),
    /^# Scientific Figure Library 8\.0\.4$/mu,
  );
  const expectedArtifacts = [
    `scientific-figure-library-wisp-${targetVersion}.zip`,
    `scientific-figure-library-codex-${targetVersion}.zip`,
    `scientific-figure-library-claude-${targetVersion}.zip`,
    `scientific-figure-library-${targetVersion}.tgz`,
    `figure-library-source-pack-volcano-${targetVersion}.zip`,
  ];
  const readme = await fs.readFile(path.join(root, "README.md"), "utf8");
  const protocol = await fs.readFile(path.join(root, "docs/PROTOCOL.md"), "utf8");
  for (const artifact of expectedArtifacts) {
    assert.ok(readme.includes(artifact), `README omitted ${artifact}`);
    assert.ok(protocol.includes(artifact), `PROTOCOL.md omitted ${artifact}`);
  }
  assert.match(protocol, /cannot be packaged as the 8\.0\.4 release/u);
  assert.doesNotMatch(readme, /7\.8\.9/u);
  assert.doesNotMatch(protocol, /7\.8\.9/u);
});

test("version:set rejects malformed input before writing any target", async (t) => {
  const root = await createFixture({ malformedLock: true });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const before = await snapshot(root);

  await assert.rejects(
    execFile(process.execPath, [path.join(root, "scripts", "version-set.mjs"), "8.0.4"], {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
    }),
    /package-lock\.json must contain product versions at both version locations/u,
  );

  assert.deepEqual(await snapshot(root), before);
});
