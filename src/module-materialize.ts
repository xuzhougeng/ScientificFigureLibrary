import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { unzipSync } from "fflate";
import { canonicalJson, compareCanonicalStrings } from "./canonical-json.ts";
import {
  assertModulePortablePath,
  ModuleCatalogIndex,
  parseModuleSourcePackManifest,
} from "./module-catalog.ts";
import {
  assertModuleArchiveExactSelector,
  assertModuleArchiveSelectorMatches,
  canonicalSelectorJson,
  exactSelectorDigest,
  moduleArchiveExactSelector,
} from "./providers.ts";
import type {
  ModuleArchiveExactSelector,
  ModuleCatalogEntry,
  ModuleSourcePackManifest,
  StoredFile,
} from "./types.ts";
import { VERSION } from "./version.ts";

export type ModuleMaterializationMode = "template" | "full";
export type ModuleArchiveSource = "source-pack" | "network" | "existing";
export const MODULE_TEMPLATE_LOCK_SCHEMA =
  "figure-library.module-template-lock.v1" as const;

const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 128 * 1024 * 1024;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_FILES = 10_000;
const SHA256 = /^[a-f0-9]{64}$/u;
const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;

function exactObjectKeys(value: Record<string, unknown>, allowed: string[], label: string) {
  const keys = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!keys.has(key)) throw new Error(`${label}.${key} is unsupported`);
  }
}

function assertPublicLicense(value: string, label: string) {
  if (
    !value.trim() ||
    /(?:^|[^A-Za-z0-9])(?:unknown|private_reference|unlicensed)(?:$|[^A-Za-z0-9])/iu.test(
      value,
    )
  ) {
    throw new Error(`${label} does not establish public redistribution rights`);
  }
}

function sha256(value: Uint8Array | string) {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function portableInventory(value: unknown, label: string): StoredFile[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_FILES) {
    throw new Error(`${label} is missing`);
  }
  const result = value.map((item, index) => {
    if (
      !isRecord(item) ||
      typeof item.file !== "string" ||
      !Number.isSafeInteger(item.bytes) ||
      Number(item.bytes) < 0 ||
      Number(item.bytes) > MAX_FILE_BYTES ||
      typeof item.sha256 !== "string" ||
      !SHA256.test(item.sha256)
    ) {
      throw new Error(`${label}[${index}] is invalid`);
    }
    return {
      file: assertModulePortablePath(item.file, `${label}[${index}].file`),
      bytes: Number(item.bytes),
      sha256: item.sha256,
    };
  });
  if (new Set(result.map((item) => item.file)).size !== result.length) {
    throw new Error(`${label} contains duplicate paths`);
  }
  const sorted = [...result].sort((left, right) =>
    compareCanonicalStrings(left.file, right.file),
  );
  if (canonicalJson(result) !== canonicalJson(sorted)) {
    throw new Error(`${label} is not canonically ordered`);
  }
  return result;
}

export function parseModuleTemplateLock(
  value: unknown,
  options: { requireOperation?: boolean } = {},
): Record<string, unknown> & {
  exactSelector: ModuleArchiveExactSelector;
  plannedSelector: ModuleArchiveExactSelector;
  operation?: Record<string, unknown>;
  files: StoredFile[];
} {
  if (!isRecord(value) || value.schema !== MODULE_TEMPLATE_LOCK_SCHEMA) {
    throw new Error("personal module template lock schema is invalid");
  }
  const required = [
    "schema", "providerId", "exactSelector", "plannedSelector", "selectorDigest", "mode",
    "sourceRepository", "sourceCommit", "sourcePath", "archiveRepository", "archiveCommit",
    "archivePath", "archiveSha256", "archiveBytes", "preview", "previewSha256", "licenses",
    "publisher", "codeExecutedBySflClient", "materializationSource", "inventoryPolicy", "files",
  ];
  const optional = ["operation"];
  const allowed = new Set([...required, ...optional]);
  for (const field of required) if (!Object.hasOwn(value, field)) throw new Error(`personal module lock.${field} is required`);
  for (const field of Object.keys(value)) if (!allowed.has(field)) throw new Error(`personal module lock.${field} is unsupported`);
  assertModuleArchiveExactSelector(value.exactSelector);
  assertModuleArchiveExactSelector(value.plannedSelector);
  if (canonicalSelectorJson(value.exactSelector) !== canonicalSelectorJson(value.plannedSelector)) {
    throw new Error("personal module lock exact and planned selectors differ");
  }
  if (value.selectorDigest !== exactSelectorDigest(value.exactSelector)) {
    throw new Error("personal module lock selectorDigest is invalid");
  }
  const selector = value.exactSelector;
  if (value.mode !== "template" && value.mode !== "full") {
    throw new Error("personal module lock mode is invalid");
  }
  if (
    value.providerId !== selector.providerId ||
    value.mode !== selector.identity.mode ||
    value.sourceRepository !== selector.identity.sourceRepository ||
    value.sourceCommit !== selector.identity.sourceCommit ||
    value.sourcePath !== selector.identity.sourcePath ||
    value.archiveRepository !== selector.identity.archive.repository ||
    value.archiveCommit !== selector.identity.archiveCommit ||
    value.archivePath !== selector.identity.archive.path ||
    value.archiveSha256 !== selector.identity.archive.digest ||
    value.archiveBytes !== selector.identity.archive.bytes ||
    value.previewSha256 !== selector.identity.preview.digest ||
    value.codeExecutedBySflClient !== false ||
    !["source-pack", "network", "existing", "intent-recovery"].includes(String(value.materializationSource)) ||
    value.inventoryPolicy !== "all-output-files-except-this-lock"
  ) {
    throw new Error("personal module lock metadata differs from its selector");
  }
  if (!isRecord(value.preview) || canonicalJson(value.preview) !== canonicalJson(selector.identity.preview)) {
    throw new Error("personal module lock preview identity differs from its selector");
  }
  if (!isRecord(value.licenses) ||
    typeof value.licenses.code !== "string" ||
    typeof value.licenses.content !== "string" ||
    typeof value.licenses.documentation !== "string") {
    throw new Error("personal module lock licenses are invalid");
  }
  exactObjectKeys(value.licenses, ["code", "content", "documentation"], "personal module lock.licenses");
  for (const field of ["code", "content", "documentation"]) {
    if (typeof value.licenses[field] !== "string" || !value.licenses[field].trim()) {
      throw new Error(`personal module lock.licenses.${field} is invalid`);
    }
    assertPublicLicense(value.licenses[field], `personal module lock.licenses.${field}`);
  }
  if (!isRecord(value.publisher) || value.publisher.reviewStatus !== "approved") {
    throw new Error("personal module lock publisher state is invalid");
  }
  exactObjectKeys(
    value.publisher,
    value.publisher.evidence === undefined
      ? ["reviewStatus", "executionStatus", "executionScope"]
      : ["reviewStatus", "executionStatus", "executionScope", "evidence"],
    "personal module lock.publisher",
  );
  if (
    !["not_run", "passed", "failed"].includes(String(value.publisher.executionStatus)) ||
    !["synthetic_data", "example_data", "real_data", "unknown"].includes(
      String(value.publisher.executionScope),
    ) ||
    (value.publisher.executionStatus === "passed" && value.publisher.executionScope === "unknown")
  ) {
    throw new Error("personal module lock publisher execution state is invalid");
  }
  if (value.publisher.evidence !== undefined) {
    if (!Array.isArray(value.publisher.evidence)) {
      throw new Error("personal module lock publisher evidence is invalid");
    }
    for (const [index, item] of value.publisher.evidence.entries()) {
      assertModulePortablePath(item, `personal module lock.publisher.evidence[${index}]`);
    }
  }
  const files = portableInventory(value.files, "personal module lock files");
  if (files.some((item) => item.file === "template.lock.json")) {
    throw new Error("personal module lock files must exclude the lock itself");
  }
  if (options.requireOperation !== false) {
    if (!isRecord(value.operation) || typeof value.operation.operationId !== "string" || typeof value.operation.planDigest !== "string") {
      throw new Error("personal module lock operation binding is missing");
    }
  }
  if (value.operation !== undefined) {
    if (!isRecord(value.operation)) throw new Error("personal module lock operation binding is invalid");
    exactObjectKeys(value.operation, ["operationId", "planDigest"], "personal module lock.operation");
    if (!OPERATION_ID.test(String(value.operation.operationId)) || !SHA256.test(String(value.operation.planDigest))) {
      throw new Error("personal module lock operation binding is invalid");
    }
  }
  return {
    ...value,
    exactSelector: value.exactSelector,
    plannedSelector: value.plannedSelector,
    ...(isRecord(value.operation) ? { operation: value.operation } : {}),
    files,
  } as Record<string, unknown> & {
    exactSelector: ModuleArchiveExactSelector;
    plannedSelector: ModuleArchiveExactSelector;
    operation?: Record<string, unknown>;
    files: StoredFile[];
  };
}

