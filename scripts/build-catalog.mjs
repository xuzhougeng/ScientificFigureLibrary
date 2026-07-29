#!/usr/bin/env node

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
const compressedTree = compressedTreeArgument
  ? path.resolve(compressedTreeArgument)
  : undefined;
const output = path.resolve(argument("--output") ?? "assets");

if (!source || !figureyaCommit || !compressedCommit) {
  console.error(
    "Usage: build-catalog.mjs --source <FigureYa checkout> " +
      "--figureya-commit <sha> --compressed-commit <sha> " +
      "[--compressed-tree <GitHub tree JSON>] [--output assets]",
  );
  process.exit(2);
}

async function readStdin() {
  if (process.stdin.isTTY) return "";
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

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
    .filter((name) => /\.(?:rmd|r|py|sh|ipynb|md)$/iu.test(name))
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

const compressedListing = await readStdin();
const archiveMetadata = new Map();
if (compressedTree) {
  const tree = JSON.parse(await fs.readFile(compressedTree, "utf8"));
  if (tree.truncated || !Array.isArray(tree.tree)) {
    throw new Error("compressed repository tree is missing or truncated");
  }
  for (const entry of tree.tree) {
    if (entry.type !== "blob" || !entry.path.endsWith(".zip")) continue;
    archiveMetadata.set(path.posix.basename(entry.path, ".zip"), {
      bytes: entry.size,
      gitBlobSha1: entry.sha,
    });
  }
}

const compressedModules = new Set([
  ...archiveMetadata.keys(),
  ...compressedListing
    .split(/\r?\n/u)
    .map((line) => line.trim().replace(/^"|"$/gu, ""))
    .filter((line) => line.endsWith(".zip"))
    .map((line) => path.posix.basename(line, ".zip")),
]);

const chapters = JSON.parse(await fs.readFile(path.join(source, "chapters.json"), "utf8"));
const filesByModule = JSON.parse(await fs.readFile(path.join(source, "file_list.json"), "utf8"));
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
    await fs.copyFile(sourceThumb, path.join(thumbnails, `${moduleId}.webp`));
    thumbnail = `thumbs/${moduleId}.webp`;
  } catch {
    thumbnail = undefined;
  }

  modules.push({
    moduleId,
    title: moduleChapters[0]?.title?.split("/").at(-1)?.replace(/\.html$/u, "") ?? moduleId,
    requirement,
    application,
    inputSummary,
    codeFiles: codeFiles(files),
    inputFiles: inputFiles(files),
    packages: packagesFrom(fullText),
    files,
    thumbnail,
    archiveAvailable: compressedModules.size === 0 || compressedModules.has(moduleId),
    archiveBytes: archive?.bytes,
    archiveGitBlobSha1: archive?.gitBlobSha1,
    sourceUrl: `https://github.com/ying-ge/FigureYa/tree/${figureyaCommit}/${encodeURIComponent(moduleId)}`,
    reportUrl: moduleChapters[0]
      ? `https://ying-ge.github.io/FigureYa/${moduleChapters[0].html}`
      : undefined,
    fullText,
  });
}

const catalog = {
  schema: "figure-library.figureya-catalog.v1",
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
  path.join(output, "figureya-source-pack.manifest.json"),
  `${JSON.stringify(
    {
      schema: "figure-library.source-pack.v1",
      sourceId: "figureya",
      archiveRepository: catalog.compressed.repository,
      archiveCommit: catalog.compressed.commit,
      archives: modules
        .filter((module) => module.archiveAvailable && module.archiveBytes)
        .map((module) => ({
          moduleId: module.moduleId,
          file: `${module.moduleId}.zip`,
          bytes: module.archiveBytes,
          gitBlobSha1: module.archiveGitBlobSha1,
        })),
    },
    null,
    2,
  )}\n`,
);
await fs.copyFile(path.join(source, "LICENSE"), path.join(output, "FIGUREYA_LICENSE.txt"));

console.log(
  `Built ${modules.length} modules (${modules.filter((item) => item.thumbnail).length} thumbnails, ` +
    `${modules.filter((item) => item.archiveAvailable).length} pinned archives).`,
);
