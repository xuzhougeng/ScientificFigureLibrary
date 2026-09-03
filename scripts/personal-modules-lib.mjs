import { execFile as execFileCallback } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { unzipSync, zipSync } from "fflate";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

const execFile = promisify(execFileCallback);

export const CORE_ROOT = path.resolve(import.meta.dirname, "..");
export const DEFAULT_REPOSITORY_ROOT = path.resolve(CORE_ROOT, "..", "ScientificFigureLibrary-personal");
export const DEFAULT_SNAPSHOT_ROOT = path.join(CORE_ROOT, "assets", "personal-modules");
export const PROVIDER_ID = "io.github.jarxunlai.personal-figures";
export const SOURCE_LABEL = "Open Figure Modules";
export const REPOSITORY = "jarxunlai/ScientificFigureLibrary-personal";
export const CATALOG_SCHEMA = "figure-library.module-catalog.v1";
export const PREVIEW_SCHEMA = "figure-library.module-preview-manifest.v1";
export const SOURCE_PACK_SCHEMA = "figure-library.module-source-pack.v1";
export const MODULE_SCHEMA = "figure-library.personal-module.v1";
export const ARCHIVE_MANIFEST_SCHEMA = "figure-library.personal-archive-manifest.v1";
export const MAX_CATALOG_BYTES = 16 * 1024 * 1024;
export const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
export const MAX_FILE_BYTES = 64 * 1024 * 1024;
export const MAX_FILES = 10_000;
export const MAX_TEXT_BYTES = 32 * 1024 * 1024;
export const SOURCE_DATE_EPOCH = "2000-01-01T00:00:00.000Z";

export const MEDIA_TYPES = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
]);

