#!/usr/bin/env node

import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parse as parseYaml } from "yaml";
import { STANDARD_TOOL_NAMES } from "./package-release-lib.mjs";
import { WISP_UPDATE_MANIFEST } from "./wisp-update-manifest.mjs";

export { WISP_UPDATE_MANIFEST };

const execFile = promisify(execFileCallback);
const root = path.resolve(import.meta.dirname, "..");
const PRODUCT_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const RELEASE_TAG = /^v((0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*))$/;
const FORBIDDEN_CHANGELOG_HEADINGS = [
  "## Choose a download",
  "## 选择下载",
  "## Getting started",
  "## 开始使用",
  "## Upgrade",
  "## 升级",
  "## Release provenance",
  "## 发布来源",
];

export const LOCAL_CLIENT_ROWS = Object.freeze([
  {
    id: "macos-arm64",
    ext: "dmg",
    systemEn: "macOS Apple Silicon (M1-M4)",
    systemZh: "macOS Apple Silicon（M 系列）",
    installEn: "Drag the App into Applications. macOS 13+.",
    installZh: "将 App 拖入“应用程序”。最低 macOS 13。",
  },
  {
    id: "macos-x64",
    ext: "dmg",
    systemEn: "macOS Intel",
    systemZh: "macOS Intel",
    installEn: "Same as above. Do not mix arm64 and x64.",
    installZh: "同上。arm64 与 x64 不可混用。",
  },
  {
    id: "windows-x64",
    ext: "zip",
    systemEn: "Windows x64",
    systemZh: "Windows x64",
    installEn: "Unzip the whole folder, then run `Start SFL.cmd`.",
    installZh: "解压整个文件夹，运行 `Start SFL.cmd`。",
  },
  {
    id: "linux-x64",
    ext: "zip",
    systemEn: "Linux x64",
    systemZh: "Linux x64",
    installEn: "Unzip the whole folder, then run `./start-sfl.sh`.",
    installZh: "解压整个文件夹，运行 `./start-sfl.sh`。",
  },
  {
    id: "linux-arm64",
    ext: "zip",
    systemEn: "Linux arm64",
    systemZh: "Linux arm64",
    installEn: "Same as Linux x64.",
    installZh: "与 Linux x64 相同。",
  },
]);

export const PLUGIN_HOSTS = Object.freeze([
  {
    id: "wisp",
    labelEn: "Wisp Science",
    labelZh: "Wisp Science",
    installEn: "Settings -> Plugins",
    installZh: "设置 -> 插件",
  },
  {
    id: "codex",
    labelEn: "Codex",
    labelZh: "Codex",
    installEn: "Install the host plugin from the ZIP",
    installZh: "按宿主插件方式安装 ZIP",
  },
  {
    id: "claude",
    labelEn: "Claude Code",
    labelZh: "Claude Code",
    installEn: "Install the host plugin from the ZIP",
    installZh: "按宿主插件方式安装 ZIP",
  },
  {
    id: "cursor",
    labelEn: "Cursor",
    labelZh: "Cursor",
    installEn: "Unzip to `~/.cursor/plugins/local/figure-library/`",
    installZh: "解压到 `~/.cursor/plugins/local/figure-library/`",
  },
]);

export function localClientFileName(version, id, ext, noNode = false) {
  return `ScientificFigureLibrary-${version}-${id}${noNode ? "-no-node" : ""}.${ext}`;
}

export function pluginFileName(host, version) {
  return `scientific-figure-library-${host}-${version}.zip`;
}

export function npmTarballName(version) {
  return `scientific-figure-library-${version}.tgz`;
}

