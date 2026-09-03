import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import {
  assertFinalCommunitySnapshot,
  assertExactToolInventory,
  auditPackageContents,
  publishArtifactsToDirectory,
  publishReleaseArtifacts,
} from "./package-release-lib.mjs";
import {
  ModuleCatalogIndex,
  PERSONAL_MODULE_REPOSITORY,
} from "../src/module-catalog.ts";
import { PERSONAL_MODULE_PROVIDER_ID } from "../src/providers.ts";

export const root = path.resolve(import.meta.dirname, "..");

/**
 * Host-specific package scripts are public release entrypoints too. Recheck
 * the final bundled Community snapshot after build and before any candidate is
 * written so an empty development bootstrap cannot be labelled as the current product version.
 */
export async function assertPluginReleaseReady() {
  return assertFinalCommunitySnapshot({ repositoryRoot: root });
}

export async function readJson(relative) {
  return JSON.parse(await fs.readFile(path.join(root, relative), "utf8"));
}

export async function walk(directory, prefix) {
  const result = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) result.push(...(await walk(absolute, relative)));
    else if (entry.isFile()) result.push(relative);
  }
  return result;
}

export function assertPersonalSnapshotInventory(snapshotFiles, declaredFiles) {
  const personalArchives = snapshotFiles.filter((relative) =>
    relative.toLocaleLowerCase("en-US").endsWith(".zip"),
  );
  if (personalArchives.length) {
    throw new Error(
      `personal module archive ZIPs must not enter a plugin: ${personalArchives.join(", ")}`,
    );
  }
  const declared = new Set(declaredFiles);
  for (const relative of snapshotFiles) {
    if (!declared.has(relative)) {
      throw new Error(`unexpected personal module snapshot file: ${relative}`);
    }
  }
  const snapshot = new Set(snapshotFiles);
  for (const relative of declared) {
    if (relative.startsWith("assets/personal-modules/") && !snapshot.has(relative)) {
      throw new Error(`missing declared personal module snapshot file: ${relative}`);
    }
  }
}

export async function commonPluginFiles() {
  await ModuleCatalogIndex.load(
    path.join(root, "assets", "personal-modules"),
    {
      expectedProviderId: PERSONAL_MODULE_PROVIDER_ID,
      expectedRepository: PERSONAL_MODULE_REPOSITORY,
      validatePreviews: true,
    },
  );
  const files = [
    "dist/index.js",
    "dist/mcp-app.html",
    "docs/GLOBAL_LIBRARY_0.6.md",
    "docs/PROTOCOL.md",
    "skills/figure-library/SKILL.md",
    "assets/catalog.json",
    "assets/FIGUREYA_LICENSE.txt",
    "assets/figureya-preview.manifest.json",
    "assets/figureya-source-pack.manifest.json",
    "assets/personal-modules/module-catalog.json",
    "assets/personal-modules/module-preview.manifest.json",
    "assets/personal-modules/module-source-pack.manifest.json",
    "assets/personal-modules/PERSONAL_MODULES_LICENSE.txt",
    "LICENSE",
    "README.md",
    "THIRD_PARTY_NOTICES.md",
  ];
  files.push(...(await walk(path.join(root, "assets", "thumbs"), "assets/thumbs")));
  const personalPreviewManifest = await readJson(
    "assets/personal-modules/module-preview.manifest.json",
  );
  if (
    personalPreviewManifest.schema !== "figure-library.module-preview-manifest.v1" ||
    !Array.isArray(personalPreviewManifest.entries)
  ) {
    throw new Error("personal module preview manifest is invalid for packaging");
  }
  const personalPreviewFiles = personalPreviewManifest.entries.map((entry, index) => {
    if (
      !entry ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      (entry.role !== "primary" && entry.role !== "thumbnail") ||
      typeof entry.path !== "string" ||
      !entry.path ||
      entry.path.includes("\\") ||
      path.posix.isAbsolute(entry.path) ||
      path.posix.normalize(entry.path) !== entry.path ||
      entry.path.split("/").some((segment) => !segment || segment === "." || segment === "..") ||
      (entry.role === "primary" && !entry.path.startsWith("previews/")) ||
      (entry.role === "thumbnail" && !entry.path.startsWith("thumbs/"))
    ) {
      throw new Error(`personal module preview manifest entry ${index} has an invalid path`);
    }
    return `assets/personal-modules/${entry.path}`;
  });
  if (new Set(personalPreviewFiles).size !== personalPreviewFiles.length) {
    throw new Error("personal module preview manifest contains duplicate paths");
  }
  files.push(...personalPreviewFiles);
  const personalSnapshotFiles = await walk(
    path.join(root, "assets", "personal-modules"),
    "assets/personal-modules",
  );
  assertPersonalSnapshotInventory(personalSnapshotFiles, files);
  files.push(...(await walk(path.join(root, "assets", "community"), "assets/community")));
  return files;
}