function validateOperation(operationId?: string, planDigest?: string) {
  if ((operationId === undefined) !== (planDigest === undefined)) {
    throw new Error("operationId and planDigest must be supplied together");
  }
  if (
    operationId !== undefined &&
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(operationId)
  ) {
    throw new Error("operationId is invalid");
  }
  if (planDigest !== undefined && !SHA256.test(planDigest)) {
    throw new Error("planDigest must be a lowercase SHA-256 digest");
  }
}

interface CentralEntry {
  name: string;
  directory: boolean;
  compressedBytes: number;
  expandedBytes: number;
  crc32: number;
  localHeaderOffset: number;
}

function readUInt16(bytes: Uint8Array, offset: number) {
  if (offset < 0 || offset + 2 > bytes.byteLength) throw new Error("ZIP field is out of bounds");
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function readUInt32(bytes: Uint8Array, offset: number) {
  if (offset < 0 || offset + 4 > bytes.byteLength) throw new Error("ZIP field is out of bounds");
  return (
    (bytes[offset]! |
      (bytes[offset + 1]! << 8) |
      (bytes[offset + 2]! << 16) |
      (bytes[offset + 3]! << 24)) >>>
    0
  );
}

function crc32(value: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of value) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function foldedPath(value: string) {
  return value.normalize("NFC").toLocaleLowerCase("en-US");
}

function hasZipExtraField(bytes: Uint8Array, offset: number, length: number, wanted: number) {
  const end = offset + length;
  let cursor = offset;
  while (cursor < end) {
    if (cursor + 4 > end) throw new Error("module archive extra field is malformed");
    const id = readUInt16(bytes, cursor);
    const size = readUInt16(bytes, cursor + 2);
    cursor += 4;
    if (cursor + size > end) throw new Error("module archive extra field is out of bounds");
    if (id === wanted) return true;
    cursor += size;
  }
  return false;
}

function centralEntries(bytes: Uint8Array): CentralEntry[] {
  if (bytes.byteLength > MAX_ARCHIVE_BYTES) throw new Error("module archive exceeds 100 MiB");
  // ZIP64 is rejected from the structural EOCD sentinel values below. Do not
  // scan arbitrary payload bytes for ZIP64 magic: a perfectly valid source
  // file may contain those four bytes as ordinary data.
  const minimum = Math.max(0, bytes.byteLength - 65_557);
  let eocd = -1;
  for (let offset = bytes.byteLength - 22; offset >= minimum; offset -= 1) {
    if (offset >= 0 && readUInt32(bytes, offset) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new Error("module archive has no ZIP end record");
  const disk = readUInt16(bytes, eocd + 4);
  const centralDisk = readUInt16(bytes, eocd + 6);
  const entriesOnDisk = readUInt16(bytes, eocd + 8);
  const entryCount = readUInt16(bytes, eocd + 10);
  const centralBytes = readUInt32(bytes, eocd + 12);
  const centralOffset = readUInt32(bytes, eocd + 16);
  const commentBytes = readUInt16(bytes, eocd + 20);
  if (
    disk !== 0 ||
    centralDisk !== 0 ||
    entriesOnDisk !== entryCount ||
    entryCount === 0xffff ||
    centralBytes === 0xffffffff ||
    centralOffset === 0xffffffff
  ) {
    throw new Error("module archive uses multi-disk or ZIP64 features");
  }
  if (entryCount > MAX_FILES) throw new Error("module archive contains too many entries");
  if (eocd + 22 + commentBytes !== bytes.byteLength) {
    throw new Error("module archive has trailing or malformed ZIP data");
  }
  if (centralOffset + centralBytes !== eocd) {
    throw new Error("module archive central directory boundaries are invalid");
  }

  const entries: CentralEntry[] = [];
  const seen = new Map<string, { name: string; directory: boolean }>();
  const normalizedSegments = new Map<string, string>();
  const dataRanges: Array<{ start: number; end: number; name: string }> = [];
  let offset = centralOffset;
  let expandedTotal = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > eocd || readUInt32(bytes, offset) !== 0x02014b50) {
      throw new Error("module archive central directory is malformed");
    }
    const madeBy = readUInt16(bytes, offset + 4);
    const flags = readUInt16(bytes, offset + 8);
    const compression = readUInt16(bytes, offset + 10);
    const expectedCrc = readUInt32(bytes, offset + 16);
    const compressedBytes = readUInt32(bytes, offset + 20);
    const expandedBytes = readUInt32(bytes, offset + 24);
    const nameBytes = readUInt16(bytes, offset + 28);
    const extraBytes = readUInt16(bytes, offset + 30);
    const entryCommentBytes = readUInt16(bytes, offset + 32);
    const startingDisk = readUInt16(bytes, offset + 34);
    const externalAttributes = readUInt32(bytes, offset + 38);
    const localHeaderOffset = readUInt32(bytes, offset + 42);
    const end = offset + 46 + nameBytes + extraBytes + entryCommentBytes;
    if (
      end > eocd ||
      expandedBytes === 0xffffffff ||
      compressedBytes === 0xffffffff ||
      localHeaderOffset === 0xffffffff ||
      startingDisk !== 0
    ) {
      throw new Error("module archive entry boundaries or ZIP64 fields are invalid");
    }
    let name: string;
    try {
      name = new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(offset + 46, offset + 46 + nameBytes),
      );
    } catch {
      throw new Error("module archive entry name is not valid UTF-8");
    }
    if (
      !(flags & 0x800) &&
      bytes.subarray(offset + 46, offset + 46 + nameBytes).some((byte) => byte > 0x7f)
    ) {
      throw new Error("non-ASCII module archive names must set the UTF-8 flag");
    }
    const directory = name.endsWith("/");
    const safe = assertModulePortablePath(
      directory ? name.slice(0, -1) : name,
      "module archive entry",
    );
    if (flags & 0x41) throw new Error(`module archive contains an encrypted entry: ${safe}`);
    if (flags & 8) {
      throw new Error(`module archive data descriptors are not supported: ${safe}`);
    }
    if (flags & ~0x808) throw new Error(`module archive uses unsupported ZIP flags: ${safe}`);
    if (compression !== 0 && compression !== 8) {
      throw new Error(`module archive uses unsupported compression: ${safe}`);
    }
    const platform = madeBy >>> 8;
    const unixMode = externalAttributes >>> 16;
    if (platform === 3 && (unixMode & 0xf000) === 0xa000) {
      throw new Error(`module archive contains a symlink: ${safe}`);
    }
    if (
      platform === 3 &&
      (unixMode & 0xf000) !== 0 &&
      (unixMode & 0xf000) !== (directory ? 0x4000 : 0x8000)
    ) {
      throw new Error(`module archive contains a non-regular entry: ${safe}`);
    }
    const folded = foldedPath(safe);
    const prior = seen.get(folded);
    if (prior) throw new Error(`module archive has a normalized path collision: ${safe} / ${prior.name}`);
    const segments = safe.split("/");
    for (let segmentIndex = 1; segmentIndex <= segments.length; segmentIndex += 1) {
      const prefix = segments.slice(0, segmentIndex).join("/");
      const foldedPrefix = foldedPath(prefix);
      const priorPrefix = normalizedSegments.get(foldedPrefix);
      if (priorPrefix !== undefined && priorPrefix !== prefix) {
        throw new Error(`module archive has a case/NFC segment collision: ${prefix} / ${priorPrefix}`);
      }
      const exactPrefix = seen.get(foldedPrefix);
      if (
        exactPrefix &&
        exactPrefix.name === prefix &&
        ((segmentIndex < segments.length && !exactPrefix.directory) ||
          (segmentIndex === segments.length &&
            exactPrefix.directory !== directory))
      ) {
        throw new Error(`module archive mixes a file and directory at the same path: ${prefix}`);
      }
      normalizedSegments.set(foldedPrefix, prefix);
    }
    seen.set(folded, { name: safe, directory });
    if (expandedBytes > MAX_FILE_BYTES) throw new Error(`module archive file is too large: ${safe}`);
    expandedTotal += expandedBytes;
    if (expandedTotal > MAX_EXPANDED_BYTES) throw new Error("module archive expands beyond 128 MiB");
    if (localHeaderOffset + 30 > centralOffset || readUInt32(bytes, localHeaderOffset) !== 0x04034b50) {
      throw new Error(`module archive local header is invalid: ${safe}`);
    }
    const localFlags = readUInt16(bytes, localHeaderOffset + 6);
    const localCompression = readUInt16(bytes, localHeaderOffset + 8);
    const localNameBytes = readUInt16(bytes, localHeaderOffset + 26);
    const localExtraBytes = readUInt16(bytes, localHeaderOffset + 28);
    const dataOffset = localHeaderOffset + 30 + localNameBytes + localExtraBytes;
    if (hasZipExtraField(bytes, offset + 46 + nameBytes, extraBytes, 0x0001)) {
      throw new Error(`module archive entry uses ZIP64 extra fields: ${safe}`);
    }
    if (hasZipExtraField(bytes, localHeaderOffset + 30 + localNameBytes, localExtraBytes, 0x0001)) {
      throw new Error(`module archive local header uses ZIP64 extra fields: ${safe}`);
    }
    if (
      localFlags !== flags ||
      localCompression !== compression ||
      localNameBytes !== nameBytes ||
      localExtraBytes !== extraBytes ||
      dataOffset > centralOffset ||
      dataOffset + compressedBytes > centralOffset ||
      !Buffer.from(bytes.subarray(localHeaderOffset + 30, localHeaderOffset + 30 + localNameBytes)).equals(
        Buffer.from(bytes.subarray(offset + 46, offset + 46 + nameBytes)),
      )
    ) {
      throw new Error(`module archive local/central header mismatch: ${safe}`);
    }
    for (const priorRange of dataRanges) {
      if (
        localHeaderOffset < priorRange.end &&
        dataOffset + compressedBytes > priorRange.start
      ) {
        throw new Error(`module archive data ranges overlap: ${safe} / ${priorRange.name}`);
      }
    }
    dataRanges.push({
      start: localHeaderOffset,
      end: dataOffset + compressedBytes,
      name: safe,
    });
    if (
      readUInt32(bytes, localHeaderOffset + 14) !== expectedCrc ||
      readUInt32(bytes, localHeaderOffset + 18) !== compressedBytes ||
      readUInt32(bytes, localHeaderOffset + 22) !== expandedBytes
    ) {
      throw new Error(`module archive local header sizes differ: ${safe}`);
    }
    entries.push({
      name: safe,
      directory,
      compressedBytes,
      expandedBytes,
      crc32: expectedCrc,
      localHeaderOffset,
    });
    offset = end;
  }
  if (offset !== eocd) throw new Error("module archive central directory has trailing bytes");
  let payloadCursor = 0;
  for (const range of [...dataRanges].sort((left, right) => left.start - right.start)) {
    if (range.start !== payloadCursor) {
      throw new Error(`module archive has hidden or unclaimed payload bytes before ${range.name}`);
    }
    payloadCursor = range.end;
  }
  if (payloadCursor !== centralOffset) {
    throw new Error("module archive has hidden or unclaimed bytes before the central directory");
  }
  return entries;
}

