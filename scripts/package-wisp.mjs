#!/usr/bin/env node

import {
  assertPluginReleaseReady,
  assertPackagedGuidance,
  buildArchive,
  commonPluginFiles,
  publishVerifiedZip,
  readJson,
  root,
  smokePackagedPlugin,
  utf8,
  writeVerifiedZip,
} from "./plugin-package-lib.mjs";
import path from "node:path";

await assertPluginReleaseReady();

const packageJson = await readJson("package.json");
const manifest = await readJson(".wisp-plugin/plugin.json");
if (manifest.version !== packageJson.version) {
  throw new Error("package.json and Wisp plugin versions differ");
}

const files = [".wisp-plugin/plugin.json", ...(await commonPluginFiles())];
const archive = await buildArchive(files);
const candidate = await writeVerifiedZip(
  archive,
  `scientific-figure-library-wisp-${packageJson.version}.zip`,
);
const { unpacked, sha256, actualFiles } = candidate;
const packagedManifest = JSON.parse(utf8(unpacked[".wisp-plugin/plugin.json"]));
if (packagedManifest.id !== "figure-library" || packagedManifest.version !== packageJson.version) {
  throw new Error("packaged Wisp manifest identity/version is inconsistent");
}
assertPackagedGuidance({
  packagedReadme: utf8(unpacked["README.md"]),
  packagedProtocol: utf8(unpacked["docs/PROTOCOL.md"]),
  packagedSkill: utf8(unpacked["skills/figure-library/SKILL.md"]),
  packagedServer: utf8(unpacked["dist/index.js"]),
  packagedApp: utf8(unpacked["dist/mcp-app.html"]),
  version: packageJson.version,
});
const smoke = await smokePackagedPlugin({
  host: "wisp",
  unpacked,
  version: packageJson.version,
});
const outputPath = await publishVerifiedZip(candidate);
console.log(
  `${outputPath}\nSHA-256 ${sha256}\nVerified ${actualFiles.length} packaged files; foreign-cwd initialize/tools-list exposed ${smoke.toolCount} tools`,
);
