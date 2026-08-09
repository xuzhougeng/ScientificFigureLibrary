#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const sourceArgument = argument("--source");
const source = sourceArgument ? path.resolve(sourceArgument) : undefined;
const figureyaCommit = argument("--figureya-commit");
const compressedCommit = argument("--compressed-commit");
const compressedTreeArgument = argument("--compressed-tree");
const compressedTree = compressedTreeArgument ? path.resolve(compressedTreeArgument) : undefined;
const archiveManifestArgument = argument("--archive-manifest");
const archiveManifest = archiveManifestArgument ? path.resolve(archiveManifestArgument) : undefined;
const output = path.resolve(argument("--output") ?? "assets");

if (!source || !figureyaCommit || !compressedCommit || !compressedTree || !archiveManifest) {
  console.error(
    "Usage: build-catalog.mjs --source <FigureYa checkout> " +
      "--figureya-commit <sha> --compressed-commit <sha> " +
      "--compressed-tree <GitHub tree JSON> --archive-manifest <SHA-256 manifest JSON> " +
      "[--output assets]",
  );
  process.exit(2);
}

const SHA1 = /^[a-f0-9]{40}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

function compact(value) {
  return value.replace(/\s+/gu, " ").trim();
}

function firstIndex(haystack, needles, after = 0) {
  let result = -1;
  for (const needle of needles) {
    const index = haystack.toLocaleLowerCase().indexOf(needle.toLocaleLowerCase(), after);
    if (index >= 0 && (result < 0 || index < result)) result = index;
  }
  return result;
}

function section(text, starts, ends, fallback = "") {
  const start = firstIndex(text, starts);
  if (start < 0) return fallback;
  const matchedStart =
    starts.find((item) =>
      text.slice(start).toLocaleLowerCase().startsWith(item.toLocaleLowerCase()),
    ) ?? "";
  const contentStart = start + matchedStart.length;
  const end = firstIndex(text, ends, contentStart);
  return compact(text.slice(contentStart, end < 0 ? contentStart + 1800 : end))
    .replace(/^\d+\s*/u, "")
    .slice(0, 1800);
}