function validateZip(bytes: Uint8Array, module: ModuleCatalogEntry) {
  const central = centralEntries(bytes);
  let contents: Record<string, Uint8Array>;
  try {
    contents = unzipSync(bytes);
  } catch (error) {
    throw new Error(`module archive decompression failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const files = new Map<string, Uint8Array>();
  const impliedDirectories = new Set<string>();
  for (const metadata of central) {
    if (metadata.directory) {
      // Empty/unrelated directory entries are not part of a module's declared
      // file tree. Permit only directory records implied by a declared file;
      // this keeps the archive inventory exact without requiring producers to
      // emit directory records at all.
      continue;
    }
    const parts = metadata.name.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      impliedDirectories.add(`${parts.slice(0, index).join("/")}/`);
    }
    const data = contents[metadata.name];
    if (!data || data.byteLength !== metadata.expandedBytes || crc32(data) !== metadata.crc32) {
      throw new Error(`module archive decompressed data differs: ${metadata.name}`);
    }
    files.set(metadata.name, data);
  }
  for (const metadata of central) {
    if (metadata.directory && !impliedDirectories.has(`${metadata.name}/`)) {
      throw new Error(`module archive contains an undeclared directory: ${metadata.name}`);
    }
  }
  const extracted = Object.keys(contents).filter((name) => !name.endsWith("/"));
  if (extracted.length !== files.size || extracted.some((name) => !files.has(name))) {
    throw new Error("module archive decompressed entry set differs from central directory");
  }
  const expected = [...module.files].sort((left, right) =>
    compareCanonicalStrings(left.path, right.path),
  );
  const actual = [...files.keys()]
    .sort(compareCanonicalStrings)
    .map((file) => ({ path: file, bytes: files.get(file)!.byteLength, sha256: sha256(files.get(file)!) }));
  if (canonicalJson(expected) !== canonicalJson(actual)) {
    throw new Error("module archive file inventory differs from the Catalog");
  }
  return files;
}

/** Exposed for maintainer/security tests; this function only parses and
 * validates bytes and never writes or executes archive contents. */
export function validateModuleArchive(bytes: Uint8Array, module: ModuleCatalogEntry) {
  return validateZip(bytes, module);
}

function verifyArchive(module: ModuleCatalogEntry, bytes: Uint8Array, packEntry?: ModuleSourcePackManifest["entries"][number]) {
  if (bytes.byteLength !== module.archive.bytes) {
    throw new Error(`module archive size mismatch: expected ${module.archive.bytes}, got ${bytes.byteLength}`);
  }
  const actual = sha256(bytes);
  if (actual !== module.archive.sha256) throw new Error("module archive SHA-256 mismatch");
  if (packEntry) {
    if (packEntry.moduleId !== module.moduleId) throw new Error("Source Pack module identity mismatch");
    if (
      packEntry.sourceRepository !== module.source.repository ||
      packEntry.sourceCommit !== module.source.commit ||
      packEntry.archiveRepository !== module.archive.repository ||
      packEntry.archiveCommit !== module.archive.commit ||
      packEntry.file !== module.archive.path ||
      packEntry.bytes !== module.archive.bytes ||
      packEntry.sha256 !== module.archive.sha256
    ) {
      throw new Error("Source Pack archive identity differs from the Catalog");
    }
  }
  validateZip(bytes, module);
  return { sha256: actual };
}

async function readRegularContainedFile(
  root: string,
  relativePath: string,
  label: string,
  maximumBytes = MAX_ARCHIVE_BYTES,
) {
  const safe = assertModulePortablePath(relativePath, label);
  const absoluteRoot = path.resolve(root);
  const rootStat = await fs.lstat(absoluteRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`${label} root is not a regular directory`);
  }
  const target = path.resolve(absoluteRoot, ...safe.split("/"));
  const relative = path.relative(absoluteRoot, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} escapes the Source Pack root`);
  }
  let current = absoluteRoot;
  const parts = safe.split("/");
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) throw new Error(`${label} traverses a symlink`);
    if (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile()) {
      throw new Error(`${label} is not a regular file`);
    }
    if (index === parts.length - 1 && stat.size > maximumBytes) {
      throw new Error(`${label} exceeds its byte limit`);
    }
  }
  return new Uint8Array(await fs.readFile(target));
}