export function packagedServerHasAppUri(source, version) {
  const literalUri = `ui://figure-library/candidates-v${version}.html`;
  if (source.includes(literalUri)) return true;
  const derivedTemplate = "ui://figure-library/candidates-v${VERSION}.html";
  const hasVersion =
    source.includes(`version: "${version}"`) || source.includes(`"version": "${version}"`);
  return source.includes(derivedTemplate) && hasVersion;
}

export function assertPackagedGuidance({ packagedReadme, packagedProtocol, packagedSkill, packagedServer, packagedApp, version }) {
  const versionedAppUri = `ui://figure-library/candidates-v${version}.html`;
  if (
    !packagedReadme.includes("local-first") ||
    !packagedReadme.includes("docs/QUICKSTART.md") ||
    !packagedProtocol.includes("0.5.2 review truthfulness") ||
    !packagedProtocol.includes("0.5.3 transport image adapter") ||
    !packagedProtocol.includes("figure_library_preview_working_revision") ||
    !packagedProtocol.includes("canonical_preview_override_required") ||
    !packagedProtocol.includes("three-part validation state") ||
    !packagedProtocol.includes("Structured diagnostics and export") ||
    !packagedProtocol.includes("figure_library_search_page") ||
    !packagedProtocol.includes("figure_library_list_provider_sources") ||
    !packagedProtocol.includes("figure_library_plan_publication_export") ||
    !packagedProtocol.includes("figure_library_plan_publication_pr") ||
    !packagedProtocol.includes("updateModelContext.text") ||
    !packagedSkill.includes(`Scientific Figure Library ${version}`) ||
    !packagedSkill.includes("materialization protocol v2") ||
    !packagedSkill.includes("bundled Community") ||
    !packagedSkill.includes("Open Figure Modules") ||
    !packagedSkill.includes("includeInDefaultSearch") ||
    !packagedSkill.includes("module-archive.v1") ||
    !packagedSkill.includes("figure_library_plan_provider_source_change") ||
    !packagedSkill.includes("figure_library_plan_publication_export") ||
    !packagedSkill.includes("figure_library_plan_publication_pr") ||
    !packagedSkill.includes("figure_library_preview_working_revision") ||
    !packagedSkill.includes("选择并交给 Agent 审核") ||
    !packagedSkill.includes("figure_library_export_diagnostics")
  ) {
    throw new Error("packaged current-version guidance is incomplete");
  }
  if (!packagedServerHasAppUri(packagedServer, version)) {
    throw new Error(`packaged server omitted ${versionedAppUri}`);
  }
  for (const marker of [
    "figure_library_search_page",
    "figure_library_preview_exact_headless",
    "figure_library_preview_working_revision",
    "updateModelContextFallback",
    "figure_library_record_ui_event",
    "figure_library_export_diagnostics",
    "figure_library_list_provider_sources",
    "figure_library_plan_provider_source_change",
    "figure_library_plan_publication_export",
    "figure_library_plan_publication_pr",
    "io.github.jarxunlai.personal-figures",
    "module-archive.v1",
    "Open Figure Modules",
    "transport-image-v1",
    "requestDisplayMode",
  ]) {
    if (!packagedServer.includes(marker) && !packagedApp.includes(marker)) {
      throw new Error(`packaged server omitted ${marker}`);
    }
  }
  for (const marker of [
    "candidate-dialog",
    "查看详情",
    "查看精确预览",
    "确认并交给 Agent",
    "选择并交给 Agent 审核",
    "展开浏览",
    "保持可见",
    "data-display-mode",
  ]) {
    if (!packagedApp.includes(marker)) {
      throw new Error(`packaged MCP App omitted ${marker}`);
    }
  }
}