function packagesFrom(text) {
  const packages = new Set();
  for (const match of text.matchAll(/(?:library|require)\s*\(\s*["']?([A-Za-z][\w.]*)/gu)) {
    packages.add(match[1]);
  }
  return [...packages].sort((a, b) => a.localeCompare(b)).slice(0, 50);
}

function codeFiles(files) {
  return files
    .map((file) => file.name)
    .filter((name) => /\.(?:rmd|qmd|r|py|sh|ipynb|jl|m)$/iu.test(name))
    .sort();
}

function inputFiles(files) {
  return files
    .map((file) => file.name)
    .filter(
      (name) =>
        /^easy_input/iu.test(path.basename(name)) ||
        (/\.(?:csv|tsv|txt|xlsx?|gct|gmt|rds|rda|rdata)$/iu.test(name) &&
          !/(?:^|[_-])output|result|install\.log/iu.test(name)),
    )
    .sort()
    .slice(0, 40);
}

function canonicalCode(files) {
  const priority = [".rmd", ".qmd", ".r", ".py", ".ipynb", ".jl", ".m", ".sh"];
  return [...files].sort((left, right) => {
    const leftName = path.posix.basename(left).toLocaleLowerCase();
    const rightName = path.posix.basename(right).toLocaleLowerCase();
    const leftNamed = /(?:^|[-_.])(main|plot|figure|app)(?:[-_.]|$)/u.test(leftName) ? 0 : 1;
    const rightNamed = /(?:^|[-_.])(main|plot|figure|app)(?:[-_.]|$)/u.test(rightName) ? 0 : 1;
    return (
      leftNamed - rightNamed ||
      priority.indexOf(path.extname(left).toLocaleLowerCase()) -
        priority.indexOf(path.extname(right).toLocaleLowerCase()) ||
      left.localeCompare(right)
    );
  })[0];
}

function archivePreviewFiles(files) {
  return files
    .map((file) => file.name)
    .filter((name) => /(?:^|\/)(?:example|demo|preview)[^/]*\.(?:png|jpe?g|webp|svg|pdf)$/iu.test(name))
    .sort();
}

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function portableArchiveFile(value, moduleId) {
  if (typeof value !== "string") throw new Error(`${moduleId}.file is missing`);
  const normalized = value.replaceAll("\\", "/");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:/u.test(normalized) ||
    normalized.split("/").some((part) => !part || part === "." || part === "..") ||
    path.posix.basename(normalized) !== `${moduleId}.zip`
  ) {
    throw new Error(`${moduleId}.file is not a safe module archive path`);
  }
  return normalized;
}

const tree = requireObject(JSON.parse(await fs.readFile(compressedTree, "utf8")), "compressed tree");
if (tree.truncated || !Array.isArray(tree.tree)) {
  throw new Error("compressed repository tree is missing or truncated");
}
const treeArchives = new Map();
for (const entryValue of tree.tree) {
  const entry = requireObject(entryValue, "compressed tree entry");
  if (entry.type !== "blob" || typeof entry.path !== "string" || !entry.path.endsWith(".zip")) continue;
  const moduleId = path.posix.basename(entry.path, ".zip");
  if (treeArchives.has(moduleId)) throw new Error(`duplicate compressed archive: ${moduleId}`);
  if (!Number.isSafeInteger(entry.size) || entry.size <= 0 || typeof entry.sha !== "string") {
    throw new Error(`compressed tree metadata is incomplete for ${moduleId}`);
  }
  const gitBlobSha1 = entry.sha.toLocaleLowerCase();
  if (!SHA1.test(gitBlobSha1)) throw new Error(`invalid Git blob SHA-1 for ${moduleId}`);
  treeArchives.set(moduleId, { bytes: entry.size, gitBlobSha1 });
}
if (treeArchives.size === 0) throw new Error("compressed repository tree contains no archives");

const integrityDocument = requireObject(
  JSON.parse(await fs.readFile(archiveManifest, "utf8")),
  "archive manifest",
);
if (!Array.isArray(integrityDocument.archives)) {
  throw new Error("archive manifest must contain an archives array");
}
if (
  integrityDocument.archiveCommit !== undefined &&
  integrityDocument.archiveCommit !== compressedCommit
) {
  throw new Error("archive manifest commit does not match --compressed-commit");
}
const archiveMetadata = new Map();
for (const entryValue of integrityDocument.archives) {
  const entry = requireObject(entryValue, "archive manifest entry");
  if (typeof entry.moduleId !== "string" || !entry.moduleId) {
    throw new Error("archive manifest entry lacks moduleId");
  }
  if (archiveMetadata.has(entry.moduleId)) {
    throw new Error(`duplicate archive manifest module: ${entry.moduleId}`);
  }
  portableArchiveFile(entry.file, entry.moduleId);
  if (!Number.isSafeInteger(entry.bytes) || entry.bytes <= 0) {
    throw new Error(`${entry.moduleId}.bytes is invalid`);
  }
  if (typeof entry.sha256 !== "string" || !SHA256.test(entry.sha256.toLocaleLowerCase())) {
    throw new Error(`${entry.moduleId} lacks required SHA-256 archive identity`);
  }
  const treeEntry = treeArchives.get(entry.moduleId);
  if (!treeEntry) throw new Error(`${entry.moduleId} is absent from the compressed tree`);
  const gitBlobSha1 =
    typeof entry.gitBlobSha1 === "string"
      ? entry.gitBlobSha1.toLocaleLowerCase()
      : treeEntry.gitBlobSha1;
  if (!SHA1.test(gitBlobSha1)) throw new Error(`${entry.moduleId}.gitBlobSha1 is invalid`);
  if (entry.bytes !== treeEntry.bytes || gitBlobSha1 !== treeEntry.gitBlobSha1) {
    throw new Error(`${entry.moduleId} archive manifest disagrees with the compressed tree`);
  }
  archiveMetadata.set(entry.moduleId, {
    bytes: entry.bytes,
    gitBlobSha1,
    sha256: entry.sha256.toLocaleLowerCase(),
  });
}
for (const moduleId of treeArchives.keys()) {
  if (!archiveMetadata.has(moduleId)) {
    throw new Error(`SHA-256 archive manifest is missing ${moduleId}`);
  }
}

const chapters = JSON.parse(await fs.readFile(path.join(source, "chapters.json"), "utf8"));
const filesByModule = JSON.parse(await fs.readFile(path.join(source, "file_list.json"), "utf8"));
if (!Array.isArray(chapters) || !filesByModule || typeof filesByModule !== "object") {
  throw new Error("FigureYa chapters.json or file_list.json has an unsupported shape");
}
const chaptersByModule = new Map();
for (const chapter of chapters) {
  const entries = chaptersByModule.get(chapter.folder) ?? [];
  entries.push(chapter);
  chaptersByModule.set(chapter.folder, entries);
}

const moduleIds = [...new Set([...Object.keys(filesByModule), ...chaptersByModule.keys()])].sort(
  (left, right) => {
    const leftNumber = Number(left.match(/^FigureYa(\d+)/u)?.[1] ?? Number.MAX_SAFE_INTEGER);
    const rightNumber = Number(right.match(/^FigureYa(\d+)/u)?.[1] ?? Number.MAX_SAFE_INTEGER);
    return leftNumber - rightNumber || left.localeCompare(right);
  },
);

const thumbnails = path.join(output, "thumbs");
await fs.rm(thumbnails, { recursive: true, force: true });
await fs.mkdir(thumbnails, { recursive: true });

const modules = [];
const previewEntries = [];
for (const moduleId of moduleIds) {
  const archive = archiveMetadata.get(moduleId);
  const moduleChapters = chaptersByModule.get(moduleId) ?? [];
  const textParts = [];
  for (const chapter of moduleChapters) {
    try {
      textParts.push(await fs.readFile(path.join(source, chapter.text), "utf8"));
    } catch {
      // A folder may be listed before its generated text is published.
    }
  }

  const fullText = compact(textParts.join("\n")) || moduleId;
  const files = filesByModule[moduleId] ?? [];
  if (!Array.isArray(files)) throw new Error(`${moduleId} file list is invalid`);
  const requirement = section(
    fullText,
    ["需求描述 requirement description", "需求描述", "requirement description"],
    [
      "应用场景",
      "使用场景",
      "application scenario",
      "usage scenario",
      "环境设置",
      "environment setting",
    ],
    fullText.slice(0, 900),
  );
  const application = section(
    fullText,
    ["应用场景 application scenario", "使用场景 usage scenario", "应用场景", "使用场景"],
    ["环境设置", "environment setting", "输入文件", "输入数据", "input file", "input data"],
  );
  const inputSummary = section(
    fullText,
    ["输入文件 input file", "输入数据 input data", "输入文件", "输入数据"],
    ["参数设置", "parameter setting", "开始画图", "start drawing", "数据处理", "data processing"],
  );

  const sourceThumb = path.join(source, "gallery_compress", `${moduleId}.webp`);
  let thumbnail;
  try {
    const outputThumb = path.join(thumbnails, `${moduleId}.webp`);
    await fs.copyFile(sourceThumb, outputThumb);
    thumbnail = `thumbs/${moduleId}.webp`;
    const previewBytes = await fs.readFile(outputThumb);
    previewEntries.push({
      moduleId,
      file: thumbnail,
      bytes: previewBytes.byteLength,
      sha256: createHash("sha256").update(previewBytes).digest("hex"),
      mediaType: "image/webp",
    });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    thumbnail = undefined;
  }

  const moduleCodeFiles = codeFiles(files);
  const moduleInputFiles = inputFiles(files);
  const modulePreviewFiles = archivePreviewFiles(files);
  const canonical = canonicalCode(moduleCodeFiles);
  const requiredFiles = [...new Set([canonical, ...moduleInputFiles, ...modulePreviewFiles].filter(Boolean))].sort();
  modules.push({
    moduleId,
    title: moduleChapters[0]?.title?.split("/").at(-1)?.replace(/\.html$/u, "") ?? moduleId,
    requirement,
    application,
    inputSummary,
    codeFiles: moduleCodeFiles,
    inputFiles: moduleInputFiles,
    packages: packagesFrom(fullText),
    files,
    thumbnail,
    primaryPreview: thumbnail,
    canonicalCode: canonical,
    requiredFiles,
    archiveAvailable: Boolean(archive),
    archiveBytes: archive?.bytes,
    archiveGitBlobSha1: archive?.gitBlobSha1,
    archiveSha256: archive?.sha256,
    archiveIdentity: archive ? "sha256" : undefined,
    sourceUrl: `https://github.com/ying-ge/FigureYa/tree/${figureyaCommit}/${encodeURIComponent(moduleId)}`,
    reportUrl: moduleChapters[0]
      ? `https://ying-ge.github.io/FigureYa/${moduleChapters[0].html}`
      : undefined,
    fullText,
  });
}

const unknownArchives = [...archiveMetadata.keys()].filter((moduleId) => !moduleIds.includes(moduleId));
if (unknownArchives.length) {
  throw new Error(`compressed archives have no FigureYa source module: ${unknownArchives.join(", ")}`);
}

const catalog = {
  schema: "figure-library.figureya-catalog.v2",
  generatedAt: new Date().toISOString(),
  figureya: {
    repository: "https://github.com/ying-ge/FigureYa",
    commit: figureyaCommit,
  },
  compressed: {
    repository: "https://github.com/ying-ge/FigureYa-compressed",
    commit: compressedCommit,
  },
  citation:
    "Lu, X. et al. (2025). FigureYa: A Standardized Visualization Framework " +
    "for Enhancing Biomedical Data Interpretation and Research Efficiency. " +
    "iMetaMed 1:e70005. https://doi.org/10.1002/imm3.70005",
  modules,
};

await fs.mkdir(output, { recursive: true });
await fs.writeFile(path.join(output, "catalog.json"), `${JSON.stringify(catalog)}\n`);
await fs.writeFile(
  path.join(output, "figureya-preview.manifest.json"),
  `${JSON.stringify(
    {
      schema: "figure-library.figureya-preview-manifest.v1",
      providerId: "org.figureya.module",
      sourceRepository: catalog.figureya.repository,
      sourceCommit: catalog.figureya.commit,
      previews: previewEntries.sort((left, right) =>
        left.moduleId < right.moduleId ? -1 : left.moduleId > right.moduleId ? 1 : 0,
      ),
    },
    null,
    2,
  )}\n`,
);
await fs.writeFile(
  path.join(output, "figureya-source-pack.manifest.json"),
  `${JSON.stringify(
    {
      schema: "figure-library.source-pack.v2",
      providerId: "org.figureya.module",
      archiveRepository: catalog.compressed.repository,
      archiveCommit: catalog.compressed.commit,
      archives: modules
        .filter((module) => module.archiveAvailable)
        .map((module) => ({
          moduleId: module.moduleId,
          file: `${module.moduleId}.zip`,
          bytes: module.archiveBytes,
          gitBlobSha1: module.archiveGitBlobSha1,
          sha256: module.archiveSha256,
        })),
    },
    null,
    2,
  )}\n`,
);
await fs.copyFile(path.join(source, "LICENSE"), path.join(output, "FIGUREYA_LICENSE.txt"));

console.log(
  `Built ${modules.length} modules (${modules.filter((item) => item.thumbnail).length} thumbnails, ` +
    `${modules.filter((item) => item.archiveAvailable).length} SHA-256 pinned archives).`,
);