async function sourcePackInventory(root: string) {
  const files: string[] = [];
  const walk = async (directory: string, prefix = ""): Promise<void> => {
    const entries = (await fs.readdir(directory, { withFileTypes: true })).sort((left, right) =>
      compareCanonicalStrings(left.name, right.name),
    );
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      assertModulePortablePath(relative, "Source Pack path");
      const absolute = path.join(directory, entry.name);
      const stat = await fs.lstat(absolute);
      if (stat.isSymbolicLink()) throw new Error(`Source Pack contains a symlink: ${relative}`);
      if (entry.isDirectory()) await walk(absolute, relative);
      else if (entry.isFile()) files.push(relative);
      else throw new Error(`Source Pack contains a non-regular entry: ${relative}`);
    }
  };
  await walk(root);
  return files;
}

async function assertSourcePackInventory(
  root: string,
  manifest: ModuleSourcePackManifest,
) {
  const expected = new Set([
    "module-source-pack.manifest.json",
    ...manifest.entries.map((entry) => entry.file),
  ]);
  const actual = await sourcePackInventory(root);
  const unexpected = actual.filter((file) => !expected.has(file));
  const missing = [...expected].filter((file) => !actual.includes(file));
  if (unexpected.length || missing.length) {
    throw new Error(
      `Source Pack inventory differs: missing=${missing.join(",")} unexpected=${unexpected.join(",")}`,
    );
  }
}

