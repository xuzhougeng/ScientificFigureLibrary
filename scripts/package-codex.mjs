#!/usr/bin/env node

import {
  assertPackagedGuidance,
  buildArchive,
  commonPluginFiles,
  readJson,
  utf8,
  writeVerifiedZip,
} from "./plugin-package-lib.mjs";

const packageJson = await readJson("package.json");
const manifest = await readJson(".codex-plugin/plugin.json");
if (manifest.version !== packageJson.version) {
  throw new Error("package.json and Codex plugin versions differ");
}

const files = [
  ".codex-plugin/plugin.json",
  ".mcp.json",
  ...(await commonPluginFiles()),
];
const archive = await buildArchive(files);
const { unpacked, sha256, actualFiles, outputPath } = await writeVerifiedZip(
  archive,
  `scientific-figure-library-codex-${packageJson.version}.zip`,
);
const packagedManifest = JSON.parse(utf8(unpacked[".codex-plugin/plugin.json"]));
if (packagedManifest.name !== "figure-library" || packagedManifest.version !== packageJson.version) {
  throw new Error("packaged Codex manifest identity/version is inconsistent");
}
if (!utf8(unpacked[".mcp.json"]).includes('"figure-library"')) {
  throw new Error("packaged Codex MCP config omitted figure-library");
}
assertPackagedGuidance({
  packagedReadme: utf8(unpacked["README.md"]),
  packagedSkill: utf8(unpacked["skills/figure-library/SKILL.md"]),
  packagedServer: utf8(unpacked["dist/index.js"]),
  packagedApp: utf8(unpacked["dist/mcp-app.html"]),
  version: packageJson.version,
});
console.log(`${outputPath}\nSHA-256 ${sha256}\nVerified ${actualFiles.length} packaged files`);
