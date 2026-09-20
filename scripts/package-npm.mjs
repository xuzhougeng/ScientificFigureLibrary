#!/usr/bin/env node

import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { previewDownloadManifests } from "./preview-download-manifest.mjs";
import {
  assertExactInventory,
  assertFinalCommunitySnapshot,
  auditPackageContents,
  authoritativeNpmInventory,
  extractPackageFiles,
  publishReleaseArtifacts,
  readNpmTarball,
  runNpm,
  smokePackagedNpm,
  temporaryDirectory,
} from "./package-release-lib.mjs";

const execFile = promisify(execFileCallback);
const root = path.resolve(import.meta.dirname, "..");
const packageJson = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
const expectedName = `scientific-figure-library-${packageJson.version}.tgz`;
const GALLERY_IMAGE = /^assets\/(?!brand\/).*\.(?:png|jpe?g|webp|gif)$/iu;

// Repeat the release-only gate after build so a concurrent snapshot change
// cannot slip between the npm script's initial preflight and npm pack.
await assertFinalCommunitySnapshot({ repositoryRoot: root });

// Gallery images stay out of the tarball; the package ships the pinned download
// manifests instead, exactly like the local clients do. package.json's `!assets/...`
// entries drop the bytes and PreviewDownloadStore fetches them on demand.
const commit = (await execFile("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
const downloads = await previewDownloadManifests(
  root,
  process.env.GITHUB_REPOSITORY ?? "xuzhougeng/ScientificFigureLibrary",
  commit,
);
for (const [relative, bytes] of downloads.manifests) {
  await fs.writeFile(path.join(root, ...relative.split("/")), bytes);
}

const temporary = await temporaryDirectory("sfl npm release candidate");
try {
  const packDirectory = path.join(temporary, "npm pack output");
  const npmCache = path.join(temporary, "isolated npm cache");
  await fs.mkdir(packDirectory, { recursive: true });
  const { stdout } = await runNpm(
    root,
    ["pack", "--ignore-scripts", "--json", "--pack-destination", packDirectory],
    { env: { npm_config_cache: npmCache } },
  );
  const arrayStart = stdout.indexOf("[");
  const arrayEnd = stdout.lastIndexOf("]");
  if (arrayStart < 0 || arrayEnd < arrayStart) throw new Error("npm pack did not return JSON metadata");
  const metadata = JSON.parse(stdout.slice(arrayStart, arrayEnd + 1));
  if (
    !Array.isArray(metadata) ||
    metadata.length !== 1 ||
    metadata[0]?.filename !== expectedName ||
    metadata[0]?.name !== packageJson.name ||
    metadata[0]?.version !== packageJson.version
  ) {
    throw new Error("npm pack returned an unexpected package identity or filename");
  }

  const candidatePath = path.join(packDirectory, expectedName);
  const candidateBytes = new Uint8Array(await fs.readFile(candidatePath));
  const packedFiles = readNpmTarball(candidateBytes);
  for (const relative of packedFiles.keys()) {
    if (GALLERY_IMAGE.test(relative)) throw new Error(`npm tarball ships a downloadable gallery image: ${relative}`);
  }
  for (const relative of downloads.manifests.keys()) {
    if (!packedFiles.has(relative)) throw new Error(`npm tarball is missing its preview download manifest: ${relative}`);
  }
  const authoritative = await authoritativeNpmInventory(root);
  const inventory = assertExactInventory(packedFiles, authoritative, expectedName);
  auditPackageContents(packedFiles, { label: expectedName, repositoryRoot: root });

  const installedRoot = path.join(temporary, "installed npm package with spaces");
  await extractPackageFiles(packedFiles, installedRoot);
  const community = await assertFinalCommunitySnapshot({
    repositoryRoot: installedRoot,
    communityRoot: path.join(installedRoot, "assets", "community"),
  });
  const smoke = await smokePackagedNpm({
    packageRoot: installedRoot,
    foreignProjectDirectory: path.join(temporary, "unrelated foreign project cwd"),
    isolatedUserState: path.join(temporary, "isolated user state"),
    version: packageJson.version,
  });

  const digest = createHash("sha256").update(candidateBytes).digest("hex");
  const checksumName = `${expectedName}.sha256`;
  await publishReleaseArtifacts(root, new Map([
    [expectedName, candidateBytes],
    [checksumName, Buffer.from(`${digest}  ${expectedName}\n`, "utf8")],
  ]));
  console.log(
    `${path.join(root, "release", expectedName)}\n` +
      `SHA-256 ${digest}\n` +
      `Verified exact ${inventory.length}-file npm inventory, ${community.releaseCount} Community releases, ` +
      `and foreign-cwd initialize/tools-list with ${smoke.toolCount} tools`,
  );
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
  for (const relative of downloads.manifests.keys()) {
    await fs.rm(path.join(root, ...relative.split("/")), { force: true });
  }
}
