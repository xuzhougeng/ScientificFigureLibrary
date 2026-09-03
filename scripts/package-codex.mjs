#!/usr/bin/env node

import {
  assertPluginReleaseReady,
  assertPackagedGuidance,
  buildArchive,
  commonPluginFiles,
  publishVerifiedZip,
  readJson,
  smokePackagedPlugin,
  utf8,
  writeVerifiedZip,
} from "./plugin-package-lib.mjs";

await assertPluginReleaseReady();

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
const candidate = await writeVerifiedZip(
  archive,
  `scientific-figure-library-codex-${packageJson.version}.zip`,
);
const { unpacked, sha256, actualFiles } = candidate;
const packagedManifest = JSON.parse(utf8(unpacked[".codex-plugin/plugin.json"]));
if (packagedManifest.name !== "figure-library" || packagedManifest.version !== packageJson.version) {
  throw new Error("packaged Codex manifest identity/version is inconsistent");
}
const packagedMcp = JSON.parse(utf8(unpacked[".mcp.json"]));
const packagedServer = packagedMcp.mcpServers?.["figure-library"];
if (
  packagedManifest.mcpServers !== "./.mcp.json" ||
  packagedServer?.command !== "node" ||
  JSON.stringify(packagedServer?.args) !== JSON.stringify(["dist/index.js"]) ||
  packagedServer?.cwd !== "."
) {
  throw new Error("packaged Codex MCP config is not rooted at the plugin directory");
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
  host: "codex",
  unpacked,
  version: packageJson.version,
});
const outputPath = await publishVerifiedZip(candidate);
console.log(
  `${outputPath}\nSHA-256 ${sha256}\nVerified ${actualFiles.length} packaged files; foreign-cwd initialize/tools-list exposed ${smoke.toolCount} tools`,
);
