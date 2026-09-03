import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import YAML from "yaml";
import { VERSION } from "../src/version.ts";
// @ts-expect-error -- the packaging helper is an intentionally untyped .mjs module.
const { assertPersonalSnapshotInventory, commonPluginFiles } = await import("../scripts/plugin-package-lib.mjs");

const root = path.resolve(import.meta.dirname, "..");
const WEBSITE = "https://xuzhougeng.github.io/ScientificFigureLibrary/";
const REPOSITORY = "https://github.com/xuzhougeng/ScientificFigureLibrary";
const DEVELOPERS = "xuzhougeng and jarxunlai";
const BRAND_ASSET = "assets/brand/sfl-logo.svg";

function readJson(relative: string) {
  return JSON.parse(fs.readFileSync(path.join(root, relative), "utf8")) as Record<string, unknown>;
}

test("host plugin manifests share version, skill, and MCP identity", () => {
  const pkg = readJson("package.json");
  const wisp = readJson(".wisp-plugin/plugin.json");
  const codex = readJson(".codex-plugin/plugin.json");
  const claude = readJson(".claude-plugin/plugin.json");
  const codexMcp = readJson(".mcp.json");
  const claudeMcp = readJson(".claude-plugin/mcp.json");
  assert.equal(pkg.version, VERSION);
  assert.equal(wisp.version, VERSION);
  assert.equal(codex.version, VERSION);
  assert.equal(claude.version, VERSION);
  assert.equal(wisp.id, "figure-library");
  assert.equal(codex.name, "figure-library");
  assert.equal(claude.name, "figure-library");
  assert.equal((pkg.files as string[]).includes(".mcp.json"), true);
  assert.equal((pkg.files as string[]).includes(".codex-plugin"), true);
  assert.equal((pkg.files as string[]).includes(".claude-plugin"), true);
  assert.equal(codex.skills, "./skills/");
  assert.equal(codex.mcpServers, "./.mcp.json");
  assert.equal(claude.mcpServers, "./.claude-plugin/mcp.json");
  assert.deepEqual(wisp.skills, ["skills/figure-library"]);
  assert.equal(fs.existsSync(path.join(root, ".mcp.json")), true);

  assert.equal(pkg.homepage, WEBSITE);
  assert.equal(pkg.author, DEVELOPERS);
  assert.equal((pkg.repository as { url?: string }).url, REPOSITORY);

  const codexAuthor = codex.author as { name?: string; url?: string };
  const codexInterface = codex.interface as Record<string, unknown>;
  assert.equal(codex.homepage, WEBSITE);
  assert.equal(codex.repository, REPOSITORY);
  assert.equal(codexAuthor.name, DEVELOPERS);
  assert.equal(codexInterface.developerName, DEVELOPERS);
  assert.equal(codexInterface.websiteURL, WEBSITE);
  assert.equal(codexInterface.composerIcon, `./${BRAND_ASSET}`);
  assert.equal(codexInterface.logo, `./${BRAND_ASSET}`);
  assert.equal(codexInterface.logoDark, `./${BRAND_ASSET}`);
  assert.equal(codexInterface.brandColor, "#246C4E");
  assert.deepEqual(codexInterface.screenshots, []);

  assert.equal((claude.author as { name?: string }).name, DEVELOPERS);
  assert.equal(claude.homepage, WEBSITE);
  assert.equal(claude.repository, REPOSITORY);
  assert.equal("interface" in claude, false);
  assert.equal(wisp.author, DEVELOPERS);
  assert.equal("homepage" in wisp, false);
  assert.equal("logo" in wisp, false);

  const codexServers = codexMcp.mcpServers as Record<
    string,
    { command?: string; args?: string[]; cwd?: string }
  >;
  assert.equal(codexServers["figure-library"]?.command, "node");
  assert.deepEqual(codexServers["figure-library"]?.args, ["dist/index.js"]);
  assert.equal(codexServers["figure-library"]?.cwd, ".");

  const claudeServer = claudeMcp["figure-library"] as {
    command?: string;
    args?: string[];
    cwd?: string;
  };
  assert.equal(claudeServer.command, "node");
  assert.deepEqual(claudeServer.args, ["${CLAUDE_PLUGIN_ROOT}/dist/index.js"]);
  assert.equal(claudeServer.cwd, undefined);

  const wispServers = wisp.mcp_servers as Array<{
    id?: string;
    command?: string;
    args?: string[];
    cwd?: string;
  }>;
  assert.equal(wispServers[0]?.id, "figure-library");
  assert.equal(wispServers[0]?.command, "node");
  assert.deepEqual(wispServers[0]?.args, ["${WISP_PLUGIN_ROOT}/dist/index.js"]);
  assert.equal(wispServers[0]?.cwd, ".");

  const hostConfigs = JSON.stringify({ codexMcp, claudeMcp, wisp });
  assert.doesNotMatch(hostConfigs, /[A-Za-z]:[\\/](?:Users|home|scientific-figure-dev)[\\/]/u);
});

