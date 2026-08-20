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
const pluginPaths = [
  path.join(root, ".wisp-plugin", "plugin.json"),
  path.join(root, ".codex-plugin", "plugin.json"),
  path.join(root, ".claude-plugin", "plugin.json"),
];
const skillPath = path.join(root, "skills", "figure-library", "SKILL.md");
const readmePath = path.join(root, "README.md");

const packageJson = JSON.parse(await fs.readFile(packagePath, "utf8"));
const previous = packageJson.version;
if (typeof previous !== "string" || !PRODUCT_VERSION.test(previous)) {
  throw new Error("package.json version is not a product version");
}

packageJson.version = version;
await fs.writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);

for (const pluginPath of pluginPaths) {
  const pluginJson = JSON.parse(await fs.readFile(pluginPath, "utf8"));
  pluginJson.version = version;
  await fs.writeFile(pluginPath, `${JSON.stringify(pluginJson, null, 2)}\n`);
}

const skill = await fs.readFile(skillPath, "utf8");
const nextSkill = skill.replace(
  /^# Scientific Figure Library \d+\.\d+\.\d+$/m,
  `# Scientific Figure Library ${version}`,
);
if (nextSkill === skill) {
  throw new Error("Skill title was not a current-version heading");
}
await fs.writeFile(skillPath, nextSkill);

let readme = await fs.readFile(readmePath, "utf8");
for (const host of ["wisp", "codex", "claude"]) {
  const currentZip = `scientific-figure-library-${host}-${previous}.zip`;
  const nextZip = `scientific-figure-library-${host}-${version}.zip`;
  if (readme.includes(currentZip)) readme = readme.replaceAll(currentZip, nextZip);
}
await fs.writeFile(readmePath, readme);

process.stdout.write(`set product version ${previous} -> ${version}\n`);
