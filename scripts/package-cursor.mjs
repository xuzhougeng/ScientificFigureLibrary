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
const manifest = await readJson(".cursor-plugin/plugin.json");
if (manifest.version !== packageJson.version) {
  throw new Error("package.json and Cursor plugin versions differ");
}

const files = [
  ".cursor-plugin/plugin.json",
  ".cursor-plugin/mcp.json",
  ...(await commonPluginFiles()),
];
const archive = await buildArchive(files);
// Cursor discovers MCP at the plugin root by default. Keep the git source
// under .cursor-plugin/ so a checkout is not treated as a project MCP config.
archive["mcp.json"] = archive[".cursor-plugin/mcp.json"];
const candidate = await writeVerifiedZip(
  archive,
  `scientific-figure-library-cursor-${packageJson.version}.zip`,
);
const { unpacked, sha256, actualFiles } = candidate;
const packagedManifest = JSON.parse(utf8(unpacked[".cursor-plugin/plugin.json"]));
if (packagedManifest.name !== "figure-library" || packagedManifest.version !== packageJson.version) {
  throw new Error("packaged Cursor manifest identity/version is inconsistent");
}
const packagedMcp = JSON.parse(utf8(unpacked["mcp.json"]));
const nestedMcp = JSON.parse(utf8(unpacked[".cursor-plugin/mcp.json"]));
const packagedServer = packagedMcp.mcpServers?.["figure-library"];
if (
  JSON.stringify(packagedMcp) !== JSON.stringify(nestedMcp) ||
  packagedManifest.mcpServers !== "./.cursor-plugin/mcp.json" ||
  packagedServer?.type !== "stdio" ||
  packagedServer?.command !== "node" ||
  JSON.stringify(packagedServer?.args) !==
    JSON.stringify(["${PLUGIN_ROOT}/dist/index.js"])
) {
  throw new Error("packaged Cursor MCP config does not use PLUGIN_ROOT");
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
  host: "cursor",
  unpacked,
  version: packageJson.version,
});
const outputPath = await publishVerifiedZip(candidate);
console.log(
  `${outputPath}\nSHA-256 ${sha256}\nVerified ${actualFiles.length} packaged files; foreign-cwd initialize/tools-list exposed ${smoke.toolCount} tools`,
);