export function expectedReleaseAssets(version) {
  assertProductVersion(version);
  const names = [];
  for (const row of LOCAL_CLIENT_ROWS) {
    for (const noNode of [false, true]) {
      const file = localClientFileName(version, row.id, row.ext, noNode);
      names.push(file, `${file}.sha256`);
    }
  }
  for (const host of PLUGIN_HOSTS) {
    const file = pluginFileName(host.id, version);
    names.push(file, `${file}.sha256`);
  }
  const tarball = npmTarballName(version);
  names.push(tarball, `${tarball}.sha256`, WISP_UPDATE_MANIFEST);
  return names.sort();
}

export function formatAssetSize(bytes, { dashForTiny = false } = {}) {
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw new Error(`invalid byte size: ${bytes}`);
  }
  if (dashForTiny && bytes < 1024) return "-";
  const megabytes = bytes / (1024 * 1024);
  if (megabytes >= 1) return `${Math.round(megabytes)} MB`;
  const kilobytes = bytes / 1024;
  if (kilobytes >= 1) return `${Math.round(kilobytes)} KB`;
  return `${bytes} B`;
}

export function releaseNotesPath(version, repositoryRoot = root) {
  assertProductVersion(version);
  return path.join(repositoryRoot, ".github", "release-notes", `v${version}.md`);
}

export function parseReleaseNotesSource(markdown, version) {
  assertProductVersion(version);
  const match = String(markdown).match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) {
    throw new Error("release notes must start with YAML front matter delimited by ---");
  }
  const data = parseYaml(match[1]);
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("release notes front matter must be a mapping");
  }
  const previousTag = String(data.previous_tag ?? "").trim();
  if (!RELEASE_TAG.test(previousTag)) {
    throw new Error("release notes previous_tag must be a stable tag like v0.8.0");
  }
  const summaryEn = asRequiredText(data.summary_en, "summary_en");
  const summaryZh = asRequiredText(data.summary_zh, "summary_zh");
  let previousMcpTools;
  if (data.previous_mcp_tools !== undefined && data.previous_mcp_tools !== null) {
    previousMcpTools = data.previous_mcp_tools;
    if (!Number.isInteger(previousMcpTools) || previousMcpTools < 0) {
      throw new Error("previous_mcp_tools must be a non-negative integer");
    }
  }
  const changelog = match[2].replace(/^\uFEFF/, "").trim();
  for (const heading of FORBIDDEN_CHANGELOG_HEADINGS) {
    if (changelog.includes(heading)) {
      throw new Error(
        `${heading} is generated from the release inventory; keep it out of .github/release-notes/v${version}.md`,
      );
    }
  }
  const enHeading = `## Changes since ${previousTag}`;
  const zhHeading = `## 相对 ${previousTag} 的变化`;
  if (!changelog.startsWith(enHeading)) {
    throw new Error(`changelog must start with "${enHeading}"`);
  }
  const zhAt = changelog.indexOf(`\n${zhHeading}`);
  if (zhAt < 0) {
    throw new Error(`changelog must contain "${zhHeading}"`);
  }
  const changesEn = changelog.slice(enHeading.length, zhAt).trim();
  const changesZh = changelog.slice(zhAt + 1 + zhHeading.length).trim();
  if (changesEn.length < 40 || changesZh.length < 40) {
    throw new Error("English and Chinese changelog sections must each describe the full tag range");
  }
  return {
    previousTag,
    summaryEn,
    summaryZh,
    previousMcpTools,
    changesEn,
    changesZh,
    mcpTools: STANDARD_TOOL_NAMES.length,
  };
}