export async function readModuleSourcePackArchive(
  index: ModuleCatalogIndex,
  directory: string,
  module: ModuleCatalogEntry,
) {
  const root = path.resolve(directory);
  const raw = await readRegularContainedFile(
    root,
    "module-source-pack.manifest.json",
    "Source Pack manifest",
    16 * 1024 * 1024,
  );
  const manifest = parseModuleSourcePackManifest(
    JSON.parse(Buffer.from(raw).toString("utf8")) as unknown,
    index.catalog,
  );
  await assertSourcePackInventory(root, manifest);
  const entry = manifest.entries.find((item) => item.moduleId === module.moduleId);
  if (!entry) throw new Error(`Source Pack does not list ${module.moduleId}`);
  const bytes = await readRegularContainedFile(
    root,
    entry.file,
    "Source Pack archive",
    MAX_ARCHIVE_BYTES,
  );
  const identity = verifyArchive(module, bytes, entry);
  return {
    bytes,
    location: path.join(root, ...entry.file.split("/")),
    source: "source-pack" as const,
    identity,
  };
}

export function moduleArchiveUrl(module: ModuleCatalogEntry) {
  const [owner, repository] = module.archive.repository.split("/");
  if (!owner || !repository) throw new Error("module archive repository is invalid");
  const encodedPath = module.archive.path.split("/").map((part) => encodeURIComponent(part)).join("/");
  return `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/${module.archive.commit}/${encodedPath}`;
}

