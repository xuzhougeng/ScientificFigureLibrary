#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

const PRODUCT_VERSION = /^\d+\.\d+\.\d+$/;
const root = path.resolve(import.meta.dirname, "..");
const version = process.argv[2]?.trim();

if (!version || !PRODUCT_VERSION.test(version)) {
  throw new Error("usage: node scripts/version-set.mjs <x.y.z>");
}

const packagePath = path.join(root, "package.json");
const packageLockPath = path.join(root, "package-lock.json");
const pluginPaths = [
  path.join(root, ".wisp-plugin", "plugin.json"),
  path.join(root, ".codex-plugin", "plugin.json"),
  path.join(root, ".claude-plugin", "plugin.json"),
];
const skillPath = path.join(root, "skills", "figure-library", "SKILL.md");
const readmePath = path.join(root, "README.md");
const protocolPath = path.join(root, "docs", "PROTOCOL.md");

function replaceVersionedArtifacts(text, { required, label }) {
  let next = text;
  for (const host of ["wisp", "codex", "claude"]) {
    const currentZip = new RegExp(
      `scientific-figure-library-${host}-\\d+\\.\\d+\\.\\d+\\.zip`,
      "gu",
    );
    const nextZip = `scientific-figure-library-${host}-${version}.zip`;
    if (!currentZip.test(next)) {
      if (required) throw new Error(`${label} does not contain a versioned ${host} plugin ZIP`);
    } else {
      currentZip.lastIndex = 0;
      next = next.replace(currentZip, nextZip);
    }
  }
  const currentTarball = /scientific-figure-library-\d+\.\d+\.\d+\.tgz/gu;
  if (!currentTarball.test(next)) {
    if (required) throw new Error(`${label} does not contain a versioned npm tarball`);
  } else {
    currentTarball.lastIndex = 0;
    next = next.replace(currentTarball, `scientific-figure-library-${version}.tgz`);
  }
  const currentSourcePack = /figure-library-source-pack-([a-z0-9-]+)-\d+\.\d+\.\d+\.zip/gu;
  if (!currentSourcePack.test(next)) {
    if (required) throw new Error(`${label} does not contain a versioned FigureYa Source Pack example`);
  } else {
    currentSourcePack.lastIndex = 0;
    next = next.replace(
      currentSourcePack,
      (_match, name) => `figure-library-source-pack-${name}-${version}.zip`,
    );
  }
  return next;
}

const packageJson = JSON.parse(await fs.readFile(packagePath, "utf8"));
const previous = packageJson.version;
if (typeof previous !== "string" || !PRODUCT_VERSION.test(previous)) {
  throw new Error("package.json version is not a product version");
}

const packageLock = JSON.parse(await fs.readFile(packageLockPath, "utf8"));
if (
  typeof packageLock.version !== "string" ||
  !PRODUCT_VERSION.test(packageLock.version) ||
  !packageLock.packages ||
  typeof packageLock.packages[""]?.version !== "string" ||
  !PRODUCT_VERSION.test(packageLock.packages[""].version)
) {
  throw new Error("package-lock.json must contain product versions at both version locations");
}
const pluginJsons = [];
for (const pluginPath of pluginPaths) {
  const pluginJson = JSON.parse(await fs.readFile(pluginPath, "utf8"));
  if (typeof pluginJson.version !== "string" || !PRODUCT_VERSION.test(pluginJson.version)) {
    throw new Error(`${path.relative(root, pluginPath)} version is not a product version`);
  }
  pluginJsons.push({ pluginPath, pluginJson });
}

const skill = await fs.readFile(skillPath, "utf8");
if (!/^# Scientific Figure Library \d+\.\d+\.\d+$/m.test(skill)) {
  throw new Error("Skill title was not a current-version heading");
}
const nextSkill = skill.replace(
  /^# Scientific Figure Library \d+\.\d+\.\d+$/m,
  `# Scientific Figure Library ${version}`,
);

let readme = replaceVersionedArtifacts(await fs.readFile(readmePath, "utf8"), {
  required: false,
  label: "README",
});
let protocol = replaceVersionedArtifacts(await fs.readFile(protocolPath, "utf8"), {
  required: true,
  label: "docs/PROTOCOL.md",
});
protocol = protocol.replace(
  /cannot be packaged as the \d+\.\d+\.\d+ release/gu,
  `cannot be packaged as the ${version} release`,
);

// Validate every target before the first write so a malformed manifest,
// lockfile, Skill, or README cannot leave the repository half-versioned.
packageJson.version = version;
packageLock.version = version;
packageLock.packages[""].version = version;
for (const { pluginJson } of pluginJsons) pluginJson.version = version;

await fs.writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
await fs.writeFile(packageLockPath, `${JSON.stringify(packageLock, null, 2)}\n`);
for (const { pluginPath, pluginJson } of pluginJsons) {
  await fs.writeFile(pluginPath, `${JSON.stringify(pluginJson, null, 2)}\n`);
}
await fs.writeFile(skillPath, nextSkill);
await fs.writeFile(readmePath, readme);
await fs.writeFile(protocolPath, protocol);

process.stdout.write(`set product version ${previous} -> ${version}\n`);