export async function verifyReleaseDirectory(directory, version) {
  assertProductVersion(version);
  const expected = expectedReleaseAssets(version);
  const expectedSet = new Set(expected);
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const nested = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  if (nested.length > 0) {
    throw new Error(`release directory has nested directories: ${nested.sort().join(",")}`);
  }
  const observed = entries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
  const missing = expected.filter((name) => !observed.includes(name));
  const extra = observed.filter((name) => !expectedSet.has(name));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `release inventory differs: missing=${missing.join(",") || "none"} extra=${extra.join(",") || "none"}`,
    );
  }

  const files = new Map();
  for (const name of expected) {
    files.set(name, new Uint8Array(await fs.readFile(path.join(directory, name))));
  }
  for (const name of expected) {
    if (name.endsWith(".sha256") || name === WISP_UPDATE_MANIFEST) continue;
    const sidecarName = `${name}.sha256`;
    const digest = createHash("sha256").update(files.get(name)).digest("hex");
    const sidecar = Buffer.from(files.get(sidecarName)).toString("utf8").trim();
    if (sidecar !== `${digest}  ${name}`) {
      throw new Error(`${sidecarName} does not match ${name}`);
    }
  }

  const zipName = pluginFileName("wisp", version);
  const zip = files.get(zipName);
  const feed = JSON.parse(Buffer.from(files.get(WISP_UPDATE_MANIFEST)).toString("utf8"));
  const digest = createHash("sha256").update(zip).digest("hex");
  if (feed?.schema !== "figure-library.wisp-update.v1") {
    throw new Error("Wisp update feed schema is invalid");
  }
  if (feed.version !== version || feed.channel !== "stable") {
    throw new Error("Wisp update feed version/channel must match the stable GitHub Release");
  }
  if (feed.asset?.name !== zipName || feed.asset.sha256 !== digest || feed.asset.size !== zip.byteLength) {
    throw new Error("Wisp update feed does not match the verified Wisp ZIP");
  }
  if (!String(feed.asset.url).endsWith(`/releases/download/v${version}/${zipName}`)) {
    throw new Error("Wisp update feed asset URL is not pinned to this release tag");
  }

  return {
    files: expected,
    sizes: Object.fromEntries([...files].map(([name, bytes]) => [name, bytes.byteLength])),
  };
}

