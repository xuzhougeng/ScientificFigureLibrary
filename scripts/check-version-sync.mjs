#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

const LITERAL_PRODUCT_VERSION = /["'`](\d+\.\d+\.\d+)["'`]/g;
const root = path.resolve(import.meta.dirname, "..");

function fail(message) {
  throw new Error(message);
}

const packageJson = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
const version = packageJson.version;
if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
  fail(`package.json version is not a product version: ${version}`);
}

const pluginFiles = [
  [".wisp-plugin/plugin.json", "Wisp"],
  [".codex-plugin/plugin.json", "Codex"],
  [".claude-plugin/plugin.json", "Claude"],
];
for (const [relative, label] of pluginFiles) {
  const pluginJson = JSON.parse(await fs.readFile(path.join(root, relative), "utf8"));
  if (pluginJson.version !== version) {
    fail(`${label} plugin.json version ${pluginJson.version} !== package.json version ${version}`);
  }
}

const skill = await fs.readFile(path.join(root, "skills", "figure-library", "SKILL.md"), "utf8");
if (!skill.split(/\r?\n/).includes(`# Scientific Figure Library ${version}`)) {
  fail(`Skill title is not # Scientific Figure Library ${version}`);
}

const readme = await fs.readFile(path.join(root, "README.md"), "utf8");
for (const host of ["wisp", "codex", "claude"]) {
  const zip = `scientific-figure-library-${host}-${version}.zip`;
  if (!readme.includes(zip)) fail(`README does not mention the current ${host} zip ${zip}`);
}

const runtimeFiles = [
  "src/index.ts",
  "src/server.ts",
  "src/diagnostics.ts",
  "app/main.ts",
];
for (const relative of runtimeFiles) {
  const text = await fs.readFile(path.join(root, relative), "utf8");
  if (!text.includes('from "./version.ts"') && !text.includes('from "../src/version.ts"')) {
    fail(`${relative} does not import VERSION from src/version.ts`);
  }
  const literals = [...text.matchAll(LITERAL_PRODUCT_VERSION)].map((match) => match[1]);
  if (literals.length > 0) {
    fail(`${relative} still hardcodes product version literals: ${literals.join(", ")}`);
  }
}

const assertionFiles = [
  "scripts/smoke.mjs",
  "tests/server-integration.test.ts",
];
const forbiddenAssertion = [
  /serverVersion[^\n]{0,40}["'`]\d+\.\d+\.\d+["'`]/,
  /libraryVersion[^\n]{0,40}["'`]\d+\.\d+\.\d+["'`]/,
  /SERVER_VERSION: \d+\.\d+\.\d+/,
  /candidates-v\d+\.\d+\.\d+\.html/,
];
for (const relative of assertionFiles) {
  const text = await fs.readFile(path.join(root, relative), "utf8");
  if (!text.includes("package.json") && !text.includes('from "../src/version.ts"')) {
    fail(`${relative} must read package.json or import src/version.ts`);
  }
  for (const pattern of forbiddenAssertion) {
    if (pattern.test(text)) {
      fail(`${relative} still hardcodes a product-version assertion: ${pattern}`);
    }
  }
}

const versionSource = await fs.readFile(path.join(root, "src/version.ts"), "utf8");
if (
  !versionSource.includes('from "../package.json"') ||
  !versionSource.includes("export const VERSION")
) {
  fail("src/version.ts must export VERSION from package.json");
}

process.stdout.write(`version sync ok: ${version}\n`);