export async function buildArchive(relativeFiles) {
  const archive = {};
  for (const relative of [...relativeFiles].sort()) {
    archive[relative] = new Uint8Array(await fs.readFile(path.join(root, relative)));
  }
  return archive;
}

export async function writeVerifiedZip(archive, baseName) {
  const zip = zipSync(archive, { level: 6, mtime: new Date(2000, 0, 1, 0, 0, 0) });
  const unpacked = unzipSync(zip);
  const expectedFiles = Object.keys(archive).sort();
  const actualFiles = Object.keys(unpacked).sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    throw new Error(`${baseName} contents differ from the authoritative package inventory`);
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
      throw new Error(`${baseName} byte verification failed for ${relative}`);
    }
  }
  auditPackageContents(unpacked, { label: baseName, repositoryRoot: root });
  const sha256 = createHash("sha256").update(zip).digest("hex");
  return {
    unpacked,
    zip,
    sha256,
    actualFiles,
    baseName,
    outputPath: path.join(root, "release", baseName),
  };
}

export async function publishVerifiedZip(candidate) {
  const checksumName = `${candidate.baseName}.sha256`;
  const stagingDirectory = process.env.SFL_RELEASE_STAGING_DIR;
  const publish = stagingDirectory
    ? publishArtifactsToDirectory(stagingDirectory, new Map([
        [candidate.baseName, candidate.zip],
        [checksumName, strToU8(`${candidate.sha256}  ${candidate.baseName}\n`)],
      ]))
    : publishReleaseArtifacts(root, new Map([
        [candidate.baseName, candidate.zip],
        [checksumName, strToU8(`${candidate.sha256}  ${candidate.baseName}\n`)],
      ]));
  await publish;
  const releaseDirectory = stagingDirectory
    ? path.resolve(stagingDirectory)
    : path.join(root, "release");
  candidate.outputPath = path.join(releaseDirectory, candidate.baseName);
  /* The bytes were audited before this point; now verify the filesystem
   * transaction that will either be the final release or an all-host staging
   * directory owned by package-plugins.mjs. */
  const writtenZip = new Uint8Array(await fs.readFile(candidate.outputPath));
  const writtenChecksum = (
    await fs.readFile(path.join(releaseDirectory, checksumName), "utf8")
  ).trim();
  if (
    createHash("sha256").update(writtenZip).digest("hex") !== candidate.sha256 ||
    writtenChecksum !== `${candidate.sha256}  ${candidate.baseName}`
  ) {
    throw new Error(`written ${candidate.baseName} or SHA-256 sidecar failed verification`);
  }
  return candidate.outputPath;
}

export function utf8(bytes) {
  return strFromU8(bytes);
}

function replacePluginRoot(value, variable, pluginRoot) {
  return value.replaceAll(variable, pluginRoot.replaceAll("\\", "/"));
}

async function extractArchive(unpacked, pluginRoot) {
  for (const [relative, bytes] of Object.entries(unpacked)) {
    const target = path.join(pluginRoot, ...relative.split("/"));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, bytes);
  }
}

async function readInstalledJson(pluginRoot, relative) {
  return JSON.parse(await fs.readFile(path.resolve(pluginRoot, relative), "utf8"));
}

async function resolveInstalledMcpServer(host, pluginRoot, foreignProjectDirectory) {
  if (host === "codex") {
    const manifest = await readInstalledJson(pluginRoot, ".codex-plugin/plugin.json");
    const config = await readInstalledJson(pluginRoot, manifest.mcpServers);
    const server = config.mcpServers?.["figure-library"];
    return {
      ...server,
      cwd: path.resolve(pluginRoot, server.cwd),
      observedTaskCwd: foreignProjectDirectory,
    };
  }
  if (host === "claude") {
    const manifest = await readInstalledJson(pluginRoot, ".claude-plugin/plugin.json");
    const config = await readInstalledJson(pluginRoot, manifest.mcpServers);
    const server = config["figure-library"];
    return {
      ...server,
      args: server.args.map((argument) =>
        replacePluginRoot(argument, "${CLAUDE_PLUGIN_ROOT}", pluginRoot),
      ),
      cwd: foreignProjectDirectory,
      observedTaskCwd: foreignProjectDirectory,
    };
  }
  if (host === "wisp") {
    const manifest = await readInstalledJson(pluginRoot, ".wisp-plugin/plugin.json");
    const server = manifest.mcp_servers?.find((candidate) => candidate.id === "figure-library");
    return {
      ...server,
      args: server.args.map((argument) =>
        replacePluginRoot(argument, "${WISP_PLUGIN_ROOT}", pluginRoot),
      ),
      cwd: foreignProjectDirectory,
      observedTaskCwd: foreignProjectDirectory,
    };
  }
  throw new Error(`unsupported plugin smoke host: ${host}`);
}