export function buildGitHubReleaseBody({
  version,
  tagSha,
  repository,
  notes,
  sizes,
}) {
  assertProductVersion(version);
  if (!/^[0-9a-f]{40}$/i.test(tagSha)) {
    throw new Error("tag SHA must be a 40-character commit");
  }
  const repo = normalizeRepository(repository);
  const tag = `v${version}`;
  const compareUrl = `https://github.com/${repo}/compare/${notes.previousTag}...${tag}`;
  const toolCount = notes.mcpTools;
  const previousTools = notes.previousMcpTools;
  const toolEn =
    previousTools === undefined
      ? `The standard MCP server now exposes **${toolCount} tools**.`
      : `The standard MCP server now exposes **${toolCount} tools** (${previousTools} in ${notes.previousTag}).`;
  const toolZh =
    previousTools === undefined
      ? `标准 MCP 服务现为 **${toolCount}** 个工具。`
      : `标准 MCP 服务现为 **${toolCount}** 个工具（${notes.previousTag} 为 ${previousTools} 个）。`;
  const tarball = npmTarballName(version);
  const english = [
    `# Scientific Figure Library ${tag}`,
    "",
    `${notes.summaryEn} Compare the full source range: [${notes.previousTag}...${tag}](${compareUrl}).`,
    "",
    `SFL still does not execute plotting code. It manages, reviews, searches, previews, and materializes the exact assets you confirm. ${toolEn}`,
    "",
    "## Choose a download",
    "",
    "Pick the row that matches what you want to install. Every installer and plugin has a matching `.sha256` sidecar in the asset list below.",
    "",
    "| I want to... | Download |",
    "| --- | --- |",
    "| Run SFL as a local app on this computer | Local client for your OS and CPU in the next table |",
    "| Use SFL inside Wisp, Codex, Claude Code, or Cursor | That host's plugin ZIP |",
    `| Install the MCP CLI from a tarball | \`${tarball}\` |`,
    "",
    "**Bundled Node** packages include a private Node.js 22 runtime (larger). **`no-node`** packages require an already installed **Node.js 22+** and are much smaller. Local clients omit gallery images and download previews on demand; plugin ZIPs still include catalog thumbnails.",
    "",
    "### Local clients",
    "",
    "| System | Bundled Node (no extra runtime) | Use installed Node.js 22+ | How to install |",
    "| --- | --- | --- | --- |",
    ...LOCAL_CLIENT_ROWS.map((row) => localClientRow(row, { version, repo, sizes, lang: "en" })),
    "",
    "macOS DMGs are **preview** builds: ad-hoc signed, not Developer ID signed, and not notarized. After verifying the checksum, allow the app under System Settings -> Privacy & Security if macOS blocks the first open.",
    "",
    "### Host plugins (Node.js 22+ required)",
    "",
    "| Host | Download | Size | Install |",
    "| --- | --- | --- | --- |",
    ...pluginRows({ version, repo, sizes, lang: "en" }),
    "",
    `Do not register a raw \`figure-library\` MCP server **and** a host plugin at the same time; that duplicates tools. Plugin install steps: [Quickstart](https://github.com/${repo}/blob/${tag}/docs/QUICKSTART.md).`,
    "",
    `## Changes since ${notes.previousTag}`,
    "",
    notes.changesEn,
    "",
    "## Getting started",
    "",
    "1. Download the matching file and its `.sha256`. Verify with `shasum -a 256 <file>` (Windows: `certutil -hashfile <file> SHA256`).",
    "2. Local app: follow the [installation tutorial](https://xuzhougeng.github.io/ScientificFigureLibrary/tutorial.html). On first launch, bind a global Library and a Local workspace - SFL does not infer them from the current project.",
    "3. Plugin: install for one host, start a new host session, then call `figure_library_get_skill` or `figure_library_source_status`. If setup is required, bind the two directories with plan/apply after you confirm the paths.",
    "4. Keep the whole install directory together (`runtime`, `dist`, `assets`, Skill files). Do not move those folders on their own.",
    "",
    `Limits and Node-path notes: [INSTALL_LOCAL.md](https://github.com/${repo}/blob/${tag}/docs/INSTALL_LOCAL.md). Protocol: [PROTOCOL.md](https://github.com/${repo}/blob/${tag}/docs/PROTOCOL.md).`,
    "",
    "## Upgrade",
    "",
    "Quit the app and any MCP process using the old install. Replace only the program directory or plugin; keep the Library and workspace directories. Reopen, check the Node path and Connect external tools page, and back up the Library before upgrading. Deleting the program does not delete your library.",
    "",
    "## Release provenance",
    "",
    `- Tag \`${tag}\` points to \`${tagSha.toLowerCase()}\`.`,
    "- Plugin ZIPs, the npm tarball, local-client installers, SHA-256 sidecars, and the Wisp update feed were published from that commit.",
    "- Packaging smoke and isolated tests are not a substitute for installing a real host plugin or completing desktop/provider acceptance.",
  ];
  const chinese = [
    `# Scientific Figure Library ${tag}`,
    "",
    `${notes.summaryZh} 源码对照：[${notes.previousTag}...${tag}](${compareUrl})。`,
    "",
    `SFL 仍不执行绘图代码，只管理、审阅、检索、预览，并材料化你确认的精确资产。${toolZh}`,
    "",
    "## 选择下载",
    "",
    "先看要安装什么。每个安装包和插件在下方资源列表中都有同名 `.sha256` 校验文件。",
    "",
    "| 我要... | 下载 |",
    "| --- | --- |",
    "| 在本机作为独立应用管理图库 | 下一表中对应操作系统和 CPU 的本地客户端 |",
    "| 在 Wisp、Codex、Claude Code 或 Cursor 中使用 | 该宿主的插件 ZIP |",
    `| 用 npm 安装 MCP 命令 | \`${tarball}\` |`,
    "",
    "**内置 Node** 包带私有 Node.js 22（体积较大）。**`no-node`** 包要求本机已安装 **Node.js 22+**，体积小很多。本地客户端不含图库图片，预览按需下载；插件 ZIP 仍包含目录缩略图。",
    "",
    "### 本地客户端",
    "",
    "| 系统 | 内置 Node（无需另装） | 使用已安装 Node.js 22+ | 安装方式 |",
    "| --- | --- | --- | --- |",
    ...LOCAL_CLIENT_ROWS.map((row) => localClientRow(row, { version, repo, sizes, lang: "zh" })),
    "",
    "macOS DMG 是**预览版**：ad-hoc 签名，尚未 Developer ID 签名，也未公证。校验通过后，若系统拦截首次打开，在“系统设置 -> 隐私与安全性”中允许。",
    "",
    "### 宿主插件（需要 Node.js 22+）",
    "",
    "| 宿主 | 下载 | 大小 | 安装 |",
    "| --- | --- | --- | --- |",
    ...pluginRows({ version, repo, sizes, lang: "zh" }),
    "",
    `不要同时安装宿主插件和重复的原始 \`figure-library\` MCP 配置，否则工具会重复。插件步骤见 [Quickstart](https://github.com/${repo}/blob/${tag}/docs/QUICKSTART.md)。`,
    "",
    `## 相对 ${notes.previousTag} 的变化`,
    "",
    notes.changesZh,
    "",
    "## 开始使用",
    "",
    "1. 下载对应文件和同名 `.sha256`，用 `shasum -a 256 文件名` 校验（Windows 可用 `certutil -hashfile 文件名 SHA256`）。",
    "2. 本地客户端按 [安装教程](https://xuzhougeng.github.io/ScientificFigureLibrary/tutorial.html) 操作。首次启动绑定全局 Library 和 Local workspace；SFL 不会从当前项目推断这两个目录。",
    "3. 插件：只装一个宿主，新开会话后调用 `figure_library_get_skill` 或 `figure_library_source_status`。若需要设置，确认路径后再 plan/apply 绑定。",
    "4. 保留完整安装目录（`runtime`、`dist`、`assets`、Skill），不要单独挪走这些文件夹。",
    "",
    `限制与 Node 路径见 [INSTALL_LOCAL.md](https://github.com/${repo}/blob/${tag}/docs/INSTALL_LOCAL.md)。协议见 [PROTOCOL.md](https://github.com/${repo}/blob/${tag}/docs/PROTOCOL.md)。`,
    "",
    "## 升级",
    "",
    "退出 App 以及仍在使用旧程序的 MCP 进程。只替换程序目录或插件，保留 Library 与 workspace。重新打开后检查 Node 路径和「连接外部工具」页。升级前备份 Library。删除程序不会删除图库。",
    "",
    "## 发布来源",
    "",
    `- 标签 \`${tag}\` 指向 \`${tagSha.toLowerCase()}\`。`,
    "- 四个插件 ZIP、npm 包、本地客户端安装包、SHA-256 校验文件和 Wisp 更新 feed 均来自该提交。",
    "- 打包 smoke 与隔离测试不能代替真实宿主插件安装或桌面端验收。",
  ];
  return `${english.join("\n")}\n\n---\n\n${chinese.join("\n")}\n`;
}

