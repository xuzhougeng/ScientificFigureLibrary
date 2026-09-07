import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import test from "node:test";
import { unzipSync, zipSync } from "fflate";
// @ts-expect-error -- scripts/*.mjs have no emitted declarations.
const personalModules = await import("../scripts/personal-modules-lib.mjs");
const {
  SOURCE_DATE_EPOCH,
  archiveBytes,
  buildPersonalModuleCatalog,
  dosDateTimeUtc,
  patchZipDosDateTime,
  resolvedModule,
  sha256,
  zipDeterministic,
} = personalModules;

const execFile = promisify(execFileCallback);
const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function readU32(bytes: Uint8Array, offset: number) {
  const b0 = bytes[offset];
  const b1 = bytes[offset + 1];
  const b2 = bytes[offset + 2];
  const b3 = bytes[offset + 3];
  if (b0 === undefined || b1 === undefined || b2 === undefined || b3 === undefined) {
    throw new Error("ZIP timestamp is truncated");
  }
  return (b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)) >>> 0;
}

test("deterministic ZIP timestamps use UTC rather than the host timezone", () => {
  const files = {
    "README.md": new TextEncoder().encode("hello\n"),
    "code/example.R": new TextEncoder().encode("plot(1)\n"),
  };
  const first = zipDeterministic(files);
  const second = zipDeterministic(files);
  assert.equal(sha256(first), sha256(second));
  assert.equal(readU32(first, 10), dosDateTimeUtc(SOURCE_DATE_EPOCH));
  const raw = zipSync(files, { level: 6, mtime: new Date(SOURCE_DATE_EPOCH) });
  const shifted = patchZipDosDateTime(raw, dosDateTimeUtc("2000-01-01T08:00:00.000Z"));
  assert.notEqual(sha256(shifted), sha256(zipDeterministic(files)));
  const unpacked = unzipSync(zipDeterministic(files));
  assert.equal(new TextDecoder().decode(unpacked["README.md"]), "hello\n");
});

test("catalog verification accepts an existing archive whose DOS timestamp differs", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-zip-tz-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const module = path.join(root, "modules", "ggsankeyfier-layout-color-combo");
  await fs.mkdir(path.join(module, "code"), { recursive: true });
  await fs.mkdir(path.join(module, "data"), { recursive: true });
  await fs.writeFile(path.join(module, "README.md"), "# Public module\n");
  await fs.writeFile(path.join(module, "description.md"), "A clean synthetic Sankey example.\n");
  await fs.writeFile(path.join(module, "code", "organized.R"), "plot(1:3)\n");
  await fs.writeFile(path.join(module, "data", "input.csv"), "x,y\n1,2\n");
  await fs.writeFile(path.join(module, "preview.png"), ONE_PIXEL_PNG);
  await fs.writeFile(path.join(module, "thumbnail.png"), ONE_PIXEL_PNG);
  const digest = createHash("sha256").update(ONE_PIXEL_PNG).digest("hex");
  const manifest = {
    schema: "figure-library.personal-module.v1",
    moduleId: "ggsankeyfier-layout-color-combo",
    title: "ggsankeyfier 桑基图",
    titleEn: "ggsankeyfier Sankey",
    description: "A clean synthetic Sankey example.",
    application: "Sankey plot layout and color.",
    dataProfile: "Synthetic CSV flow table.",
    plotFamily: "sankey",
    language: "R",
    tags: ["ggsankeyfier", "sankey"],
    packages: ["ggplot2", "ggsankeyfier"],
    codeFiles: ["code/organized.R"],
    inputFiles: ["data/input.csv"],
    canonicalCode: "code/organized.R",
    requiredFiles: ["README.md", "code/organized.R", "data/input.csv", "description.md", "module.yml", "preview.png"],
    files: ["README.md", "code/organized.R", "data/input.csv", "description.md", "module.yml", "preview.png", "thumbnail.png"],
    preview: { path: "preview.png", bytes: ONE_PIXEL_PNG.byteLength, sha256: digest, mediaType: "image/png" },
    thumbnail: { path: "thumbnail.png", bytes: ONE_PIXEL_PNG.byteLength, sha256: digest, mediaType: "image/png" },
    licenses: { code: "MIT", content: "CC BY 4.0", documentation: "CC BY 4.0" },
    publisher: { reviewStatus: "approved", executionStatus: "passed", executionScope: "synthetic_data" },
  };
  await fs.writeFile(path.join(module, "module.yml"), `${JSON.stringify(manifest, null, 2)}\n`);
  await execFile("git", ["init", "-q"], { cwd: root, windowsHide: true });
  await execFile("git", ["config", "user.email", "fixture@example.invalid"], { cwd: root, windowsHide: true });
  await execFile("git", ["config", "user.name", "SFL fixture"], { cwd: root, windowsHide: true });
  await execFile("git", ["add", "modules"], { cwd: root, windowsHide: true });
  await execFile("git", ["commit", "-qm", "source module"], { cwd: root, windowsHide: true });
  const sourceCommit = (await execFile("git", ["rev-parse", "HEAD"], { cwd: root, windowsHide: true, encoding: "utf8" })).stdout.trim();

  const loaded = await resolvedModule(module);
  const canonicalZip = archiveBytes(loaded);
  const shifted = patchZipDosDateTime(canonicalZip.bytes, dosDateTimeUtc("2000-01-01T08:00:00.000Z"));
  assert.notEqual(sha256(shifted), canonicalZip.sha256);
  await fs.mkdir(path.join(root, "archives"), { recursive: true });
  await fs.mkdir(path.join(root, "catalog"), { recursive: true });
  await fs.writeFile(path.join(root, "archives", "ggsankeyfier-layout-color-combo.zip"), shifted);
  await fs.writeFile(
    path.join(root, "catalog", "archive-manifest.json"),
    `${JSON.stringify({
      schema: "figure-library.personal-archive-manifest.v1",
      providerId: "io.github.jarxunlai.personal-figures",
      repository: "jarxunlai/ScientificFigureLibrary-personal",
      generatedAt: "2000-01-01T00:00:00.000Z",
      entries: [
        {
          moduleId: "ggsankeyfier-layout-color-combo",
          file: "archives/ggsankeyfier-layout-color-combo.zip",
          bytes: shifted.byteLength,
          sha256: sha256(shifted),
          files: canonicalZip.files,
          sourceCommit,
        },
      ],
    }, null, 2)}\n`,
  );
  await execFile("git", ["add", "archives", "catalog"], { cwd: root, windowsHide: true });
  await execFile("git", ["commit", "-qm", "archive with shifted DOS time"], { cwd: root, windowsHide: true });
  const archiveCommit = (await execFile("git", ["rev-parse", "HEAD"], { cwd: root, windowsHide: true, encoding: "utf8" })).stdout.trim();

  const built = await buildPersonalModuleCatalog({
    repositoryRoot: root,
    outputRoot: path.join(root, "snapshot"),
    archiveCommit,
    write: false,
  });
  assert.equal(built.catalog.modules[0].archive.sha256, sha256(shifted));
  assert.equal(built.catalog.modules[0].archive.bytes, shifted.byteLength);
});
