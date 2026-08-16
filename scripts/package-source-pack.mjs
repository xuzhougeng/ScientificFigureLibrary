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
if (new Set(moduleIds).size !== moduleIds.length) throw new Error("--modules contains duplicates");

const SHA1 = /^[a-f0-9]{40}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const manifest = JSON.parse(
  await fs.readFile(path.join(root, "assets", "figureya-source-pack.manifest.json"), "utf8"),
);
if (
  !manifest ||
  typeof manifest !== "object" ||
  !["figure-library.source-pack.v1", "figure-library.source-pack.v2"].includes(manifest.schema) ||
  !Array.isArray(manifest.archives)
) {
  throw new Error("bundled FigureYa Source Pack manifest has an unsupported shape");
}
if (
  manifest.providerId !== "org.figureya.module" &&
  !(manifest.schema === "figure-library.source-pack.v1" && manifest.sourceId === "figureya")
) {
  throw new Error("bundled Source Pack manifest does not identify the FigureYa provider");
}
if (typeof manifest.archiveRepository !== "string" || typeof manifest.archiveCommit !== "string") {
  throw new Error("bundled Source Pack manifest lacks pinned archive repository identity");
}

const expected = new Map();
for (const value of manifest.archives) {
  if (!value || typeof value !== "object" || typeof value.moduleId !== "string") {
    throw new Error("bundled Source Pack manifest contains an invalid archive entry");
  }
  if (expected.has(value.moduleId)) throw new Error(`duplicate manifest module: ${value.moduleId}`);
  if (
    typeof value.file !== "string" ||
    path.posix.basename(value.file.replaceAll("\\", "/")) !== `${value.moduleId}.zip`
  ) {
    throw new Error(`${value.moduleId}.file is invalid`);
  }
  if (!Number.isSafeInteger(value.bytes) || value.bytes <= 0) {
    throw new Error(`${value.moduleId}.bytes is invalid`);
  }
  const gitBlobSha1 =
    typeof value.gitBlobSha1 === "string" ? value.gitBlobSha1.toLocaleLowerCase() : undefined;
  const archiveSha256 =
    typeof value.sha256 === "string" ? value.sha256.toLocaleLowerCase() : undefined;
  if (gitBlobSha1 && !SHA1.test(gitBlobSha1)) throw new Error(`${value.moduleId}.gitBlobSha1 is invalid`);
  if (archiveSha256 && !SHA256.test(archiveSha256)) throw new Error(`${value.moduleId}.sha256 is invalid`);
  if (!gitBlobSha1 && !archiveSha256) {
    throw new Error(`${value.moduleId} lacks an archive integrity identity`);
  }
  expected.set(value.moduleId, {
    moduleId: value.moduleId,
    bytes: value.bytes,
    gitBlobSha1,
    sha256: archiveSha256,
  });
}

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
  const archiveSha256 = createHash("sha256").update(bytes).digest("hex");
  if (
    bytes.byteLength !== archive.bytes ||
    (archive.gitBlobSha1 && gitBlobSha1 !== archive.gitBlobSha1) ||
    (archive.sha256 && archiveSha256 !== archive.sha256)
  ) {
    throw new Error(`integrity check failed for ${moduleId}.zip`);
  }
  total += bytes.byteLength;
  if (total > 200 * 1024 * 1024) {
    throw new Error("selected starter pack exceeds 200 MiB; split it into another named pack");
  }
  entries[`archives/${moduleId}.zip`] = bytes;
  selected.push({
    moduleId,
    file: `archives/${moduleId}.zip`,
    bytes: bytes.byteLength,
    gitBlobSha1,
    sha256: archiveSha256,
  });
}

const portableManifest = {
  schema: "figure-library.source-pack.v2",
  providerId: "org.figureya.module",
  archiveRepository: manifest.archiveRepository,
  archiveCommit: manifest.archiveCommit,
  archives: selected,
};
entries["figureya-source-pack.manifest.json"] = strToU8(
  `${JSON.stringify(portableManifest, null, 2)}\n`,
);
// Keep Source Packs reproducible; input file mtimes are not part of identity.
const zip = zipSync(entries, { level: 0, mtime: new Date(2000, 0, 1, 0, 0, 0) });
const version = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")).version;
const filename = `figure-library-source-pack-${name}-${version}.zip`;
const sha256 = createHash("sha256").update(zip).digest("hex");

await fs.mkdir(release, { recursive: true });
await fs.writeFile(path.join(release, filename), zip);
await fs.writeFile(path.join(release, `${filename}.sha256`), `${sha256}  ${filename}\n`);
console.log(`${path.join(release, filename)}\nSHA-256 ${sha256}`);