export async function prepareGitHubRelease({
  directory,
  version,
  tagSha,
  notesFile,
  repository,
  outDir,
}) {
  const inventory = await verifyReleaseDirectory(directory, version);
  const notes = parseReleaseNotesSource(await fs.readFile(notesFile, "utf8"), version);
  const body = buildGitHubReleaseBody({
    version,
    tagSha,
    repository,
    notes,
    sizes: inventory.sizes,
  });
  const tag = `v${version}`;
  const createPayload = {
    tag_name: tag,
    name: `Scientific Figure Library ${tag}`,
    body,
    target_commitish: tagSha.toLowerCase(),
    draft: true,
    prerelease: false,
    make_latest: "true",
  };
  const updatePayload = {
    name: createPayload.name,
    body,
    draft: false,
    prerelease: false,
  };
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, "github-release-notes.md"), body, "utf8");
  await fs.writeFile(path.join(outDir, "github-release-create.json"), `${JSON.stringify(createPayload)}\n`);
  await fs.writeFile(path.join(outDir, "github-release-update.json"), `${JSON.stringify(updatePayload)}\n`);
  await fs.writeFile(
    path.join(outDir, "upload-files.txt"),
    inventory.files.map((name) => path.join(directory, name)).join("\n") + "\n",
    "utf8",
  );
  return { body, files: inventory.files, sizes: inventory.sizes, previousTag: notes.previousTag };
}