async function download(url: string) {
  let response: Response;
  try {
    response = await fetch(url, {
      // raw.githubusercontent.com currently serves exact object bytes directly.
      // Rejecting redirects prevents the pinned Catalog URL from becoming an
      // authority hand-off to another host.
      redirect: "error",
      signal: AbortSignal.timeout(60_000),
      headers: { "user-agent": `Scientific-Figure-Library/${VERSION}` },
    });
  } catch (error) {
    throw new Error(`network request failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const finalUrl = new URL(response.url || url);
  const requestedUrl = new URL(url);
  if (
    finalUrl.protocol !== "https:" ||
    finalUrl.hostname !== "raw.githubusercontent.com" ||
    finalUrl.username ||
    finalUrl.password ||
    finalUrl.hash
  ) {
    throw new Error("download response left the fixed GitHub raw origin");
  }
  if (finalUrl.href !== requestedUrl.href) {
    throw new Error("download response URL differs from the fixed archive URL");
  }
  if (!response.ok || !response.body) throw new Error(`download failed (${response.status} ${response.statusText})`);
  const contentLength = response.headers.get("content-length");
  const declared = contentLength === null ? undefined : Number(contentLength);
  if (
    declared !== undefined &&
    (!Number.isSafeInteger(declared) || declared < 0)
  ) {
    throw new Error("download response has an invalid content-length");
  }
  if (declared !== undefined && declared > MAX_ARCHIVE_BYTES) {
    throw new Error("downloaded archive exceeds 100 MiB");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_ARCHIVE_BYTES) {
      await reader.cancel();
      throw new Error("downloaded archive exceeds 100 MiB");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  if (declared !== undefined && declared !== size) {
    throw new Error(`download response length differs from content-length: expected ${declared}, got ${size}`);
  }
  return bytes;
}

export async function inspectModuleSourcePack(
  index: ModuleCatalogIndex,
  directory?: string,
) {
  const expectedCount = index.catalog.modules.length;
  if (!directory) {
    return {
      configured: false,
      directory: "",
      manifestValid: false,
      ready: false,
      availableTemplates: [] as string[],
      invalidTemplates: [] as string[],
      missingCount: expectedCount,
      availableBytes: 0,
      archiveCommits: [...new Set(index.catalog.modules.map((module) => module.archive.commit))].sort(),
    };
  }
  const root = path.resolve(directory);
  let manifest: ModuleSourcePackManifest;
  try {
    const raw = await readRegularContainedFile(
      root,
      "module-source-pack.manifest.json",
      "Source Pack manifest",
      16 * 1024 * 1024,
    );
    manifest = parseModuleSourcePackManifest(
      JSON.parse(Buffer.from(raw).toString("utf8")) as unknown,
      index.catalog,
    );
    await assertSourcePackInventory(root, manifest);
  } catch (error) {
    return {
      configured: true,
      directory: root,
      manifestValid: false,
      ready: false,
      reason: error instanceof Error ? error.message : String(error),
      availableTemplates: [] as string[],
      invalidTemplates: [] as string[],
      missingCount: expectedCount,
      availableBytes: 0,
      archiveCommits: [...new Set(index.catalog.modules.map((module) => module.archive.commit))].sort(),
    };
  }
  const availableTemplates: string[] = [];
  const invalidTemplates: string[] = [];
  let availableBytes = 0;
  for (const item of manifest.entries) {
    const module = index.get(item.moduleId);
    if (!module) {
      invalidTemplates.push(item.moduleId);
      continue;
    }
    try {
      const acquired = await readModuleSourcePackArchive(index, directory, module);
      availableTemplates.push(module.moduleId);
      availableBytes += acquired.bytes.byteLength;
    } catch {
      invalidTemplates.push(module.moduleId);
    }
  }
  return {
    configured: true,
    directory: path.resolve(directory),
    manifestValid: true,
    ready: invalidTemplates.length === 0,
    availableTemplates: availableTemplates.sort(),
    invalidTemplates: invalidTemplates.sort(),
    missingCount: expectedCount - availableTemplates.length - invalidTemplates.length,
    availableBytes,
    archiveCommits: [...new Set(manifest.entries.map((item) => item.archiveCommit))].sort(),
  };
}

async function acquireArchive(options: {
  index: ModuleCatalogIndex;
  module: ModuleCatalogEntry;
  sourcePackDir?: string;
  allowNetwork: boolean;
}) {
  const failures: string[] = [];
  if (options.sourcePackDir) {
    try {
      return await readModuleSourcePackArchive(options.index, options.sourcePackDir, options.module);
    } catch (error) {
      throw new Error(
        `personal module Source Pack rejected: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  if (options.allowNetwork) {
    const url = moduleArchiveUrl(options.module);
    try {
      const bytes = await download(url);
      const identity = verifyArchive(options.module, bytes);
      return { bytes, location: url, source: "network" as const, identity };
    } catch (error) {
      failures.push(`${url}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(
    `personal module archive unavailable. ${failures.join(" | ") || "network access is disabled"}. Provide a validated module Source Pack or allow the fixed commit download.`,
  );
}

function assetBucket(file: string): "visuals" | "code" | "references" {
  const extension = path.posix.extname(file).toLocaleLowerCase("en-US");
  if ([".r", ".rmd", ".qmd", ".py", ".ipynb", ".jl", ".m", ".sh"].includes(extension)) return "code";
  if ([".png", ".jpg", ".jpeg", ".webp", ".svg", ".tif", ".tiff"].includes(extension)) return "visuals";
  return "references";
}

async function storedFile(root: string, relative: string): Promise<StoredFile> {
  const safe = assertModulePortablePath(relative, "materialized file");
  const absoluteRoot = path.resolve(root);
  const target = path.resolve(absoluteRoot, ...safe.split("/"));
  const outside = path.relative(absoluteRoot, target);
  if (!outside || outside.startsWith("..") || path.isAbsolute(outside)) {
    throw new Error(`materialized file escapes its root: ${relative}`);
  }
  let current = absoluteRoot;
  const parts = safe.split("/");
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) throw new Error(`materialized file traverses a symlink: ${relative}`);
    if (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile()) {
      throw new Error(`materialized file is not regular: ${relative}`);
    }
  }
  const bytes = new Uint8Array(await fs.readFile(target));
  return { file: relative, bytes: bytes.byteLength, sha256: sha256(bytes) };
}

async function inventory(root: string, files: string[]): Promise<StoredFile[]> {
  return Promise.all([...new Set(files)].sort().map((file) => storedFile(root, file)));
}

async function completeInventory(root: string): Promise<StoredFile[]> {
  const output: StoredFile[] = [];
  const walk = async (directory: string, prefix = "") => {
    const entries = (await fs.readdir(directory, { withFileTypes: true })).sort((left, right) =>
      compareCanonicalStrings(left.name, right.name),
    );
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      assertModulePortablePath(relative, "materialized output path");
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`materialized output contains a symlink: ${relative}`);
      if (entry.isDirectory()) await walk(absolute, relative);
      else if (entry.isFile()) output.push(await storedFile(root, relative));
      else throw new Error(`materialized output contains a non-regular entry: ${relative}`);
    }
  };
  await walk(path.resolve(root));
  return output.sort((left, right) => compareCanonicalStrings(left.file, right.file));
}

async function commitStagingWithoutReplacement(staging: string, target: string) {
  // The supported production host is Windows. Its directory rename is
  // non-replacing, so the fully validated staging tree can become visible in
  // one atomic operation. This is important: creating the target first and
  // moving its children one by one exposes a partial materialization and can
  // leave an unrecoverable target after a crash.
  if (process.platform === "win32") {
    await fs.rename(staging, target);
    return;
  }

  // Node does not expose renameat2(RENAME_NOREPLACE), and POSIX rename can
  // replace an empty directory. Keep the conservative no-overwrite fallback
  // for non-Windows development/CI hosts. The normal SFL path also holds the
  // cross-runtime writer lock, so cooperating writers cannot interleave here.
  // A crash before receipt finalization leaves the intent/partial target for
  // the existing fail-closed recovery path.
  let reserved = false;
  await fs.mkdir(target);
  reserved = true;
  let committed = false;
  try {
    const entries = (await fs.readdir(staging, { withFileTypes: true })).sort((left, right) =>
      compareCanonicalStrings(left.name, right.name),
    );
    for (const entry of entries) {
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
        throw new Error(`materialization staging contains a non-regular entry: ${entry.name}`);
      }
      await fs.rename(
        path.join(staging, entry.name),
        path.join(target, entry.name),
      );
    }
    committed = true;
    await fs.rm(staging, { recursive: true, force: true });
  } catch (error) {
    if (reserved && !committed) {
      await fs.rm(target, { recursive: true, force: true }).catch(() => undefined);
    }
    throw error;
  }
}

function assertStoredInventory(value: unknown, label: string): StoredFile[] {
  if (!Array.isArray(value) || !value.length) throw new Error(`${label} is missing`);
  const result = value.map((item, index) => {
    if (
      !isRecord(item) ||
      typeof item.file !== "string" ||
      !Number.isSafeInteger(item.bytes) ||
      Number(item.bytes) < 0 ||
      typeof item.sha256 !== "string" ||
      !SHA256.test(item.sha256)
    ) {
      throw new Error(`${label}[${index}] is invalid`);
    }
    return {
      file: assertModulePortablePath(item.file, `${label}[${index}].file`),
      bytes: Number(item.bytes),
      sha256: item.sha256,
    };
  });
  const sorted = [...result].sort((left, right) => compareCanonicalStrings(left.file, right.file));
  if (new Set(result.map((item) => item.file)).size !== result.length) {
    throw new Error(`${label} contains duplicate paths`);
  }
  if (JSON.stringify(result) !== JSON.stringify(sorted)) {
    throw new Error(`${label} is not canonically ordered`);
  }
  return result;
}

async function extractModuleArchive(
  bytes: Uint8Array,
  module: ModuleCatalogEntry,
  destination: string,
  mode: ModuleMaterializationMode,
) {
  const files = validateZip(bytes, module);
  const selected = new Set(mode === "full" ? module.files.map((file) => file.path) : module.requiredFiles);
  const written: string[] = [];
  for (const file of [...selected].sort()) {
    const data = files.get(file);
    if (!data) throw new Error(`required module file is missing from archive: ${file}`);
    const output = path.join(destination, "upstream", ...file.split("/"));
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, data, { flag: "wx" });
    written.push(path.posix.join("upstream", file));
  }
  if (!written.length) throw new Error("module archive contains no selected files");
  return written.sort();
}

async function createNormalizedAssets(root: string, upstreamFiles: string[]) {
  for (const bucket of ["visuals", "code", "references", "evidence"]) {
    await fs.mkdir(path.join(root, "assets", bucket), { recursive: true });
  }
  const assets: Record<"visuals" | "code" | "references" | "evidence", string[]> = {
    visuals: [],
    code: [],
    references: [],
    evidence: [],
  };
  for (const upstreamFile of upstreamFiles) {
    const relative = upstreamFile.replace(/^upstream\//u, "");
    const bucket = assetBucket(relative);
    const targetRelative = path.posix.join("assets", bucket, relative);
    const target = path.join(root, ...targetRelative.split("/"));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(path.join(root, ...upstreamFile.split("/")), target);
    assets[bucket].push(targetRelative);
  }
  return assets;
}

function templateMarkdown(module: ModuleCatalogEntry, selector: ModuleArchiveExactSelector) {
  return `# ${module.title}\n\nThis materialization contains a commit-pinned personal figure module and a normalized Scientific Figure Library asset envelope. SFL does not execute the module code.\n\n## Purpose\n\n${module.description}\n\n## Expected inputs\n\n${module.dataProfile}\n\n## Review and execution state\n\n- Publisher review status: ${module.publisher.reviewStatus}.\n- Publisher execution status: ${module.publisher.executionStatus} (${module.publisher.executionScope}).\n- Local SFL review status: not_reviewed.\n- Local SFL execution status: not_run.\n- codeExecutedBySflClient: false.\n\n## Portable provenance\n\n- Provider: \`${selector.providerId}\`\n- Module: \`${module.moduleId}\`\n- Source repository: \`${module.source.repository}\`\n- Source commit: \`${module.source.commit}\`\n- Archive repository: \`${module.archive.repository}\`\n- Archive commit: \`${module.archive.commit}\`\n- Archive SHA-256: \`${selector.identity.archive.digest}\`\n- Materialization mode: \`${selector.identity.mode}\`\n- Code license: ${module.licenses.code}\n- Content license: ${module.licenses.content}\n- Documentation license: ${module.licenses.documentation}\n`;
}

async function verifyExistingModuleMaterialization(options: {
  target: string;
  plannedSelector: ModuleArchiveExactSelector;
  operationId: string;
  planDigest: string;
}) {
  const lockPath = path.join(options.target, "template.lock.json");
  const lock = JSON.parse(await fs.readFile(lockPath, "utf8")) as unknown;
  const parsed = parseModuleTemplateLock(lock);
  if (
    canonicalSelectorJson(parsed.plannedSelector as unknown as ModuleArchiveExactSelector) !==
    canonicalSelectorJson(options.plannedSelector)
  ) {
    throw new Error("existing personal module lock selector differs from the plan");
  }
  if (
    !isRecord(parsed.operation) ||
    parsed.operation.operationId !== options.operationId ||
    parsed.operation.planDigest !== options.planDigest
  ) {
    throw new Error(`target exists with a different personal module operation: ${options.target}`);
  }
  const files = parsed.files;
  const actualPayload = await completeInventory(options.target);
  const actualWithoutLock = actualPayload.filter((item) => item.file !== "template.lock.json");
  if (JSON.stringify(actualWithoutLock) !== JSON.stringify(files)) {
    throw new Error("personal module replay inventory differs from its lock");
  }
  const lockFile = await storedFile(options.target, "template.lock.json");
  return {
    target: options.target,
    providerId: options.plannedSelector.providerId,
    exactSelector: parsed.exactSelector,
    plannedSelector: options.plannedSelector,
    archiveSource: "existing" as const,
    archiveLocation: undefined,
    sha256: options.plannedSelector.identity.archive.digest,
    files: [...files, lockFile].sort((left, right) => compareCanonicalStrings(left.file, right.file)).map((item) => item.file),
    fileInventory: [...files, lockFile].sort((left, right) => compareCanonicalStrings(left.file, right.file)),
    replayed: true,
  };
}

export async function materializeModuleTemplate(options: {
  providerId: string;
  index: ModuleCatalogIndex;
  module: ModuleCatalogEntry;
  destination: string;
  mode: ModuleMaterializationMode;
  exactSelector?: ModuleArchiveExactSelector;
  operationId?: string;
  planDigest?: string;
  sourcePackDir?: string;
  allowNetwork?: boolean;
}) {
  const { index, module, mode } = options;
  const providerId = options.providerId;
  if (providerId !== index.catalog.provider.providerId) {
    throw new Error("module materializer providerId differs from its Catalog");
  }
  const catalogModule = index.get(module.moduleId);
  if (!catalogModule || canonicalJson(catalogModule) !== canonicalJson(module)) {
    throw new Error("module materializer module differs from the loaded Catalog");
  }
  validateOperation(options.operationId, options.planDigest);
  if (mode !== "template" && mode !== "full") throw new Error(`unsupported materialization mode: ${mode}`);
  const plannedSelector = moduleArchiveExactSelector(
    providerId,
    module,
    index.catalogSha256,
    mode,
  );
  if (options.exactSelector) {
    assertModuleArchiveSelectorMatches(
      options.exactSelector,
      providerId,
      module,
      index.catalogSha256,
    );
    if (options.exactSelector.identity.mode !== mode) {
      throw new Error("module selector mode differs from the requested materialization mode");
    }
  }
  const parent = path.resolve(options.destination);
  const target = path.join(parent, module.moduleId);
  let targetExists = false;
  try {
    const stat = await fs.lstat(target);
    targetExists = true;
    if (stat.isSymbolicLink()) throw new Error(`target is a symbolic link: ${target}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (targetExists) {
    if (options.operationId && options.planDigest) {
      return verifyExistingModuleMaterialization({
        target,
        plannedSelector,
        operationId: options.operationId,
        planDigest: options.planDigest,
      });
    }
    throw new Error(`target already exists: ${target}`);
  }
  await fs.mkdir(parent, { recursive: true });
  const staging = path.join(parent, `.figure-library-personal-${module.moduleId}-${randomUUID()}`);
  await fs.mkdir(staging);
  try {
    const acquired = await acquireArchive({
      index,
      module,
      sourcePackDir: options.sourcePackDir,
      allowNetwork: options.allowNetwork ?? true,
    });
    const upstreamFiles = await extractModuleArchive(acquired.bytes, module, staging, mode);
    const assets = await createNormalizedAssets(staging, upstreamFiles);
    const exactSelector = plannedSelector;
    await fs.writeFile(path.join(staging, "TEMPLATE.md"), templateMarkdown(module, exactSelector), { flag: "wx" });
    const assetInventory = {
      visuals: await inventory(staging, assets.visuals),
      code: await inventory(staging, assets.code),
      references: await inventory(staging, assets.references),
      evidence: [] as StoredFile[],
    };
    const template = {
      schema: "figure-library.materialized-module.v1",
      providerId,
      exactSelector,
      templateId: module.moduleId,
      title: module.title,
      titleEn: module.titleEn,
      description: module.description,
      application: module.application,
      dataProfile: module.dataProfile,
      language: module.language,
      review: {
        publisherReviewStatus: module.publisher.reviewStatus,
        publisherExecutionStatus: module.publisher.executionStatus,
        publisherExecutionScope: module.publisher.executionScope,
        localReviewStatus: "not_reviewed",
        executionStatus: "not_run",
        codeExecutedBySflClient: false,
      },
      assets: assetInventory,
      upstream: {
        sourceRepository: module.source.repository,
        sourceCommit: module.source.commit,
        archiveRepository: module.archive.repository,
        archiveCommit: module.archive.commit,
        files: await inventory(staging, upstreamFiles),
      },
      licenses: module.licenses,
    };
    await fs.writeFile(path.join(staging, "template.json"), `${JSON.stringify(template, null, 2)}\n`, { flag: "wx" });
    const payloadFiles = await inventory(staging, [
      "TEMPLATE.md",
      "template.json",
      ...upstreamFiles,
      ...assets.visuals,
      ...assets.code,
      ...assets.references,
      ...assets.evidence,
    ]);
    const lock = {
      schema: "figure-library.module-template-lock.v1",
      providerId,
      exactSelector,
      plannedSelector,
      selectorDigest: exactSelectorDigest(exactSelector),
      mode,
      sourceRepository: module.source.repository,
      sourceCommit: module.source.commit,
      sourcePath: module.source.path,
      archiveRepository: module.archive.repository,
      archiveCommit: module.archive.commit,
      archivePath: module.archive.path,
      archiveSha256: acquired.identity.sha256,
      archiveBytes: acquired.bytes.byteLength,
      preview: exactSelector.identity.preview,
      previewSha256: module.preview.sha256,
      licenses: module.licenses,
      publisher: module.publisher,
      codeExecutedBySflClient: false,
      materializationSource: acquired.source,
      inventoryPolicy: "all-output-files-except-this-lock",
      operation:
        options.operationId && options.planDigest
          ? { operationId: options.operationId, planDigest: options.planDigest }
          : undefined,
      files: payloadFiles,
    };
    await fs.writeFile(path.join(staging, "template.lock.json"), `${JSON.stringify(lock, null, 2)}\n`, { flag: "wx" });
    const fileInventory = [
      ...payloadFiles,
      await storedFile(staging, "template.lock.json"),
    ].sort((left, right) => compareCanonicalStrings(left.file, right.file));
    // On Windows rename is non-replacing, while POSIX rename would replace an
    // intervening directory. Recheck immediately before the commit point and
    // refuse the operation if another writer won the target name.
    try {
      await fs.lstat(target);
      throw new Error(`target already exists: ${target}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await commitStagingWithoutReplacement(staging, target);
    return {
      target,
      providerId,
      exactSelector,
      plannedSelector,
      archiveSource: acquired.source,
      archiveLocation: acquired.location,
      sha256: acquired.identity.sha256,
      files: fileInventory.map((file) => file.file),
      fileInventory,
      replayed: false,
    };
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true });
    throw error;
  }
}