test("brand and Skill UI assets are self-contained, portable, and consistent", async () => {
  const canonical = fs.readFileSync(path.join(root, BRAND_ASSET));
  const canonicalText = canonical.toString("utf8");
  assert.ok(canonical.byteLength > 0 && canonical.byteLength < 32 * 1024);
  assert.match(canonicalText.trimStart(), /^(?:<\?xml[^>]*>\s*)?<svg\b/iu);
  assert.doesNotMatch(canonicalText, /<script\b|<image\b|<foreignObject\b/iu);
  assert.doesNotMatch(
    canonicalText,
    /(?:href|src|xlink:href)\s*=\s*["']https?:\/\//iu,
  );

  const skillDirectories = fs
    .readdirSync(path.join(root, "skills"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  assert.ok(skillDirectories.includes("figure-library"));
  for (const skillName of skillDirectories) {
    const skillRoot = path.join(root, "skills", skillName);
    if (!fs.existsSync(path.join(skillRoot, "SKILL.md"))) continue;
    const metadataPath = path.join(skillRoot, "agents", "openai.yaml");
    const logoPath = path.join(skillRoot, "assets", "sfl-logo.svg");
    assert.equal(fs.existsSync(metadataPath), true, `${skillName} openai.yaml`);
    assert.equal(fs.existsSync(logoPath), true, `${skillName} brand asset`);
    assert.deepEqual(fs.readFileSync(logoPath), canonical, `${skillName} Logo bytes`);
    const metadata = YAML.parse(fs.readFileSync(metadataPath, "utf8")) as {
      interface?: Record<string, unknown>;
    };
    assert.equal(metadata.interface?.brand_color, "#246C4E");
    assert.equal(metadata.interface?.icon_small, "./assets/sfl-logo.svg");
    assert.equal(metadata.interface?.icon_large, "./assets/sfl-logo.svg");
    assert.match(String(metadata.interface?.default_prompt ?? ""), /\$figure-library/u);
  }

  const codex = readJson(".codex-plugin/plugin.json");
  const iconPaths = ["composerIcon", "logo", "logoDark"].map(
    (field) => String((codex.interface as Record<string, unknown>)[field]),
  );
  for (const iconPath of iconPaths) {
    assert.match(iconPath, /^\.\/[A-Za-z0-9._/-]+$/u);
    assert.equal(iconPath.includes(".."), false);
    assert.equal(path.posix.isAbsolute(iconPath), false);
    assert.equal(fs.existsSync(path.join(root, iconPath)), true);
  }

  const files = await commonPluginFiles();
  for (const required of [
    BRAND_ASSET,
    "skills/figure-library/agents/openai.yaml",
    "skills/figure-library/assets/sfl-logo.svg",
  ]) {
    assert.ok(files.includes(required), required);
  }
});

test("bundled personal module snapshot is declared without archive ZIPs", () => {
  const snapshot = path.join(root, "assets", "personal-modules");
  for (const relative of [
    "module-catalog.json",
    "module-preview.manifest.json",
    "module-source-pack.manifest.json",
    "PERSONAL_MODULES_LICENSE.txt",
  ]) {
    assert.equal(fs.existsSync(path.join(snapshot, relative)), true, relative);
  }
  const walk = (directory: string): string[] =>
    fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const absolute = path.join(directory, entry.name);
      return entry.isDirectory() ? walk(absolute) : [absolute];
    });
  assert.equal(
    walk(snapshot).some((file) => file.toLocaleLowerCase("en-US").endsWith(".zip")),
    false,
  );
});

test("plugin packaging rejects personal archives and undeclared snapshot files", async () => {
  const files = await commonPluginFiles();
  assert.ok(files.includes("assets/personal-modules/module-catalog.json"));
  assert.ok(files.includes("assets/personal-modules/PERSONAL_MODULES_LICENSE.txt"));
  assert.equal(files.some((file: string) => file.endsWith(".zip")), false);
  assert.throws(
    () =>
      assertPersonalSnapshotInventory(
        ["assets/personal-modules/archives/example.zip"],
        files,
      ),
    /must not enter a plugin/u,
  );
  assert.throws(
    () =>
      assertPersonalSnapshotInventory(
        ["assets/personal-modules/private-state.json"],
        files,
      ),
    /unexpected personal module snapshot file/u,
  );
  assert.throws(
    () =>
      assertPersonalSnapshotInventory(
        [],
        ["assets/personal-modules/previews/example/preview.png"],
      ),
    /missing declared personal module snapshot file/u,
  );
});