const SHA256 = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const MODULE_ID = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/u;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
const PRIVATE_KEY = /-----BEGIN (?:OPENSSH |EC |RSA )?PRIVATE KEY-----/u;
const TOKEN = /(?:^|[^A-Za-z0-9_])(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/u;
const ABSOLUTE_WIN = /(?:^|[\s("'=,:])(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/])/u;
const ABSOLUTE_UNIX = /(?:^|[\s("'=,:])\/(?:home|Users|mnt|tmp)\//u;
const NON_PUBLIC_LICENSE = /(?:^|[^A-Za-z0-9])(unknown|private_reference|unlicensed)(?:$|[^A-Za-z0-9])/iu;
const FORBIDDEN_PUBLIC_FILE =
  /(?:^|\/)(?:\.git|source|validation)(?:\/|$)|(?:^|\/)original\.r$|\.(?:pdf|rds|rda|rdata|log)$/iu;

function compare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** A stable, compact JSON representation used for digests and comparisons. */
export function canonical(value) {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    assert(Number.isFinite(value), "canonical JSON contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  assert(isRecord(value), `value of type ${typeof value} is not canonical JSON`);
  return `{${Object.keys(value).sort(compare).map((key) => {
    assert(value[key] !== undefined, `canonical JSON property ${key} is undefined`);
    return `${JSON.stringify(key)}:${canonical(value[key])}`;
  }).join(",")}}`;
}

function sortedJsonValue(value) {
  if (Array.isArray(value)) return value.map(sortedJsonValue);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value).sort(compare).map((key) => [key, sortedJsonValue(value[key])]),
    );
  }
  assert(value !== undefined, "stable JSON cannot contain undefined");
  return value;
}

export function stableJson(value) {
  // Sorting recursively is important: JSON.stringify's replacer-array form
  // only sorts keys at the top level and silently drops nested properties.
  return `${JSON.stringify(sortedJsonValue(value), null, 2)}\n`;
}

export function argument(name, argv = process.argv.slice(2)) {
  const index = argv.indexOf(name);
  return index < 0 ? undefined : argv[index + 1];
}

export function flag(name, argv = process.argv.slice(2)) {
  return argv.includes(name);
}

export function requireArgument(name, argv = process.argv.slice(2)) {
  const value = argument(name, argv);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function assertCommit(value, label = "commit") {
  assert(typeof value === "string" && COMMIT.test(value.toLowerCase()), `${label} must be a 40-hex commit`);
  return value.toLowerCase();
}

export function assertRepository(value, label = "repository") {
  assert(typeof value === "string" && REPOSITORY_PATTERN.test(value), `${label} must be owner/repository`);
  return value;
}

export function portablePath(value, label = "path") {
  assert(typeof value === "string" && value.length > 0, `${label} must be a non-empty path`);
  assert(value.normalize("NFC") === value, `${label} must be NFC-normalized`);
  assert(!value.includes("\\") && !value.includes("\0"), `${label} must use portable separators`);
  assert(!value.startsWith("/") && !/^[A-Za-z]:/u.test(value) && !value.endsWith("/"), `${label} is absolute or has a trailing separator`);
  const parts = value.split("/");
  assert(parts.every((part) => (
    part &&
    part !== "." &&
    part !== ".." &&
    !part.startsWith(".") &&
    !part.endsWith(".") &&
    !part.endsWith(" ") &&
    !RESERVED.test(part) &&
    !/[<>:"|?*]/u.test(part) &&
    !/[\u0000-\u001f]/u.test(part)
  )), `${label} is not portable: ${value}`);
  return value;
}

async function regularDirectory(root, label) {
  const stat = await fs.lstat(root);
  assert(stat.isDirectory() && !stat.isSymbolicLink(), `${label} must be a regular directory`);
}

export async function regularFile(root, relative, label = "file") {
  const safe = portablePath(relative, `${label} path`);
  const absoluteRoot = path.resolve(root);
  await regularDirectory(absoluteRoot, `${label} root`);
  const target = path.resolve(absoluteRoot, ...safe.split("/"));
  const outside = path.relative(absoluteRoot, target);
  assert(outside && !outside.startsWith("..") && !path.isAbsolute(outside), `${label} escapes root`);
  let current = absoluteRoot;
  const parts = safe.split("/");
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    const stat = await fs.lstat(current);
    assert(!stat.isSymbolicLink(), `${label} traverses a symlink: ${safe}`);
    assert(index < parts.length - 1 ? stat.isDirectory() : stat.isFile(), `${label} is not regular: ${safe}`);
  }
  const bytes = new Uint8Array(await fs.readFile(target));
  assert(bytes.byteLength <= MAX_FILE_BYTES, `${label} exceeds ${MAX_FILE_BYTES} bytes: ${safe}`);
  return { absolute: target, bytes };
}

export async function walkFiles(root, prefix = "") {
  const absoluteRoot = path.resolve(root);
  if (!prefix) await regularDirectory(absoluteRoot, "module root");
  const directory = prefix ? path.join(absoluteRoot, ...prefix.split("/")) : absoluteRoot;
  const entries = (await fs.readdir(directory, { withFileTypes: true })).sort((left, right) => compare(left.name, right.name));
  const output = [];
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    portablePath(relative);
    const absolute = path.join(absoluteRoot, ...relative.split("/"));
    assert(!entry.isSymbolicLink(), `symlink is not allowed: ${relative}`);
    if (entry.isDirectory()) output.push(...(await walkFiles(absoluteRoot, relative)));
    else if (entry.isFile()) output.push(relative);
    else throw new Error(`non-regular module entry: ${relative}`);
  }
  return output.sort(compare);
}

function text(value, label, maximum = 8_000) {
  assert(typeof value === "string" && value.trim() && value.length <= maximum, `${label} must be a non-empty string no longer than ${maximum}`);
  return value;
}

function strings(value, label, maximum = 10_000) {
  assert(Array.isArray(value) && value.length <= maximum, `${label} must be an array`);
  const result = value.map((item, index) => text(item, `${label}[${index}]`, 1_000));
  assert(new Set(result).size === result.length, `${label} contains duplicates`);
  return result;
}

function canonicalStrings(value, label) {
  const sorted = [...value].sort(compare);
  assert(canonical(value) === canonical(sorted), `${label} must be canonically sorted`);
  return value;
}

function fileIdentity(value, label) {
  assert(isRecord(value), `${label} must be an object`);
  const allowed = new Set(["path", "bytes", "sha256", "mediaType"]);
  assert(Object.keys(value).every((key) => allowed.has(key)), `${label} has unsupported fields`);
  for (const key of ["path", "bytes", "sha256", "mediaType"]) assert(Object.hasOwn(value, key), `${label}.${key} is required`);
  const file = portablePath(value.path, `${label}.path`);
  const extension = path.posix.extname(file).toLowerCase();
  const mediaType = MEDIA_TYPES.get(extension);
  assert(mediaType && value.mediaType === mediaType, `${label}.mediaType disagrees with its extension`);
  assert(Number.isSafeInteger(value.bytes) && value.bytes > 0 && value.bytes <= MAX_FILE_BYTES, `${label}.bytes is invalid`);
  const digest = String(value.sha256).toLowerCase();
  assert(SHA256.test(digest), `${label}.sha256 is invalid`);
  return { path: file, bytes: value.bytes, sha256: digest, mediaType };
}

function scanText(name, value) {
  if (PRIVATE_KEY.test(value) || TOKEN.test(value) || ABSOLUTE_WIN.test(value) || ABSOLUTE_UNIX.test(value)) {
    throw new Error(`sensitive or machine-local text detected in ${name}`);
  }
}

async function scanFile(name, bytes) {
  if (bytes.byteLength > MAX_TEXT_BYTES || bytes.includes(0)) return;
  let value;
  try {
    value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return;
  }
  scanText(name, value);
}

function exactKeys(value, required, optional, label) {
  const allowed = new Set([...required, ...optional]);
  for (const key of required) assert(Object.hasOwn(value, key), `${label}.${key} is required`);
  assert(Object.keys(value).every((key) => allowed.has(key)), `${label} has unsupported fields`);
}

function publicLicense(value, label) {
  const result = text(value, label, 200);
  assert(!NON_PUBLIC_LICENSE.test(result), `${label} does not establish public redistribution rights`);
  return result;
}

export async function loadModule(moduleDirectory) {
  const root = path.resolve(moduleDirectory);
  await regularDirectory(root, "module root");
  const moduleId = path.basename(root);
  assert(MODULE_ID.test(moduleId), `invalid module directory id: ${moduleId}`);
  const manifest = await regularFile(root, "module.yml", "module manifest");
  const manifestText = new TextDecoder("utf-8", { fatal: true }).decode(manifest.bytes);
  scanText("module.yml", manifestText);
  const raw = parseYaml(manifestText, { uniqueKeys: true });
  assert(isRecord(raw), `${moduleId}/module.yml must be an object`);
  exactKeys(raw, [
    "schema", "moduleId", "title", "titleEn", "description", "application", "dataProfile",
    "plotFamily", "language", "tags", "packages", "codeFiles", "inputFiles", "canonicalCode",
    "requiredFiles", "files", "preview", "thumbnail", "licenses", "publisher",
  ], ["provenance"], `${moduleId}/module.yml`);
  assert(raw.schema === MODULE_SCHEMA && raw.moduleId === moduleId, `${moduleId}/module.yml schema or moduleId is invalid`);

  const files = await walkFiles(root);
  assert(files.length <= MAX_FILES, `${moduleId} contains too many files`);
  const listedFiles = canonicalStrings(strings(raw.files, `${moduleId}.files`, MAX_FILES).map((file, index) => portablePath(file, `${moduleId}.files[${index}]`)), `${moduleId}.files`);
  assert(canonical(files) === canonical(listedFiles), `${moduleId}.files does not exactly match the module directory`);
  const folded = new Map();
  const resolvedFiles = [];
  for (const file of files) {
    const key = file.normalize("NFC").toLocaleLowerCase("en-US");
    assert(!folded.has(key), `${moduleId} has a case/NFC collision: ${folded.get(key)} / ${file}`);
    folded.set(key, file);
    const loaded = await regularFile(root, file, `${moduleId}/${file}`);
    await scanFile(file, loaded.bytes);
    resolvedFiles.push({ path: file, bytes: loaded.bytes.byteLength, sha256: sha256(loaded.bytes), data: loaded.bytes });
  }

  const requiredFiles = canonicalStrings(strings(raw.requiredFiles, `${moduleId}.requiredFiles`).map((file, index) => portablePath(file, `${moduleId}.requiredFiles[${index}]`)), `${moduleId}.requiredFiles`);
  const codeFiles = canonicalStrings(strings(raw.codeFiles, `${moduleId}.codeFiles`, 100).map((file, index) => portablePath(file, `${moduleId}.codeFiles[${index}]`)), `${moduleId}.codeFiles`);
  const inputFiles = canonicalStrings(strings(raw.inputFiles, `${moduleId}.inputFiles`, 1_000).map((file, index) => portablePath(file, `${moduleId}.inputFiles[${index}]`)), `${moduleId}.inputFiles`);
  const canonicalCode = portablePath(raw.canonicalCode, `${moduleId}.canonicalCode`);
  const fileSet = new Set(files);
  assert(codeFiles.includes(canonicalCode), `${moduleId}.canonicalCode must be listed in codeFiles`);
  for (const file of [canonicalCode, ...requiredFiles, ...codeFiles, ...inputFiles]) assert(fileSet.has(file), `${moduleId} references undeclared file ${file}`);
  assert(requiredFiles.includes(canonicalCode), `${moduleId}.requiredFiles must include canonicalCode`);
  assert(!files.some((file) => FORBIDDEN_PUBLIC_FILE.test(file)), `${moduleId} contains an excluded source/reference or private file`);

  const preview = fileIdentity(raw.preview, `${moduleId}.preview`);
  const thumbnail = fileIdentity(raw.thumbnail, `${moduleId}.thumbnail`);
  for (const item of [preview, thumbnail]) {
    assert(fileSet.has(item.path), `${moduleId} preview references undeclared file ${item.path}`);
    const actual = resolvedFiles.find((file) => file.path === item.path);
    assert(actual && actual.bytes === item.bytes && actual.sha256 === item.sha256, `${moduleId}/${item.path} digest mismatch`);
  }

  exactKeys(raw.licenses, ["code", "content", "documentation"], [], `${moduleId}.licenses`);
  const licenses = {
    code: publicLicense(raw.licenses.code, `${moduleId}.licenses.code`),
    content: publicLicense(raw.licenses.content, `${moduleId}.licenses.content`),
    documentation: publicLicense(raw.licenses.documentation, `${moduleId}.licenses.documentation`),
  };
  exactKeys(raw.publisher, ["reviewStatus", "executionStatus", "executionScope"], ["evidence"], `${moduleId}.publisher`);
  assert(raw.publisher.reviewStatus === "approved", `${moduleId}.publisher.reviewStatus must be approved`);
  const executionStatus = String(raw.publisher.executionStatus);
  const executionScope = String(raw.publisher.executionScope);
  assert(["not_run", "passed", "failed"].includes(executionStatus), `${moduleId}.publisher.executionStatus is invalid`);
  assert(["synthetic_data", "example_data", "real_data", "unknown"].includes(executionScope), `${moduleId}.publisher.executionScope is invalid`);
  assert(!(executionStatus === "passed" && executionScope === "unknown"), `${moduleId}.passed execution needs a scope`);
  const publisherEvidence = raw.publisher.evidence === undefined
    ? []
    : canonicalStrings(strings(raw.publisher.evidence, `${moduleId}.publisher.evidence`).map((file, index) => portablePath(file, `${moduleId}.publisher.evidence[${index}]`)), `${moduleId}.publisher.evidence`);
  for (const file of publisherEvidence) assert(fileSet.has(file), `${moduleId}.publisher.evidence references undeclared file ${file}`);

  let provenance;
  if (raw.provenance !== undefined) {
    assert(Array.isArray(raw.provenance) && raw.provenance.every(isRecord), `${moduleId}.provenance must be an array of objects`);
    provenance = raw.provenance;
    scanText("provenance", JSON.stringify(provenance));
  }

  const metadata = {
    schema: MODULE_SCHEMA,
    moduleId,
    title: text(raw.title, `${moduleId}.title`, 300),
    titleEn: text(raw.titleEn, `${moduleId}.titleEn`, 300),
    description: text(raw.description, `${moduleId}.description`),
    application: text(raw.application, `${moduleId}.application`),
    dataProfile: text(raw.dataProfile, `${moduleId}.dataProfile`),
    plotFamily: text(raw.plotFamily, `${moduleId}.plotFamily`, 200),
    language: text(raw.language, `${moduleId}.language`, 100),
    tags: canonicalStrings(strings(raw.tags, `${moduleId}.tags`, 100), `${moduleId}.tags`),
    packages: canonicalStrings(strings(raw.packages, `${moduleId}.packages`, 100), `${moduleId}.packages`),
    codeFiles,
    inputFiles,
    canonicalCode,
    requiredFiles,
    preview,
    thumbnail,
    licenses,
    publisher: {
      reviewStatus: "approved",
      executionStatus,
      executionScope,
      ...(publisherEvidence.length ? { evidence: publisherEvidence } : {}),
    },
    ...(provenance ? { provenance } : {}),
  };
  return { root, moduleId, files: resolvedFiles.sort((left, right) => compare(left.path, right.path)), metadata };
}

export async function resolvedModule(moduleDirectory) {
  return loadModule(moduleDirectory);
}

export function archiveBytes(loaded) {
  const archive = Object.fromEntries(loaded.files.map((file) => [file.path, file.data]));
  const bytes = zipSync(archive, {
    level: 6,
    mtime: new Date(SOURCE_DATE_EPOCH),
  });
  const unpacked = unzipSync(bytes);
  const expected = loaded.files.map((file) => file.path).sort(compare);
  const actual = Object.keys(unpacked).sort(compare);
  assert(canonical(actual) === canonical(expected), `${loaded.moduleId} deterministic archive inventory mismatch`);
  for (const file of expected) assert(sha256(unpacked[file]) === sha256(archive[file]), `${loaded.moduleId}/${file} archive round-trip mismatch`);
  assert(bytes.byteLength <= MAX_ARCHIVE_BYTES, `${loaded.moduleId} archive exceeds ${MAX_ARCHIVE_BYTES} bytes`);
  return { bytes, sha256: sha256(bytes), bytesLength: bytes.byteLength, files: expected };
}

export function moduleCatalogEntry(loaded, sourceCommit, archiveCommit, repository = REPOSITORY, archive = archiveBytes(loaded)) {
  const previewName = path.posix.basename(loaded.metadata.preview.path);
  const thumbnailExtension = path.posix.extname(loaded.metadata.thumbnail.path).toLowerCase();
  return {
    moduleId: loaded.moduleId,
    title: loaded.metadata.title,
    titleEn: loaded.metadata.titleEn,
    description: loaded.metadata.description,
    application: loaded.metadata.application,
    dataProfile: loaded.metadata.dataProfile,
    plotFamily: loaded.metadata.plotFamily,
    language: loaded.metadata.language,
    tags: [...loaded.metadata.tags],
    packages: [...loaded.metadata.packages],
    codeFiles: [...loaded.metadata.codeFiles],
    inputFiles: [...loaded.metadata.inputFiles],
    canonicalCode: loaded.metadata.canonicalCode,
    requiredFiles: [...loaded.metadata.requiredFiles],
    files: loaded.files.map(({ path: file, bytes, sha256: fileSha256 }) => ({ path: file, bytes, sha256: fileSha256 })),
    source: { repository, commit: assertCommit(sourceCommit, "sourceCommit"), path: `modules/${loaded.moduleId}` },
    archive: {
      repository,
      commit: assertCommit(archiveCommit, "archiveCommit"),
      path: `archives/${loaded.moduleId}.zip`,
      bytes: archive.bytesLength,
      sha256: archive.sha256,
    },
    preview: {
      path: `previews/${loaded.moduleId}/${previewName}`,
      bytes: loaded.metadata.preview.bytes,
      sha256: loaded.metadata.preview.sha256,
      mediaType: loaded.metadata.preview.mediaType,
    },
    thumbnail: {
      path: `thumbs/${loaded.moduleId}${thumbnailExtension}`,
      bytes: loaded.metadata.thumbnail.bytes,
      sha256: loaded.metadata.thumbnail.sha256,
      mediaType: loaded.metadata.thumbnail.mediaType,
    },
    licenses: { ...loaded.metadata.licenses },
    publisher: {
      ...loaded.metadata.publisher,
      ...(loaded.metadata.publisher.evidence ? { evidence: [...loaded.metadata.publisher.evidence] } : {}),
    },
    ...(loaded.metadata.provenance ? { provenance: loaded.metadata.provenance } : {}),
  };
}

export async function readArchive(repositoryRoot, moduleId) {
  assert(MODULE_ID.test(moduleId), `invalid module id: ${moduleId}`);
  const relative = `archives/${moduleId}.zip`;
  const loaded = await regularFile(repositoryRoot, relative, "archive");
  return { file: loaded.absolute, bytes: loaded.bytes, sha256: sha256(loaded.bytes), bytesLength: loaded.bytes.byteLength };
}

export function moduleManifestYaml(metadata) {
  return stringifyYaml(metadata, { sortMapEntries: true, lineWidth: 0 });
}

async function gitCommand(repositoryRoot, args, label, options = {}) {
  const result = await execFile("git", args, {
    cwd: path.resolve(repositoryRoot),
    encoding: options.encoding ?? "buffer",
    maxBuffer: options.maxBuffer ?? 256 * 1024 * 1024,
    windowsHide: true,
  });
  if (options.encoding === "utf8") return String(result.stdout);
  return result.stdout instanceof Buffer ? new Uint8Array(result.stdout) : new Uint8Array(Buffer.from(result.stdout));
}

export async function resolveGitCommit(repositoryRoot, ref = "HEAD") {
  const output = await gitCommand(repositoryRoot, ["rev-parse", "--verify", `${ref}^{commit}`], "git commit", { encoding: "utf8", maxBuffer: 1024 * 1024 });
  return assertCommit(output.trim(), `Git ${ref}`);
}

async function gitTreeFiles(repositoryRoot, commit, prefix) {
  const output = await gitCommand(repositoryRoot, ["ls-tree", "-r", "-z", "--name-only", commit, "--", prefix], "Git tree");
  const textValue = new TextDecoder("utf-8", { fatal: true }).decode(output);
  return textValue.split("\0").filter(Boolean).map((file) => {
    assert(file.startsWith(`${prefix}/`), `Git tree escaped ${prefix}: ${file}`);
    return file.slice(prefix.length + 1);
  }).sort(compare);
}

async function gitBlob(repositoryRoot, commit, relative) {
  portablePath(relative, "Git tree path");
  return gitCommand(repositoryRoot, ["cat-file", "blob", `${commit}:modules/${relative}`], "Git source blob");
}

async function gitArchiveBlob(repositoryRoot, commit, relative) {
  portablePath(relative, "Git archive path");
  return gitCommand(repositoryRoot, ["cat-file", "blob", `${commit}:${relative}`], "Git archive blob");
}

export async function verifySourceCommit(repositoryRoot, loaded, sourceCommit) {
  const commit = assertCommit(sourceCommit, "sourceCommit");
  const actualFiles = await gitTreeFiles(repositoryRoot, commit, `modules/${loaded.moduleId}`);
  const expectedFiles = loaded.files.map((file) => file.path).sort(compare);
  assert(canonical(actualFiles) === canonical(expectedFiles), `${loaded.moduleId} source commit file tree differs from the cleaned module`);
  for (const file of expectedFiles) {
    const fromCommit = await gitBlob(repositoryRoot, commit, `${loaded.moduleId}/${file}`);
    const local = loaded.files.find((item) => item.path === file)?.data;
    assert(local && Buffer.from(fromCommit).equals(Buffer.from(local)), `${loaded.moduleId}/${file} differs from source commit ${commit}`);
  }
  return commit;
}

export async function verifyArchiveCommit(repositoryRoot, loaded, sourceCommit, archiveCommit) {
  const source = assertCommit(sourceCommit, "sourceCommit");
  const archive = assertCommit(archiveCommit, "archiveCommit");
  try {
    await gitCommand(repositoryRoot, ["merge-base", "--is-ancestor", source, archive], "Git commit ancestry");
  } catch {
    throw new Error(`${archive} is not a descendant of source commit ${source}`);
  }
  const moduleTreePath = `modules/${loaded.moduleId}`;
  const sourceTree = await gitCommand(
    repositoryRoot,
    ["rev-parse", "--verify", `${source}:${moduleTreePath}`],
    "Git source module tree",
    { encoding: "utf8", maxBuffer: 1024 * 1024 },
  );
  const archiveTree = await gitCommand(
    repositoryRoot,
    ["rev-parse", "--verify", `${archive}:${moduleTreePath}`],
    "Git archive module tree",
    { encoding: "utf8", maxBuffer: 1024 * 1024 },
  );
  assert(
    sourceTree.trim() === archiveTree.trim(),
    `${loaded.moduleId} source tree bytes changed between source and archive commits`,
  );
  const expected = archiveBytes(loaded);
  const fromCommit = await gitArchiveBlob(repositoryRoot, archive, `archives/${loaded.moduleId}.zip`);
  assert(Buffer.from(fromCommit).equals(Buffer.from(expected.bytes)), `${loaded.moduleId} archive commit is not generated from source commit ${source}`);
  return { ...expected, sourceCommit: source, archiveCommit: archive };
}

export async function moduleDirectories(repositoryRoot) {
  const root = path.resolve(repositoryRoot, "modules");
  await regularDirectory(root, "modules directory");
  const entries = (await fs.readdir(root, { withFileTypes: true })).sort((left, right) => compare(left.name, right.name));
  const result = [];
  for (const entry of entries) {
    assert(!entry.isSymbolicLink(), `modules directory contains a symlink: ${entry.name}`);
    if (!entry.isDirectory()) throw new Error(`modules directory contains a non-directory: ${entry.name}`);
    portablePath(entry.name, "module id");
    assert(MODULE_ID.test(entry.name), `invalid module directory id: ${entry.name}`);
    result.push(path.join(root, entry.name));
  }
  return result;
}

export async function selectedModuleDirectories(repositoryRoot, moduleIds = []) {
  const directories = await moduleDirectories(repositoryRoot);
  const byId = new Map(directories.map((directory) => [path.basename(directory), directory]));
  const selected = moduleIds.length ? [...new Set(moduleIds)].sort(compare) : [...byId.keys()].sort(compare);
  return selected.map((moduleId) => {
    assert(MODULE_ID.test(moduleId), `invalid module id: ${moduleId}`);
    const directory = byId.get(moduleId);
    if (!directory) throw new Error(`unknown module: ${moduleId}`);
    return directory;
  });
}

async function readTree(root) {
  await regularDirectory(root, "generated output root");
  const files = await walkFiles(root);
  const output = new Map();
  for (const file of files) output.set(file, (await regularFile(root, file, "generated output")).bytes);
  return output;
}

export async function compareGeneratedTree(root, expected) {
  let actual;
  try {
    actual = await readTree(root);
  } catch (error) {
    if (error?.code === "ENOENT") return { equal: false, missingRoot: true, missing: [...expected.keys()].sort(compare), unexpected: [], changed: [] };
    throw error;
  }
  const missing = [...expected.keys()].filter((file) => !actual.has(file)).sort(compare);
  const unexpected = [...actual.keys()].filter((file) => !expected.has(file)).sort(compare);
  const changed = [...expected.keys()].filter((file) => actual.has(file) && !Buffer.from(actual.get(file)).equals(Buffer.from(expected.get(file)))).sort(compare);
  return { equal: !missing.length && !unexpected.length && !changed.length, missing, unexpected, changed };
}

async function replaceDirectory(target, expected) {
  const absoluteTarget = path.resolve(target);
  const parent = path.dirname(absoluteTarget);
  await fs.mkdir(parent, { recursive: true });
  const staging = path.join(parent, `.${path.basename(absoluteTarget)}.staging-${randomUUID()}`);
  await fs.mkdir(staging);
  try {
    for (const [relative, bytes] of [...expected.entries()].sort(([left], [right]) => compare(left, right))) {
      const safe = portablePath(relative, "generated output path");
      const destination = path.join(staging, ...safe.split("/"));
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, bytes, { flag: "wx" });
    }
    const backup = path.join(parent, `.${path.basename(absoluteTarget)}.backup-${randomUUID()}`);
    let movedTarget = false;
    try {
      try {
        const stat = await fs.lstat(absoluteTarget);
        assert(!stat.isSymbolicLink() && stat.isDirectory(), `generated output target is not a regular directory: ${absoluteTarget}`);
        await fs.rename(absoluteTarget, backup);
        movedTarget = true;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      await fs.rename(staging, absoluteTarget);
      if (movedTarget) await fs.rm(backup, { recursive: true, force: true });
    } catch (error) {
      await fs.rm(absoluteTarget, { recursive: true, force: true }).catch(() => undefined);
      if (movedTarget) await fs.rename(backup, absoluteTarget).catch(() => undefined);
      throw error;
    }
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function atomicReplaceFile(target, bytes) {
  const absolute = path.resolve(target);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  const temporary = `${absolute}.staging-${randomUUID()}`;
  await fs.writeFile(temporary, bytes, { flag: "wx" });
  try {
    await fs.rename(temporary, absolute);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function replaceFileWithBackup(target, bytes) {
  const absolute = path.resolve(target);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  const temporary = `${absolute}.staging-${randomUUID()}`;
  const backup = `${absolute}.backup-${randomUUID()}`;
  await fs.writeFile(temporary, bytes, { flag: "wx" });
  let hadTarget = false;
  try {
    const stat = await fs.lstat(absolute);
    assert(!stat.isSymbolicLink() && stat.isFile(), `cannot replace non-regular file: ${absolute}`);
    await fs.rename(absolute, backup);
    hadTarget = true;
  } catch (error) {
    if (error?.code !== "ENOENT") {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }
  try {
    await fs.rename(temporary, absolute);
  } catch (error) {
    if (hadTarget) await fs.rename(backup, absolute).catch(() => undefined);
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  return {
    async commit() {
      if (hadTarget) await fs.rm(backup, { force: true });
    },
    async rollback() {
      await fs.rm(absolute, { force: true });
      if (hadTarget) await fs.rename(backup, absolute).catch(() => undefined);
    },
  };
}

function parseModuleIds(options) {
  const values = [];
  for (const value of options.modules ?? []) values.push(...value.split(",").map((item) => item.trim()).filter(Boolean));
  return [...new Set(values)].sort(compare);
}

function generatedAt(value) {
  if (value === undefined) return SOURCE_DATE_EPOCH;
  const date = new Date(value);
  assert(!Number.isNaN(date.valueOf()), `invalid --generated-at: ${value}`);
  return date.toISOString();
}

export async function validatePersonalModules(options = {}) {
  const repositoryRoot = path.resolve(options.repositoryRoot ?? DEFAULT_REPOSITORY_ROOT);
  const directories = await selectedModuleDirectories(repositoryRoot, options.moduleIds ?? []);
  const modules = [];
  for (const directory of directories) {
    const loaded = await resolvedModule(directory);
    const archive = archiveBytes(loaded);
    modules.push({
      moduleId: loaded.moduleId,
      files: loaded.files.map(({ path: file, bytes, sha256: digest }) => ({ path: file, bytes, sha256: digest })),
      requiredFiles: [...loaded.metadata.requiredFiles],
      codeFiles: [...loaded.metadata.codeFiles],
      inputFiles: [...loaded.metadata.inputFiles],
      preview: { ...loaded.metadata.preview },
      thumbnail: { ...loaded.metadata.thumbnail },
      archive: { bytes: archive.bytesLength, sha256: archive.sha256 },
      licenses: { ...loaded.metadata.licenses },
      publisher: { ...loaded.metadata.publisher },
      include: loaded.files.map((file) => file.path),
      exclude: [],
    });
  }
  return {
    schema: "figure-library.personal-module-validation-report.v1",
    providerId: PROVIDER_ID,
    repository: repositoryRoot,
    modules,
  };
}

export async function archivePersonalModules(options = {}) {
  const repositoryRoot = path.resolve(options.repositoryRoot ?? DEFAULT_REPOSITORY_ROOT);
  const moduleIds = options.moduleIds ?? [];
  const directories = await selectedModuleDirectories(repositoryRoot, moduleIds);
  const sourceCommit = options.sourceCommit
    ? assertCommit(options.sourceCommit, "sourceCommit")
    : await resolveGitCommit(repositoryRoot, options.sourceRef ?? "HEAD");
  const archives = [];
  for (const directory of directories) {
    const loaded = await resolvedModule(directory);
    await verifySourceCommit(repositoryRoot, loaded, sourceCommit);
    const archive = archiveBytes(loaded);
    const relative = `archives/${loaded.moduleId}.zip`;
    const existing = await fs.readFile(path.join(repositoryRoot, ...relative.split("/"))).catch((error) => {
      if (error?.code === "ENOENT") return undefined;
      throw error;
    });
    const same = existing ? Buffer.from(existing).equals(Buffer.from(archive.bytes)) : false;
    archives.push({
      moduleId: loaded.moduleId,
      file: relative,
      bytes: archive.bytesLength,
      sha256: archive.sha256,
      files: archive.files,
      existing: Boolean(existing),
      unchanged: same,
      bytesValue: archive.bytes,
    });
  }
  let priorManifest;
  const manifestPath = path.join(repositoryRoot, "catalog", "archive-manifest.json");
  try {
    priorManifest = parseArchiveManifest(
      JSON.parse(await fs.readFile(manifestPath, "utf8")),
      { repository: REPOSITORY },
    );
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const selectedIds = new Set(archives.map((archive) => archive.moduleId));
  const preservedEntries = options.moduleIds?.length
    ? (priorManifest?.entries ?? []).filter((entry) => !selectedIds.has(entry.moduleId))
    : [];
  const generatedEntries = archives.map(({ bytesValue, existing, unchanged, ...entry }) => ({
    ...entry,
    ...(sourceCommit ? { sourceCommit } : {}),
  }));
  const manifest = {
    schema: ARCHIVE_MANIFEST_SCHEMA,
    providerId: PROVIDER_ID,
    repository: REPOSITORY,
    generatedAt: generatedAt(options.generatedAt),
    entries: [...preservedEntries, ...generatedEntries].sort((left, right) => compare(left.moduleId, right.moduleId)),
  };
  const expectedManifestBytes = Buffer.from(stableJson(manifest), "utf8");
  const expectedEntries = manifest.entries.map(({ moduleId, file, bytes, sha256: digest, files, sourceCommit: entrySourceCommit }) => ({
    moduleId, file, bytes, sha256: digest, files, sourceCommit: entrySourceCommit,
  }));
  const priorEntries = priorManifest?.entries ?? [];
  const comparison = {
    archivesChanged: expectedEntries.filter((entry) => {
      const prior = priorEntries.find((item) => item.moduleId === entry.moduleId);
      return !prior || canonical(prior) !== canonical(entry);
    }).map((entry) => entry.moduleId),
    archivesRemoved: options.moduleIds?.length
      ? []
      : priorEntries.filter((entry) => !expectedEntries.some((item) => item.moduleId === entry.moduleId)).map((entry) => entry.moduleId),
    manifestChanged: !priorManifest || !Buffer.from(await fs.readFile(manifestPath).catch(() => Buffer.from([]))).equals(expectedManifestBytes),
  };
  if (options.write) {
    // All bytes have been validated before the first live-tree write. Use a
    // sibling staging directory so a failed generation never leaves a
    // partially written archive set or archive manifest.
    const staging = path.join(repositoryRoot, `.personal-archives-staging-${randomUUID()}`);
    await fs.mkdir(staging, { recursive: true });
    try {
      for (const archive of archives) {
        const destination = path.join(staging, ...archive.file.split("/"));
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.writeFile(destination, archive.bytesValue, { flag: "wx" });
      }
      const manifestFile = path.join(staging, "catalog", "archive-manifest.json");
      await fs.mkdir(path.dirname(manifestFile), { recursive: true });
      await fs.writeFile(manifestFile, expectedManifestBytes, { flag: "wx" });
      const replacements = [];
      try {
        for (const archive of archives) {
          replacements.push(
            await replaceFileWithBackup(
              path.join(repositoryRoot, archive.file),
              await fs.readFile(path.join(staging, ...archive.file.split("/"))),
            ),
          );
        }
        replacements.push(
          await replaceFileWithBackup(
            path.join(repositoryRoot, "catalog", "archive-manifest.json"),
            await fs.readFile(manifestFile),
          ),
        );
        for (const replacement of replacements) await replacement.commit();
      } catch (error) {
        for (const replacement of replacements.reverse()) await replacement.rollback();
        throw error;
      }
    } finally {
      await fs.rm(staging, { recursive: true, force: true });
    }
  }
  return {
    ...manifest,
    modules: archives.map(({ bytesValue, ...entry }) => entry),
    comparison,
    checkPassed: archives.every((archive) => archive.unchanged) &&
      comparison.archivesRemoved.length === 0 &&
      !comparison.manifestChanged,
    mode: options.write ? "write" : "check",
  };
}

export function parseArchiveManifest(value, options = {}) {
  assert(isRecord(value) && value.schema === ARCHIVE_MANIFEST_SCHEMA, "archive manifest schema is invalid");
  assert(value.providerId === PROVIDER_ID, "archive manifest providerId is invalid");
  assertRepository(value.repository, "archive manifest repository");
  if (options.repository && value.repository !== options.repository) {
    throw new Error("archive manifest repository differs from the requested repository");
  }
  assert(typeof value.generatedAt === "string" && !Number.isNaN(Date.parse(value.generatedAt)), "archive manifest generatedAt is invalid");
  assert(Array.isArray(value.entries), "archive manifest entries are missing");
  const entries = value.entries.map((item, index) => {
    assert(isRecord(item), `archive manifest entry ${index} is invalid`);
    const required = ["moduleId", "file", "bytes", "sha256", "files", "sourceCommit"];
    assert(required.every((key) => Object.hasOwn(item, key)), `archive manifest entry ${index} is incomplete`);
    const moduleId = String(item.moduleId);
    assert(MODULE_ID.test(moduleId), `archive manifest moduleId is invalid: ${moduleId}`);
    const file = portablePath(item.file, `archive manifest ${moduleId}.file`);
    assert(file === `archives/${moduleId}.zip`, `archive manifest path is invalid: ${moduleId}`);
    assert(Number.isSafeInteger(item.bytes) && item.bytes > 0 && item.bytes <= MAX_ARCHIVE_BYTES, `archive manifest bytes are invalid: ${moduleId}`);
    const digest = String(item.sha256).toLowerCase();
    assert(SHA256.test(digest), `archive manifest SHA-256 is invalid: ${moduleId}`);
    const sourceCommit = assertCommit(item.sourceCommit, `archive manifest ${moduleId}.sourceCommit`);
    assert(Array.isArray(item.files), `archive manifest files are invalid: ${moduleId}`);
    const files = item.files.map((file, fileIndex) => portablePath(file, `archive manifest ${moduleId}.files[${fileIndex}]`));
    assert(new Set(files).size === files.length, `archive manifest files contain duplicates: ${moduleId}`);
    assert(canonical(files) === canonical([...files].sort(compare)), `archive manifest files are not sorted: ${moduleId}`);
    return { moduleId, file, bytes: item.bytes, sha256: digest, files, sourceCommit };
  });
  assert(new Set(entries.map((item) => item.moduleId)).size === entries.length, "archive manifest contains duplicate modules");
  assert(canonical(entries) === canonical([...entries].sort((left, right) => compare(left.moduleId, right.moduleId))), "archive manifest entries are not sorted");
  return { schema: ARCHIVE_MANIFEST_SCHEMA, providerId: PROVIDER_ID, repository: value.repository, generatedAt: value.generatedAt, entries };
}

async function gitBackedModules(repositoryRoot, moduleIds, sourceCommit, archiveCommit) {
  const directories = await selectedModuleDirectories(repositoryRoot, moduleIds);
  const result = [];
  for (const directory of directories) {
    const loaded = await resolvedModule(directory);
    await verifySourceCommit(repositoryRoot, loaded, sourceCommit);
    const archive = await verifyArchiveCommit(repositoryRoot, loaded, sourceCommit, archiveCommit);
    result.push({ loaded, archive });
  }
  return result;
}

export async function buildPersonalModuleCatalog(options = {}) {
  const repositoryRoot = path.resolve(options.repositoryRoot ?? DEFAULT_REPOSITORY_ROOT);
  const outputRoot = path.resolve(options.outputRoot ?? DEFAULT_SNAPSHOT_ROOT);
  const archiveCommit = options.archiveCommit
    ? assertCommit(options.archiveCommit, "archiveCommit")
    : await resolveGitCommit(repositoryRoot, options.archiveRef ?? "HEAD");
  const repository = options.repository ?? REPOSITORY;
  const archiveManifestBytes = await gitArchiveBlob(
    repositoryRoot,
    archiveCommit,
    "catalog/archive-manifest.json",
  );
  const archiveManifest = parseArchiveManifest(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(archiveManifestBytes)),
    { repository },
  );
  const selectedIds = options.moduleIds?.length
    ? [...new Set(options.moduleIds)].sort(compare)
    : archiveManifest.entries.map((item) => item.moduleId);
  const manifestById = new Map(archiveManifest.entries.map((item) => [item.moduleId, item]));
  const modules = [];
  for (const moduleId of selectedIds) {
    const manifestEntry = manifestById.get(moduleId);
    assert(manifestEntry, `archive manifest does not list ${moduleId}`);
    if (options.sourceCommit && manifestEntry.sourceCommit !== assertCommit(options.sourceCommit, "sourceCommit")) {
      throw new Error(`${moduleId} archive manifest sourceCommit differs from --source-commit`);
    }
    const directory = path.join(repositoryRoot, "modules", moduleId);
    const loaded = await resolvedModule(directory);
    await verifySourceCommit(repositoryRoot, loaded, manifestEntry.sourceCommit);
    const archive = await verifyArchiveCommit(
      repositoryRoot,
      loaded,
      manifestEntry.sourceCommit,
      archiveCommit,
    );
    assert(
      archive.bytesLength === manifestEntry.bytes &&
        archive.sha256 === manifestEntry.sha256 &&
        canonical(archive.files) === canonical(manifestEntry.files),
      `${moduleId} archive manifest differs from the archive commit`,
    );
    modules.push({ loaded, archive, sourceCommit: manifestEntry.sourceCommit });
  }
  const entries = modules.map(({ loaded, archive, sourceCommit }) =>
    moduleCatalogEntry(loaded, sourceCommit, archiveCommit, repository, archive),
  );
  entries.sort((left, right) => compare(left.moduleId, right.moduleId));
  const catalog = {
    schema: CATALOG_SCHEMA,
    generatedAt: generatedAt(options.generatedAt),
    provider: {
      providerId: PROVIDER_ID,
      displayName: SOURCE_LABEL,
      repository,
    },
    modules: entries,
  };
  const previewEntries = entries.flatMap((entry) => [
    { moduleId: entry.moduleId, role: "primary", ...entry.preview },
    { moduleId: entry.moduleId, role: "thumbnail", ...entry.thumbnail },
  ]);
  const sourcePackEntries = entries.map((entry) => ({
    moduleId: entry.moduleId,
    sourceRepository: entry.source.repository,
    sourceCommit: entry.source.commit,
    archiveRepository: entry.archive.repository,
    archiveCommit: entry.archive.commit,
    file: entry.archive.path,
    bytes: entry.archive.bytes,
    sha256: entry.archive.sha256,
  }));
  const expected = new Map([
    ["module-catalog.json", Buffer.from(stableJson(catalog), "utf8")],
    ["module-preview.manifest.json", Buffer.from(stableJson({ schema: PREVIEW_SCHEMA, providerId: PROVIDER_ID, entries: previewEntries }), "utf8")],
    ["module-source-pack.manifest.json", Buffer.from(stableJson({ schema: SOURCE_PACK_SCHEMA, providerId: PROVIDER_ID, repository, entries: sourcePackEntries }), "utf8")],
    ["PERSONAL_MODULES_LICENSE.txt", Buffer.from("Open Figure Modules metadata and generated previews\n\nComplete module archives are not included in the SFL plugin; they remain in the separately maintained personal module repository and are fetched only by an exact selected identity.\n\nEach module's code, content, and documentation license is recorded in module-catalog.json. Do not infer a module license from the SFL project license.\n", "utf8")],
  ]);
  for (const entry of entries) {
    const source = modules.find(({ loaded }) => loaded.moduleId === entry.moduleId).loaded;
    const preview = source.files.find((file) => file.path === source.metadata.preview.path)?.data;
    const thumbnail = source.files.find((file) => file.path === source.metadata.thumbnail.path)?.data;
    assert(preview && thumbnail, `${entry.moduleId} preview bytes are missing`);
    expected.set(entry.preview.path, preview);
    expected.set(entry.thumbnail.path, thumbnail);
  }
  if (options.write) await replaceDirectory(outputRoot, expected);
  const comparison = await compareGeneratedTree(outputRoot, expected);
  if (!options.write && !comparison.equal) {
    return { catalog, catalogSha256: sha256(expected.get("module-catalog.json")), comparison, mode: "check" };
  }
  return { catalog, catalogSha256: sha256(expected.get("module-catalog.json")), comparison, mode: options.write ? "write" : "check" };
}

function catalogEntryMap(catalog) {
  assert(isRecord(catalog) && catalog.schema === CATALOG_SCHEMA && isRecord(catalog.provider) && Array.isArray(catalog.modules), "module Catalog has an unsupported shape");
  assert(catalog.provider.providerId === PROVIDER_ID, "module Catalog providerId is invalid");
  assertRepository(catalog.provider.repository, "module Catalog repository");
  const result = new Map();
  for (const entry of catalog.modules) {
    assert(isRecord(entry) && MODULE_ID.test(entry.moduleId), "module Catalog contains an invalid module");
    assert(!result.has(entry.moduleId), `duplicate module in Catalog: ${entry.moduleId}`);
    assert(entry.source?.repository === catalog.provider.repository, `${entry.moduleId} source repository differs from Catalog`);
    assert(entry.archive?.repository === catalog.provider.repository, `${entry.moduleId} archive repository differs from Catalog`);
    assert(entry.archive?.path === `archives/${entry.moduleId}.zip`, `${entry.moduleId} archive path is not canonical`);
    assert(Number.isSafeInteger(entry.archive?.bytes) && entry.archive.bytes > 0 && SHA256.test(String(entry.archive.sha256)), `${entry.moduleId} archive identity is invalid`);
    result.set(entry.moduleId, entry);
  }
  return result;
}

export async function packagePersonalSourcePack(options = {}) {
  const repositoryRoot = path.resolve(options.repositoryRoot ?? DEFAULT_REPOSITORY_ROOT);
  const catalogRoot = path.resolve(options.catalogRoot ?? DEFAULT_SNAPSHOT_ROOT);
  const catalog = JSON.parse(await fs.readFile(path.join(catalogRoot, "module-catalog.json"), "utf8"));
  const entriesById = catalogEntryMap(catalog);
  const selectedIds = options.moduleIds?.length ? [...new Set(options.moduleIds)].sort(compare) : [...entriesById.keys()].sort(compare);
  const files = new Map();
  const manifestEntries = [];
  for (const moduleId of selectedIds) {
    const entry = entriesById.get(moduleId);
    assert(entry, `Catalog does not list ${moduleId}`);
    const archive = await readArchive(repositoryRoot, moduleId);
    assert(archive.bytesLength === entry.archive.bytes && archive.sha256 === entry.archive.sha256, `${moduleId} archive differs from the Catalog`);
    const relative = `archives/${moduleId}.zip`;
    files.set(relative, archive.bytes);
    manifestEntries.push({
      moduleId,
      sourceRepository: entry.source.repository,
      sourceCommit: entry.source.commit,
      archiveRepository: entry.archive.repository,
      archiveCommit: entry.archive.commit,
      file: relative,
      bytes: archive.bytesLength,
      sha256: archive.sha256,
    });
  }
  const manifest = { schema: SOURCE_PACK_SCHEMA, providerId: PROVIDER_ID, repository: catalog.provider.repository, entries: manifestEntries };
  files.set("module-source-pack.manifest.json", Buffer.from(stableJson(manifest), "utf8"));
  const output = path.resolve(options.outputRoot ?? path.join(repositoryRoot, "source-pack"));
  if (output.toLowerCase().endsWith(".zip")) {
    const zip = zipSync(Object.fromEntries([...files].sort(([left], [right]) => compare(left, right))), { level: 0, mtime: new Date(SOURCE_DATE_EPOCH) });
    const existing = await fs.readFile(output).catch((error) => {
      if (error?.code === "ENOENT") return undefined;
      throw error;
    });
    const equal = existing ? Buffer.from(existing).equals(Buffer.from(zip)) : false;
    if (options.write) {
      const replacement = await replaceFileWithBackup(output, zip);
      await replacement.commit();
    }
    return {
      ...manifest,
      output,
      bytes: zip.byteLength,
      sha256: sha256(zip),
      comparison: { equal, missing: equal ? [] : [output], unexpected: [], changed: equal ? [] : [output] },
      mode: options.write ? "write" : "check",
    };
  }
  if (options.write) await replaceDirectory(output, files);
  const comparison = await compareGeneratedTree(output, files);
  return { ...manifest, output, comparison, mode: options.write ? "write" : "check" };
}

export function parseCliOptions(argv = process.argv.slice(2)) {
  const options = { modules: [], write: false, check: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--write") options.write = true;
    else if (token === "--check") options.check = true;
    else if (["--module", "--modules"].includes(token)) options.modules.push(requireArgumentAt(argv, ++index, token));
    else if (["--repository", "--repo"].includes(token)) options.repositoryRoot = requireArgumentAt(argv, ++index, token);
    else if (["--output", "--output-root"].includes(token)) options.outputRoot = requireArgumentAt(argv, ++index, token);
    else if (["--catalog", "--catalog-root"].includes(token)) options.catalogRoot = requireArgumentAt(argv, ++index, token);
    else if (token === "--source-commit") options.sourceCommit = requireArgumentAt(argv, ++index, token);
    else if (token === "--archive-commit") options.archiveCommit = requireArgumentAt(argv, ++index, token);
    else if (token === "--source-ref") options.sourceRef = requireArgumentAt(argv, ++index, token);
    else if (token === "--archive-ref") options.archiveRef = requireArgumentAt(argv, ++index, token);
    else if (token === "--generated-at") options.generatedAt = requireArgumentAt(argv, ++index, token);
    else if (token === "--help" || token === "-h") options.help = true;
    else throw new Error(`unsupported option: ${token}`);
  }
  assert(!(options.write && options.check), "choose only one of --check or --write");
  if (!options.write && !options.check) options.check = true;
  options.moduleIds = parseModuleIds(options);
  return options;
}

function requireArgumentAt(argv, index, name) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

export async function runPersonalModulesCli(command, argv = process.argv.slice(2)) {
  const options = parseCliOptions(argv);
  if (options.help) {
    console.log(`Usage: npm run modules:${command} -- --check|--write [--repository <dir>] [--modules <id,id>] [--output <dir>]`);
    return undefined;
  }
  const common = { ...options, write: options.write };
  let result;
  if (command === "validate") result = await validatePersonalModules(common);
  else if (command === "archive") result = await archivePersonalModules(common);
  else if (command === "catalog") result = await buildPersonalModuleCatalog(common);
  else if (command === "source-pack") result = await packagePersonalSourcePack(common);
  else throw new Error(`unsupported personal module command: ${command}`);
  console.log(JSON.stringify(result, null, 2));
  if (!options.write) {
    const comparisonFailed = result?.comparison && result.comparison.equal === false;
    const archiveCheckFailed = command === "archive" && result?.checkPassed === false;
    if (comparisonFailed || archiveCheckFailed) {
      process.exitCode = 1;
    }
  }
  return result;
}