function withTimeout(promise, milliseconds, label) {
  let timeout;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error(`${label} timed out after ${milliseconds} ms`)), milliseconds);
    }),
  ]).finally(() => clearTimeout(timeout));
}

/**
 * Extract a built plugin to a path containing spaces, simulate the Host's
 * plugin-root contract while the task cwd is a different project, and perform
 * real MCP initialize + tools/list exchanges with the packaged stdio server.
 */
export async function smokePackagedPlugin({ host, unpacked, version }) {
  auditPackageContents(unpacked, { label: `${host} plugin`, repositoryRoot: root });
  const smokeDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), `scientific figure library ${host} plugin smoke-`),
  );
  const pluginRoot = path.join(smokeDirectory, "installed plugin with spaces");
  const foreignProjectDirectory = path.join(smokeDirectory, "unrelated project cwd");
  const isolatedUserState = path.join(smokeDirectory, "isolated user state");
  await fs.mkdir(pluginRoot, { recursive: true });
  await fs.mkdir(foreignProjectDirectory, { recursive: true });
  await fs.mkdir(isolatedUserState, { recursive: true });

  let client;
  let stderr = "";
  try {
    await extractArchive(unpacked, pluginRoot);
    const server = await resolveInstalledMcpServer(host, pluginRoot, foreignProjectDirectory);
    if (server.command !== "node" || !Array.isArray(server.args) || !server.args.length) {
      throw new Error(`${host} MCP server command/args are incomplete`);
    }
    if (server.observedTaskCwd !== foreignProjectDirectory) {
      throw new Error(`${host} smoke did not begin from the foreign task cwd`);
    }
    if (host === "codex" && server.cwd !== pluginRoot) {
      throw new Error("Codex cwd was not resolved from the installed plugin root");
    }
    if (host !== "codex" && !path.isAbsolute(server.args[0])) {
      throw new Error(`${host} did not resolve its server entry to the installed plugin root`);
    }

    const environment = Object.fromEntries(
      Object.entries(process.env).filter((entry) => typeof entry[1] === "string"),
    );
    delete environment.FIGURE_LIBRARY_DIR;
    environment.APPDATA = isolatedUserState;
    environment.LOCALAPPDATA = isolatedUserState;
    environment.XDG_CONFIG_HOME = isolatedUserState;
    environment.XDG_DATA_HOME = isolatedUserState;

    client = new Client({ name: `sfl-${host}-foreign-cwd-smoke`, version });
    const transport = new StdioClientTransport({
      command: server.command,
      args: server.args,
      cwd: server.cwd,
      env: environment,
      stderr: "pipe",
    });
    transport.stderr?.on("data", (chunk) => {
      if (stderr.length < 32_768) stderr += chunk.toString();
    });
    await withTimeout(client.connect(transport), 20_000, `${host} MCP initialize`);
    const listed = await withTimeout(client.listTools(), 20_000, `${host} MCP tools/list`);
    const names = assertExactToolInventory(listed.tools, `${host} plugin`);
    return { host, toolCount: names.length, pluginRoot, foreignProjectDirectory };
  } catch (error) {
    const detail = stderr.trim() ? `\npackaged server stderr:\n${stderr.trim()}` : "";
    throw new Error(`${host} foreign-cwd plugin smoke failed: ${error.message}${detail}`, {
      cause: error,
    });
  } finally {
    await client?.close().catch(() => undefined);
    await fs.rm(smokeDirectory, { recursive: true, force: true });
  }
}
