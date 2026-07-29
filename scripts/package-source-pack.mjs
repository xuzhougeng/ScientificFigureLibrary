#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { strToU8, zipSync } from "fflate";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const root = path.resolve(import.meta.dirname, "..");
const sourceArgument = argument("--source");
const moduleArgument = argument("--modules");
const name = argument("--name") ?? "starter";
const source = sourceArgument ? path.resolve(sourceArgument) : undefined;
const moduleIds = moduleArgument?.split(",").map((value) => value.trim()).filter(Boolean);
const release = path.resolve(argument("--output") ?? path.join(root, "release"));

if (!source || !moduleIds?.length || !/^[a-z0-9-]+$/u.test(name)) {
  console.error(
    "Usage: package-source-pack.mjs --source <archive directory> " +
      "--modules <module-id,module-id> [--name starter] [--output release]",
  );
  process.exit(2);
}

const manifest = JSON.parse(
  await fs.readFile(path.join(root, "assets", "figureya-source-pack.manifest.json"), "utf8"),
);
const expected = new Map(manifest.archives.map((archive) => [archive.moduleId, archive]));
const entries = {};
const selected = [];
let total = 0;

for (const moduleId of moduleIds) {
  const archive = expected.get(moduleId);
  if (!archive) throw new Error(`unknown or unavailable module: ${moduleId}`);
  const candidates = [
    path.join(source, `${moduleId}.zip`),
    path.join(source, "archives", `${moduleId}.zip`),
  ];
  let file;
  for (const candidate of candidates) {
    try {
      if ((await fs.stat(candidate)).isFile()) {
        file = candidate;
        break;
      }
    } catch {
      // Try the other supported Source Pack layout.
    }
  }
  if (!file) throw new Error(`missing ${moduleId}.zip under ${source}`);

  const bytes = new Uint8Array(await fs.readFile(file));
  const gitBlobSha1 = createHash("sha1")
    .update(`blob ${bytes.byteLength}\0`)
    .update(bytes)
    .digest("hex");
  if (bytes.byteLength !== archive.bytes || gitBlobSha1 !== archive.gitBlobSha1) {
    throw new Error(`integrity check failed for ${moduleId}.zip`);
  }
  total += bytes.byteLength;
  if (total > 200 * 1024 * 1024) {
    throw new Error("selected starter pack exceeds 200 MiB; split it into another named pack");
  }
  entries[`archives/${moduleId}.zip`] = bytes;
  selected.push(archive);
}

entries["figureya-source-pack.manifest.json"] = strToU8(
  `${JSON.stringify({ ...manifest, archives: selected }, null, 2)}\n`,
);
const zip = zipSync(entries, { level: 0 });
const version = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")).version;
const filename = `figure-library-source-pack-${name}-${version}.zip`;
const sha256 = createHash("sha256").update(zip).digest("hex");

await fs.mkdir(release, { recursive: true });
await fs.writeFile(path.join(release, filename), zip);
await fs.writeFile(path.join(release, `${filename}.sha256`), `${sha256}  ${filename}\n`);
console.log(`${path.join(release, filename)}\nSHA-256 ${sha256}`);
