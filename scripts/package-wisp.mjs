#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { strToU8, zipSync } from "fflate";

const root = path.resolve(import.meta.dirname, "..");
const packageJson = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
const manifest = JSON.parse(
  await fs.readFile(path.join(root, ".wisp-plugin", "plugin.json"), "utf8"),
);

if (manifest.version !== packageJson.version) {
  throw new Error("package.json and Wisp plugin versions differ");
}

const files = [
  ".wisp-plugin/plugin.json",
  "dist/index.js",
  "dist/mcp-app.html",
  "docs/GLOBAL_LIBRARY_0.5.md",
  "skills/figure-library/SKILL.md",
  "assets/catalog.json",
  "assets/FIGUREYA_LICENSE.txt",
  "assets/figureya-preview.manifest.json",
  "assets/figureya-source-pack.manifest.json",
  "LICENSE",
  "README.md",
  "THIRD_PARTY_NOTICES.md",
];

async function walk(directory, prefix) {
  const result = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) result.push(...(await walk(absolute, relative)));
    else if (entry.isFile()) result.push(relative);
  }
  return result;
}

files.push(...(await walk(path.join(root, "assets", "thumbs"), "assets/thumbs")));

const archive = {};
for (const relative of files.sort()) {
  archive[relative] = new Uint8Array(await fs.readFile(path.join(root, relative)));
}

// ZIP stores local wall-clock fields. A fixed local date keeps byte-for-byte
// output stable across repeated builds without depending on the source mtimes.
const zip = zipSync(archive, { level: 6, mtime: new Date(2000, 0, 1, 0, 0, 0) });
const release = path.join(root, "release");
const baseName = `scientific-figure-library-wisp-${packageJson.version}.zip`;
await fs.mkdir(release, { recursive: true });
await fs.writeFile(path.join(release, baseName), zip);

const sha256 = createHash("sha256").update(zip).digest("hex");
await fs.writeFile(path.join(release, `${baseName}.sha256`), strToU8(`${sha256}  ${baseName}\n`));
console.log(`${path.join(release, baseName)}\nSHA-256 ${sha256}`);
