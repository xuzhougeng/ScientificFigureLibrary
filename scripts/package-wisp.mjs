#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

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
const unpacked = unzipSync(zip);
const expectedFiles = Object.keys(archive).sort();
const actualFiles = Object.keys(unpacked).sort();
if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
  throw new Error("Wisp ZIP contents differ from the authoritative package inventory");
}
for (const relative of expectedFiles) {
  const expected = archive[relative];
  const actual = unpacked[relative];
  if (
    !expected ||
    !actual ||
    createHash("sha256").update(actual).digest("hex") !==
      createHash("sha256").update(expected).digest("hex")
  ) {
    throw new Error(`Wisp ZIP byte verification failed for ${relative}`);
  }
}
const packagedManifest = JSON.parse(
  strFromU8(unpacked[".wisp-plugin/plugin.json"]),
);
if (
  packagedManifest.id !== "figure-library" ||
  packagedManifest.version !== packageJson.version
) {
  throw new Error("packaged Wisp manifest identity/version is inconsistent");
}
const packagedReadme = strFromU8(unpacked["README.md"]);
const packagedSkill = strFromU8(unpacked["skills/figure-library/SKILL.md"]);
const packagedServer = strFromU8(unpacked["dist/index.js"]);
const packagedApp = strFromU8(unpacked["dist/mcp-app.html"]);
function packagedServerHasAppUri(source, version) {
  const literalUri = `ui://figure-library/candidates-v${version}.html`;
  if (source.includes(literalUri)) return true;
  const derivedTemplate = "ui://figure-library/candidates-v${VERSION}.html";
  const hasVersion =
    source.includes(`version: "${version}"`) ||
    source.includes(`"version": "${version}"`);
  return source.includes(derivedTemplate) && hasVersion;
}

const versionedAppUri = `ui://figure-library/candidates-v${packageJson.version}.html`;
if (
  !packagedReadme.includes(`0.5.2 review truthfulness`) ||
  !packagedReadme.includes(`0.5.3 transport image adapter`) ||
  !packagedReadme.includes("figure_library_preview_working_revision") ||
  !packagedReadme.includes("canonical_preview_override_required") ||
  !packagedReadme.includes("three-part validation state") ||
  !packagedReadme.includes("Structured diagnostics and export") ||
  !packagedReadme.includes("figure_library_search_page") ||
  !packagedReadme.includes("updateModelContext.text") ||
  !packagedSkill.includes(`Scientific Figure Library ${packageJson.version}`) ||
  !packagedSkill.includes("materialization protocol v2") ||
  !packagedSkill.includes("figure_library_preview_working_revision") ||
  !packagedSkill.includes("选择并交给 Agent 审核") ||
  !packagedSkill.includes("figure_library_export_diagnostics")
) {
  throw new Error("packaged 0.3.0 guidance is incomplete");
}
if (!packagedServerHasAppUri(packagedServer, packageJson.version)) {
  throw new Error(`packaged server omitted ${versionedAppUri}`);
}
for (const marker of [
  "figure_library_search_page",
  "figure_library_preview_exact_headless",
  "figure_library_preview_working_revision",
  "updateModelContextFallback",
  "figure_library_record_ui_event",
  "figure_library_export_diagnostics",
  "transport-image-v1",
]) {
  if (!packagedServer.includes(marker)) {
    throw new Error(`packaged server omitted ${marker}`);
  }
}
for (const marker of [
  "candidate-dialog",
  "查看详情",
  "查看精确预览",
  "确认并交给 Agent",
  "选择并交给 Agent 审核",
]) {
  if (!packagedApp.includes(marker)) {
    throw new Error(`packaged MCP App omitted ${marker}`);
  }
}

const release = path.join(root, "release");
const baseName = `scientific-figure-library-wisp-${packageJson.version}.zip`;
await fs.mkdir(release, { recursive: true });
await fs.writeFile(path.join(release, baseName), zip);

const sha256 = createHash("sha256").update(zip).digest("hex");
const checksumPath = path.join(release, `${baseName}.sha256`);
await fs.writeFile(checksumPath, strToU8(`${sha256}  ${baseName}\n`));
const writtenZip = new Uint8Array(await fs.readFile(path.join(release, baseName)));
const writtenChecksum = (await fs.readFile(checksumPath, "utf8")).trim();
if (
  createHash("sha256").update(writtenZip).digest("hex") !== sha256 ||
  writtenChecksum !== `${sha256}  ${baseName}`
) {
  throw new Error("written Wisp ZIP or SHA-256 sidecar failed verification");
}
console.log(
  `${path.join(release, baseName)}\nSHA-256 ${sha256}\nVerified ${actualFiles.length} packaged files`,
);