export async function checkReleaseTag({
  tag,
  repositoryRoot = root,
  gitCheck = true,
  githubOutput = false,
}) {
  const match = RELEASE_TAG.exec(String(tag).trim());
  if (!match) {
    throw new Error(`tag must be a stable vX.Y.Z value: ${tag}`);
  }
  const version = match[1];
  const packageJson = JSON.parse(await fs.readFile(path.join(repositoryRoot, "package.json"), "utf8"));
  if (packageJson.version !== version) {
    throw new Error(`package.json version ${packageJson.version} !== tag ${version}`);
  }
  const notesFile = releaseNotesPath(version, repositoryRoot);
  const notes = parseReleaseNotesSource(await fs.readFile(notesFile, "utf8"), version);
  let sha = "";
  if (gitCheck) {
    sha = (await execFile("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" })).stdout.trim();
    if (!/^[0-9a-f]{40}$/i.test(sha)) {
      throw new Error("git rev-parse HEAD did not return a commit SHA");
    }
    try {
      await execFile("git", ["show-ref", "--tags", "--verify", `refs/tags/${notes.previousTag}`], {
        cwd: repositoryRoot,
        encoding: "utf8",
      });
    } catch {
      throw new Error(`previous_tag ${notes.previousTag} is not a git tag in this repository`);
    }
  }
  const outputs = { tag: `v${version}`, version, sha, previous_tag: notes.previousTag };
  if (githubOutput) await writeGithubOutput(outputs);
  return outputs;
}

function localClientRow(row, { version, repo, sizes, lang }) {
  const bundled = localClientFileName(version, row.id, row.ext, false);
  const system = localClientFileName(version, row.id, row.ext, true);
  const bundledLink = assetLink(repo, version, bundled, `${row.id}.${row.ext}`, sizes[bundled]);
  const systemLink = assetLink(repo, version, system, `${row.id}-no-node.${row.ext}`, sizes[system]);
  const systemLabel = lang === "zh" ? row.systemZh : row.systemEn;
  const install = lang === "zh" ? row.installZh : row.installEn;
  return `| ${systemLabel} | ${bundledLink} | ${systemLink} | ${install} |`;
}

function pluginRows({ version, repo, sizes, lang }) {
  const rows = PLUGIN_HOSTS.map((host) => {
    const name = pluginFileName(host.id, version);
    const link = `[${"`"}${name}${"`"}](${downloadUrl(repo, version, name)})`;
    const size = formatAssetSize(requireSize(sizes, name));
    const label = lang === "zh" ? host.labelZh : host.labelEn;
    const install = lang === "zh" ? host.installZh : host.installEn;
    return `| ${label} | ${link} | ${size} | ${install} |`;
  });
  const tarball = npmTarballName(version);
  const tarballLabel = lang === "zh" ? "npm 包" : "npm tarball";
  const tarballInstall =
    lang === "zh"
      ? `\`npm install --global ./${tarball}\``
      : `\`npm install --global ./${tarball}\``;
  rows.push(
    `| ${tarballLabel} | [${"`"}${tarball}${"`"}](${downloadUrl(repo, version, tarball)}) | ${formatAssetSize(requireSize(sizes, tarball))} | ${tarballInstall} |`,
  );
  const feedLabel = lang === "zh" ? "Wisp 更新 feed" : "Wisp update feed";
  const feedInstall =
    lang === "zh"
      ? "供后续 Wisp「更新」读取的机器可读清单"
      : "Machine-readable feed for a future Wisp Update action";
  rows.push(
    `| ${feedLabel} | [${"`"}${WISP_UPDATE_MANIFEST}${"`"}](${downloadUrl(repo, version, WISP_UPDATE_MANIFEST)}) | ${formatAssetSize(requireSize(sizes, WISP_UPDATE_MANIFEST), { dashForTiny: true })} | ${feedInstall} |`,
  );
  return rows;
}

