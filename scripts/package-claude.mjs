#!/usr/bin/env node

import {
  assertPackagedGuidance,
  buildArchive,
  commonPluginFiles,
  readJson,
  smokePackagedPlugin,
  utf8,
  writeVerifiedZip,
} from "./plugin-package-lib.mjs";

const packageJson = await readJson("package.json");
const manifest = await readJson(".claude-plugin/plugin.json");
if (manifest.version !== packageJson.version) {
  throw new Error("package.json and Claude plugin versions differ");
}

const files = [
  ".claude-plugin/plugin.json",
  ".claude-plugin/mcp.json",
  ...(await commonPluginFiles()),
];
const archive = await buildArchive(files);
const { unpacked, sha256, actualFiles, outputPath } = await writeVerifiedZip(
  archive,
  `scientific-figure-library-claude-${packageJson.version}.zip`,
);
const packagedManifest = JSON.parse(utf8(unpacked[".claude-plugin/plugin.json"]));
if (packagedManifest.name !== "figure-library" || packagedManifest.version !== packageJson.version) {
  throw new Error("packaged Claude manifest identity/version is inconsistent");
}
const packagedMcp = JSON.parse(utf8(unpacked[".claude-plugin/mcp.json"]));
const packagedServer = packagedMcp["figure-library"];
if (
  packagedManifest.mcpServers !== "./.claude-plugin/mcp.json" ||
  packagedServer?.command !== "node" ||
  JSON.stringify(packagedServer?.args) !==
    JSON.stringify(["${CLAUDE_PLUGIN_ROOT}/dist/index.js"])
) {
  throw new Error("packaged Claude MCP config does not use CLAUDE_PLUGIN_ROOT");
}
assertPackagedGuidance({
  packagedReadme: utf8(unpacked["README.md"]),
  packagedSkill: utf8(unpacked["skills/figure-library/SKILL.md"]),
  packagedServer: utf8(unpacked["dist/index.js"]),
  packagedApp: utf8(unpacked["dist/mcp-app.html"]),
  version: packageJson.version,
});
const smoke = await smokePackagedPlugin({
  host: "claude",
  unpacked,
  version: packageJson.version,
});
console.log(
  `${outputPath}\nSHA-256 ${sha256}\nVerified ${actualFiles.length} packaged files; foreign-cwd initialize/tools-list exposed ${smoke.toolCount} tools`,
);