function assetLink(repo, version, fileName, label, bytes) {
  return `[\`${label}\`](${downloadUrl(repo, version, fileName)}) - ${formatAssetSize(requireSize({ [fileName]: bytes }, fileName))}`;
}

function downloadUrl(repo, version, fileName) {
  return `https://github.com/${repo}/releases/download/v${version}/${fileName}`;
}

function requireSize(sizes, name) {
  const bytes = sizes?.[name];
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw new Error(`missing size for ${name}`);
  }
  return bytes;
}

function asRequiredText(value, label) {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (!text) throw new Error(`${label} must be a non-empty string`);
  return text;
}

function assertProductVersion(version) {
  if (!PRODUCT_VERSION.test(version)) {
    throw new Error(`invalid product version: ${version}`);
  }
}

function normalizeRepository(value) {
  const text = String(value ?? "").trim().replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(text)) {
    throw new Error(`invalid GitHub repository: ${value}`);
  }
  return text;
}

async function writeGithubOutput(values) {
  const file = process.env.GITHUB_OUTPUT;
  const lines = Object.entries(values).map(([key, value]) => `${key}=${value}`);
  if (file) await fs.appendFile(file, `${lines.join("\n")}\n`);
  else process.stdout.write(`${lines.join("\n")}\n`);
}

function flag(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`missing value for --${name}`);
  }
  return value;
}

async function main() {
  const command = process.argv[2];
  if (command === "assets") {
    process.stdout.write(`${expectedReleaseAssets(flag("version")).join("\n")}\n`);
    return;
  }
  if (command === "check-tag") {
    const result = await checkReleaseTag({
      tag: flag("tag"),
      gitCheck: process.argv.includes("--skip-git") ? false : true,
      githubOutput: process.argv.includes("--github-output"),
    });
    if (!process.argv.includes("--github-output")) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    }
    return;
  }
  if (command === "check-notes") {
    const version = flag("version");
    parseReleaseNotesSource(await fs.readFile(flag("notes-file") ?? releaseNotesPath(version), "utf8"), version);
    process.stdout.write(`release notes ok: v${version}\n`);
    return;
  }
  if (command === "verify") {
    const version = flag("version");
    const inventory = await verifyReleaseDirectory(flag("dir"), version);
    process.stdout.write(`release inventory ok: ${inventory.files.length} files for v${version}\n`);
    return;
  }
  if (command === "prepare") {
    const packageJson = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
    const version = flag("version") ?? packageJson.version;
    const result = await prepareGitHubRelease({
      directory: flag("dir"),
      version,
      tagSha: flag("tag-sha"),
      notesFile: flag("notes-file") ?? releaseNotesPath(version),
      repository: flag("repository") ?? process.env.GITHUB_REPOSITORY ?? packageJson.repository?.url,
      outDir: flag("out-dir"),
    });
    process.stdout.write(`prepared GitHub Release notes and ${result.files.length} upload paths\n`);
    return;
  }
  throw new Error(
    "usage: node scripts/github-release.mjs <assets|check-tag|check-notes|verify|prepare> [options]",
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`GITHUB_RELEASE_FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
