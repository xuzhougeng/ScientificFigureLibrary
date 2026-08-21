#!/usr/bin/env node

import { execFile as execFileCallback } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import { parsePublicProviderCatalog } from "../src/public-catalog-provider.ts";
import { STRICT_SEMVER } from "../src/semver.ts";

const execFile = promisify(execFileCallback);
const root = path.resolve(import.meta.dirname, "..");
const PROVIDER_ID = "io.github.jarxunlai.scientific-figure-community";
const CATALOG_REPOSITORY = "jarxunlai/ScientificFigureLibrary-community";
const CATALOG_REPOSITORY_HTTPS = "https://github.com/jarxunlai/ScientificFigureLibrary-community.git";
const ARCHIVE_REPOSITORY = "jarxunlai/ScientificFigureLibrary-community-archives";
const HASH = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const TEMPLATE_ID = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/u;
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
const MAX_CATALOG_BYTES = 16 * 1024 * 1024;
const MAX_PREVIEW_PACK_BYTES = 64 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
const MAX_LICENSE_BYTES = 1024 * 1024;
const MAX_GIT_TEXT_BYTES = 64 * 1024 * 1024;

function argument(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertExactKeys(value, required, optional, label) {
  assert(isRecord(value), `${label} must be an object`);
  const allowed = new Set([...required, ...optional]);
  for (const key of required) assert(Object.hasOwn(value, key), `${label} is missing ${key}`);
  for (const key of Object.keys(value)) assert(allowed.has(key), `${label} has unknown field ${key}`);
}

function nonEmptyString(value, label, maximum = 4_000) {
  assert(
    typeof value === "string" && Boolean(value.trim()) && value.length <= maximum,
    `${label} must be a non-empty string no longer than ${maximum}`,
  );
  return value;
}

function boundedString(value, label, maximum) {
  assert(
    typeof value === "string" && value.length <= maximum,
    `${label} must be a string no longer than ${maximum}`,
  );
  return value;
}

function assertStringArray(value, label, maximumEntries = 10_000, maximumString = 1_000) {
  assert(
    Array.isArray(value) && value.length <= maximumEntries,
    `${label} must be an array with at most ${maximumEntries} entries`,
  );
  const strings = value.map((item, index) =>
    nonEmptyString(item, `${label}[${index}]`, maximumString));
  assert(new Set(strings).size === strings.length, `${label} contains duplicates`);
  return strings;
}

function assertRfc3339(value, label) {
  const text = nonEmptyString(value, label, 100);
  assert(
    /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/u.test(text) &&
      !Number.isNaN(Date.parse(text)),
    `${label} must be an RFC 3339 date-time`,
  );
  return text;
}

function positiveInteger(value, label, maximum) {
  assert(
    Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= maximum,
    `${label} must be a positive safe integer no larger than ${maximum}`,
  );
  return Number(value);
}

function assertPortableRelativePath(value, label) {
  assert(typeof value === "string" && value.length > 0, `${label} must be a path`);
  assert(!value.includes("\\") && !value.startsWith("/") && !/^[A-Za-z]:/u.test(value) && value.normalize("NFC") === value, `${label} is absolute, non-normalized, or platform-specific`);
  assert(path.posix.normalize(value) === value, `${label} is not canonical`);
  assert(
    !value.split("/").some((segment) =>
      !segment || segment === "." || segment === ".." || segment.endsWith(".") || segment.endsWith(" ") || WINDOWS_RESERVED.test(segment)),
    `${label} contains an unsafe or non-portable segment`,
  );
  assert(!/[\u0000-\u001f\u007f-\u009f<>:"|?*]/u.test(value), `${label} contains a forbidden character`);
  return value;
}

function licenseTextPath(value, label) {
  const identifier = nonEmptyString(value, label, 100);
  assert(!identifier.includes("/"), `${label} must be one portable license identifier`);
  return assertPortableRelativePath(`LICENSES/${identifier}.txt`, `${label} license text path`);
}

function parseJsonBytes(bytes, maximum, label) {
  assert(bytes.byteLength > 0 && bytes.byteLength <= maximum, `${label} has an invalid byte length`);
  assert(!(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf), `${label} must not have a UTF-8 BOM`);
  let value;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new Error(`${label} is not strict UTF-8 JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { bytes, value };
}

async function walkRegularFiles(directory, prefix) {
  const rootStat = await fs.lstat(directory);
  assert(rootStat.isDirectory() && !rootStat.isSymbolicLink(), `${prefix} must be a regular directory`);
  const output = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`source snapshot contains a symlink: ${relative}`);
    if (entry.isDirectory()) output.push(...(await walkRegularFiles(absolute, relative)));
    else if (entry.isFile()) output.push({ absolute, relative: assertPortableRelativePath(relative, relative) });
    else throw new Error(`source snapshot contains a non-file: ${relative}`);
  }
  return output.sort((left, right) => left.relative.localeCompare(right.relative, "en"));
}

async function git(source, args, runner = execFile) {
  const { stdout } = await runner("git", ["-C", source, ...args], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: MAX_GIT_TEXT_BYTES,
  });
  return stdout;
}

async function gitBytes(source, args, maximum, runner = execFile) {
  const { stdout } = await runner("git", ["-C", source, ...args], {
    encoding: null,
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: maximum + 1024,
  });
  const bytes = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
  assert(bytes.byteLength <= maximum, `git returned more than ${maximum} bytes`);
  return new Uint8Array(bytes);
}

function isolatedGitEnvironment() {
  const environment = { ...process.env };
  // The provenance fetch must not inherit URL rewrites, alternate object stores,
  // repository discovery, or credential-interactive behavior from the caller.
  for (const key of Object.keys(environment)) {
    if (key.startsWith("GIT_")) delete environment[key];
  }
  environment.GIT_CONFIG_NOSYSTEM = "1";
  environment.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";
  environment.GIT_TERMINAL_PROMPT = "0";
  return environment;
}

async function runIsolatedGit(repository, args, runner, encoding = "utf8", maximum = MAX_GIT_TEXT_BYTES) {
  const { stdout } = await runner(
    "git",
    [
      "-c",
      "protocol.allow=never",
      "-c",
      "protocol.https.allow=always",
      "-C",
      repository,
      ...args,
    ],
    {
      encoding,
      windowsHide: true,
      timeout: 60_000,
      maxBuffer: maximum + (encoding === null ? 1024 : 0),
      env: isolatedGitEnvironment(),
    },
  );
  return stdout;
}

async function fetchCentralMainSnapshot(expectedCommit, runner) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-community-origin-"));
  let primaryError;
  try {
    await runner("git", ["init", "--bare", temporary], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 30_000,
      maxBuffer: MAX_GIT_TEXT_BYTES,
      env: isolatedGitEnvironment(),
    });
    const fetchedRef = "refs/sfl-community-sync/fresh-main";
    await runIsolatedGit(
      temporary,
      [
        "fetch",
        "--no-tags",
        "--force",
        "--depth=1",
        CATALOG_REPOSITORY_HTTPS,
        `refs/heads/main:${fetchedRef}`,
      ],
      runner,
    );
    const fetched = (await runIsolatedGit(
      temporary,
      ["rev-parse", "--verify", `${fetchedRef}^{commit}`],
      runner,
    )).trim().toLocaleLowerCase("en-US");
    assert(COMMIT.test(fetched), "freshly fetched central main did not resolve to an exact commit");
    assert(
      fetched === expectedCommit,
      `Community sync commit ${expectedCommit} is not the freshly fetched central main ${fetched}`,
    );
    const inventoryOutput = await runIsolatedGit(
      temporary,
      ["ls-tree", "-r", "-z", "--full-tree", fetched, "--", "catalog", "thumbs", "LICENSES"],
      runner,
    );
    const inventory = new Map();
    for (const record of inventoryOutput.split("\0")) {
      if (!record) continue;
      const match = /^([0-9]{6}) ([^ ]+) ([a-f0-9]+)\t([\s\S]+)$/u.exec(record);
      assert(match, "freshly fetched central main returned malformed tracked inventory");
      const [, mode, type, objectId, rawPath] = match;
      const relative = assertPortableRelativePath(rawPath, "freshly fetched Community tracked path");
      assert(type === "blob" && (mode === "100644" || mode === "100755"), `freshly fetched central main contains a non-regular input: ${relative}`);
      assert(!inventory.has(relative), `freshly fetched central main contains a duplicate path: ${relative}`);
      inventory.set(relative, { objectId, mode });
    }
    async function read(relative, maximum) {
      const tracked = inventory.get(relative);
      assert(tracked, `freshly fetched central main does not track ${relative}`);
      const stdout = await runIsolatedGit(
        temporary,
        ["show", `${fetched}:${relative}`],
        runner,
        null,
        maximum,
      );
      const bytes = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
      assert(bytes.byteLength <= maximum, `freshly fetched ${relative} exceeds ${maximum} bytes`);
      return new Uint8Array(bytes);
    }
    const criticalBytes = new Map();
    for (const relative of ["catalog/catalog.json", "catalog/preview-manifest.json"]) {
      criticalBytes.set(relative, await read(relative, MAX_CATALOG_BYTES));
    }
    return { commit: fetched, inventory, criticalBytes };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      await fs.rm(temporary, { recursive: true, force: true });
    } catch (cleanupError) {
      if (primaryError) {
        throw new AggregateError(
          [primaryError, cleanupError],
          `central provenance fetch failed and its temporary repository could not be removed: ${temporary}`,
          { cause: primaryError },
        );
      }
      throw cleanupError;
    }
  }
}

async function assertCommitMatchesFetchedCentral(source, commit, localInventory, runner) {
  const fetched = await fetchCentralMainSnapshot(commit, runner);
  const localPaths = [...localInventory.keys()].sort();
  const fetchedPaths = [...fetched.inventory.keys()].sort();
  assert(
    canonical(localPaths) === canonical(fetchedPaths),
    "Community checkout inventory differs from the freshly fetched central main",
  );
  for (const relative of localPaths) {
    const local = localInventory.get(relative);
    const remote = fetched.inventory.get(relative);
    assert(
      local.mode === remote.mode && local.objectId === remote.objectId,
      `Community checkout object differs from the freshly fetched central main: ${relative}`,
    );
  }
  // Bind the most security-sensitive aggregate metadata bytes independently of
  // Git object identifiers, so a malicious local object database cannot assert
  // a chosen hash without also matching the bytes obtained from central HTTPS.
  for (const relative of ["catalog/catalog.json", "catalog/preview-manifest.json"]) {
    const maximum = MAX_CATALOG_BYTES;
    const centralBytes = fetched.criticalBytes.get(relative);
    assert(centralBytes, `freshly fetched central main did not retain ${relative}`);
    const localBytes = await gitBytes(source, ["show", `${commit}:${relative}`], maximum, runner);
    assert(
      Buffer.from(localBytes).equals(Buffer.from(centralBytes)),
      `Community checkout bytes differ from the freshly fetched central main: ${relative}`,
    );
  }
}

async function loadCommitInventory(source, commit, runner) {
  const output = await git(
    source,
    ["ls-tree", "-r", "-z", "--full-tree", commit, "--", "catalog", "thumbs", "LICENSES"],
    runner,
  );
  const inventory = new Map();
  for (const record of output.split("\0")) {
    if (!record) continue;
    const match = /^([0-9]{6}) ([^ ]+) ([a-f0-9]+)\t([\s\S]+)$/u.exec(record);
    assert(match, "Community commit returned malformed tracked inventory");
    const [, mode, type, objectId, rawPath] = match;
    const relative = assertPortableRelativePath(rawPath, "Community tracked path");
    assert(type === "blob" && (mode === "100644" || mode === "100755"), `Community commit contains a non-regular tracked input: ${relative}`);
    assert(!inventory.has(relative), `Community commit contains a duplicate tracked path: ${relative}`);
    inventory.set(relative, { objectId, mode });
  }
  const indexedOutput = await git(
    source,
    ["ls-files", "-z", "--", "catalog", "thumbs", "LICENSES"],
    runner,
  );
  const indexed = new Set(indexedOutput.split("\0").filter(Boolean).map((relative) =>
    assertPortableRelativePath(relative, "Community indexed path")));
  const absentFromIndex = [...inventory.keys()].filter((relative) => !indexed.has(relative)).sort();
  const absentFromCommit = [...indexed].filter((relative) => !inventory.has(relative)).sort();
  assert(
    absentFromIndex.length === 0 && absentFromCommit.length === 0,
    `Community index differs from the exact commit: missing=${absentFromIndex.join(",")} extra=${absentFromCommit.join(",")}`,
  );
  return inventory;
}

async function assertWorktreeInventoryMatches(source, inventory) {
  const actual = [
    ...(await walkRegularFiles(path.join(source, "catalog"), "catalog")),
    ...(await walkRegularFiles(path.join(source, "thumbs"), "thumbs")),
    ...(await walkRegularFiles(path.join(source, "LICENSES"), "LICENSES")),
  ];
  const actualPaths = new Set(actual.map((file) => file.relative));
  const extras = [...actualPaths].filter((relative) => !inventory.has(relative)).sort();
  const missing = [...inventory.keys()].filter((relative) => !actualPaths.has(relative)).sort();
  assert(extras.length === 0, `Community checkout contains ignored or untracked vendored input: ${extras.join(", ")}`);
  assert(missing.length === 0, `Community checkout is missing tracked vendored input: ${missing.join(", ")}`);
}

async function readTrackedBytes(source, commit, inventory, relative, maximum, label, runner) {
  const safe = assertPortableRelativePath(relative, label);
  const tracked = inventory.get(safe);
  assert(tracked, `${label} is not tracked by the exact Community commit: ${safe}`);
  const absolute = path.join(source, ...safe.split("/"));
  const stat = await fs.lstat(absolute);
  assert(stat.isFile() && !stat.isSymbolicLink(), `${label} must be a regular file`);
  assert(stat.size > 0 && stat.size <= maximum, `${label} has an invalid byte length`);
  const worktreeBytes = new Uint8Array(await fs.readFile(absolute));
  const committedBytes = await gitBytes(source, ["show", `${commit}:${safe}`], maximum, runner);
  assert(
    worktreeBytes.byteLength === committedBytes.byteLength &&
      Buffer.from(worktreeBytes).equals(Buffer.from(committedBytes)),
    `${label} bytes differ from the exact Community commit: ${safe}`,
  );
  return worktreeBytes;
}

async function readTrackedJson(source, commit, inventory, relative, maximum, label, runner) {
  const bytes = await readTrackedBytes(source, commit, inventory, relative, maximum, label, runner);
  return parseJsonBytes(bytes, maximum, label);
}

function parsePorcelainPaths(output) {
  if (!output) return [];
  const fields = output.split("\0");
  const paths = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (!field) continue;
    assert(field.length >= 4, "Community checkout returned malformed git status output");
    const code = field.slice(0, 2);
    const relative = assertPortableRelativePath(field.slice(3), "Community git status path");
    paths.push(relative);
    if (code.includes("R") || code.includes("C")) {
      const renamedFrom = fields[index + 1];
      assert(renamedFrom, "Community checkout returned an incomplete rename status");
      paths.push(assertPortableRelativePath(renamedFrom, "Community git rename source path"));
      index += 1;
    }
  }
  return paths;
}

function affectsVendoredSnapshot(relative) {
  return relative.startsWith("catalog/") ||
    relative.startsWith("thumbs/") ||
    relative.startsWith("LICENSES/");
}

function pathsOverlap(left, right) {
  const relative = path.relative(left, right);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function assertVendoredInputsClean(source, runner) {
  const status = await git(
    source,
    ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "catalog", "thumbs", "LICENSES"],
    runner,
  );
  const dirty = parsePorcelainPaths(status).filter(affectsVendoredSnapshot);
  assert(dirty.length === 0, `Community checkout has dirty vendored input: ${dirty.join(", ")}`);
}

export async function syncCommunitySnapshot(options) {
  const source = path.resolve(options.source);
  const expectedCommit = options.commit.toLocaleLowerCase("en-US");
  const target = path.resolve(options.target ?? path.join(root, "assets", "community"));
  const runner = options.execFile ?? execFile;
  const fileOperations = {
    rename: options.fileOperations?.rename ?? fs.rename,
    remove: options.fileOperations?.remove ?? fs.rm,
  };
  assert(COMMIT.test(expectedCommit), "Community sync commit must be an exact 40-hex commit");
  assert(path.dirname(target) !== target, "Community sync target must not be a filesystem root");
  assert(!pathsOverlap(source, target) && !pathsOverlap(target, source), "Community source and target must be separate directory trees");
  const observedCommit = (await git(source, ["rev-parse", "HEAD"], runner))
    .trim()
    .toLocaleLowerCase("en-US");
  assert(observedCommit === expectedCommit, `Community checkout HEAD ${observedCommit} differs from --commit ${expectedCommit}`);
  const remote = (await git(source, ["remote", "get-url", "origin"], runner)).trim();
  assert(
    /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)jarxunlai\/ScientificFigureLibrary-community(?:\.git)?$/iu.test(remote),
    "Community checkout origin is not the fixed central Catalog repository",
  );
  await assertVendoredInputsClean(source, runner);
  const inventory = await loadCommitInventory(source, expectedCommit, runner);
  await assertCommitMatchesFetchedCentral(source, expectedCommit, inventory, runner);
  await assertWorktreeInventoryMatches(source, inventory);
  const usedTrackedPaths = new Set(["catalog/catalog.json", "catalog/preview-manifest.json"]);
  const { bytes: catalogBytes, value: catalog } = await readTrackedJson(
    source,
    expectedCommit,
    inventory,
    "catalog/catalog.json",
    MAX_CATALOG_BYTES,
    "Community catalog",
    runner,
  );
  const { bytes: previewManifestBytes, value: previewManifest } = await readTrackedJson(
    source,
    expectedCommit,
    inventory,
    "catalog/preview-manifest.json",
    MAX_CATALOG_BYTES,
    "Community preview manifest",
    runner,
  );
  // The vendored bytes must pass the same complete parser used after installation,
  // in addition to the central-repository inventory checks below.
  parsePublicProviderCatalog(catalogBytes);

  assertExactKeys(catalog, ["schema", "provider", "generatedAt", "entries"], [], "catalog");
  assert(catalog.schema === "figure-library.public-provider-catalog.v1", "unsupported Community Catalog schema");
  assertExactKeys(catalog.provider, ["providerId", "displayName", "catalogRepository", "archiveRepository"], [], "catalog.provider");
  assert(catalog.provider.providerId === PROVIDER_ID, "Community providerId mismatch");
  nonEmptyString(catalog.provider.displayName, "catalog.provider.displayName", 200);
  assert(catalog.provider.catalogRepository === CATALOG_REPOSITORY, "Community catalog repository mismatch");
  assert(catalog.provider.archiveRepository === ARCHIVE_REPOSITORY, "Community archive repository mismatch");
  assertRfc3339(catalog.generatedAt, "catalog.generatedAt");
  assert(
    Array.isArray(catalog.entries) && catalog.entries.length <= 100_000,
    "Community Catalog entries must be an array with at most 100000 entries",
  );

  assertExactKeys(previewManifest, ["schema", "providerId", "entries"], [], "previewManifest");
  assert(previewManifest.schema === "figure-library.public-preview-manifest.v1", "unsupported preview manifest schema");
  assert(previewManifest.providerId === PROVIDER_ID, "preview manifest providerId mismatch");
  assert(Array.isArray(previewManifest.entries), "preview manifest entries must be an array");

  const expectedPreviews = [];
  const previewFiles = [];
  const requiredLicensePaths = new Set([
    "LICENSES/CC-BY-4.0.txt",
    "LICENSES/MIT.txt",
  ]);
  let priorIdentity = "";
  let previewPackBytes = 0;
  for (const [index, entry] of catalog.entries.entries()) {
    const entryLabel = `catalog.entries[${index}]`;
    assertExactKeys(
      entry,
      ["schema", "providerId", "templateId", "releaseVersion", "contentDigest", "title", "description", "search", "archive", "preview", "status", "licenses"],
      ["provenance"],
      entryLabel,
    );
    assert(entry.schema === "figure-library.public-template-entry.v1" && entry.providerId === PROVIDER_ID, `${entryLabel} identity is invalid`);
    assert(typeof entry.templateId === "string" && TEMPLATE_ID.test(entry.templateId), `${entryLabel}.templateId is invalid`);
    assert(typeof entry.releaseVersion === "string" && entry.releaseVersion.length <= 100 && STRICT_SEMVER.test(entry.releaseVersion), `${entryLabel}.releaseVersion is not semantic`);
    assert(typeof entry.contentDigest === "string" && HASH.test(entry.contentDigest), `${entryLabel}.contentDigest is invalid`);
    nonEmptyString(entry.title, `${entryLabel}.title`, 300);
    nonEmptyString(entry.description, `${entryLabel}.description`, 4_000);
    const identity = `${entry.templateId}@${entry.releaseVersion}`;
    assert(!priorIdentity || identity > priorIdentity, `Catalog entries are not canonically ordered at ${identity}`);
    priorIdentity = identity;

    assertExactKeys(entry.search, [
      "application",
      "dataProfile",
      "plotFamily",
      "language",
      "tags",
      "packages",
      "codeFiles",
      "inputFiles",
    ], [], `${entryLabel}.search`);
    boundedString(entry.search.application, `${entryLabel}.search.application`, 4_000);
    boundedString(entry.search.dataProfile, `${entryLabel}.search.dataProfile`, 4_000);
    nonEmptyString(entry.search.plotFamily, `${entryLabel}.search.plotFamily`, 200);
    nonEmptyString(entry.search.language, `${entryLabel}.search.language`, 100);
    assertStringArray(entry.search.tags, `${entryLabel}.search.tags`, 10_000, 100);
    assertStringArray(entry.search.packages, `${entryLabel}.search.packages`, 10_000, 200);
    assertStringArray(entry.search.codeFiles, `${entryLabel}.search.codeFiles`);
    assertStringArray(entry.search.inputFiles, `${entryLabel}.search.inputFiles`);

    if (entry.provenance !== undefined) {
      assert(
        Array.isArray(entry.provenance) && entry.provenance.length <= 1_000 &&
          entry.provenance.every((item) => isRecord(item)),
        `${entryLabel}.provenance must be an array of at most 1000 objects`,
      );
    }

    assertExactKeys(entry.archive, ["repository", "commit", "path", "bytes", "sha256"], [], `${identity}.archive`);
    assert(entry.archive.repository === ARCHIVE_REPOSITORY, `${identity} archive repository mismatch`);
    assert(typeof entry.archive.commit === "string" && COMMIT.test(entry.archive.commit), `${identity} archive commit is invalid`);
    const expectedArchivePath = `archives/${entry.templateId}/${entry.releaseVersion}/${entry.templateId}-${entry.releaseVersion}.zip`;
    assert(entry.archive.path === expectedArchivePath, `${identity} archive path is not immutable/canonical`);
    positiveInteger(entry.archive.bytes, `${identity}.archive.bytes`, MAX_ARCHIVE_BYTES);
    assert(typeof entry.archive.sha256 === "string" && HASH.test(entry.archive.sha256), `${identity} archive SHA-256 is invalid`);

    assertExactKeys(entry.preview, ["path", "bytes", "sha256", "mediaType", "width", "height", "canonicalRgbaSha256"], [], `${identity}.preview`);
    const expectedPreviewPath = `thumbs/${entry.templateId}/${entry.releaseVersion}.png`;
    assert(entry.preview.path === expectedPreviewPath, `${identity} preview path is invalid`);
    assert(entry.preview.mediaType === "image/png", `${identity} preview media type is invalid`);
    positiveInteger(entry.preview.bytes, `${identity}.preview.bytes`, MAX_PREVIEW_PACK_BYTES);
    positiveInteger(entry.preview.width, `${identity}.preview.width`, 16_384);
    positiveInteger(entry.preview.height, `${identity}.preview.height`, 16_384);
    assert(
      entry.preview.width * entry.preview.height * 4 <= 128 * 1024 * 1024,
      `${identity} preview canonical RGBA payload is too large`,
    );
    assert(HASH.test(entry.preview.sha256) && HASH.test(entry.preview.canonicalRgbaSha256), `${identity} preview digest is invalid`);

    assertExactKeys(entry.status, ["upstreamStatus", "publisherVerified", "curationStatus", "renderValidation", "localReviewStatus", "plotExecutionByRecipient"], [], `${identity}.status`);
    assert(entry.status.upstreamStatus === "published", `${identity} upstreamStatus is invalid`);
    assert(typeof entry.status.publisherVerified === "boolean", `${identity} publisherVerified is invalid`);
    assert(["curated", "unreviewed"].includes(entry.status.curationStatus), `${identity} curationStatus is invalid`);
    assert(["ci_rendered", "publisher_attested", "unverified"].includes(entry.status.renderValidation), `${identity} renderValidation is invalid`);
    assert(entry.status.localReviewStatus === "not_reviewed", `${identity} cannot claim recipient review`);
    assert(entry.status.plotExecutionByRecipient === "not_run", `${identity} cannot claim recipient execution`);

    assertExactKeys(entry.licenses, ["code", "content", "documentation"], [], `${identity}.licenses`);
    requiredLicensePaths.add(licenseTextPath(entry.licenses.code, `${entryLabel}.licenses.code`));
    requiredLicensePaths.add(licenseTextPath(entry.licenses.content, `${entryLabel}.licenses.content`));
    requiredLicensePaths.add(licenseTextPath(entry.licenses.documentation, `${entryLabel}.licenses.documentation`));

    const standalonePath = `catalog/entries/${entry.templateId}/${entry.releaseVersion}.json`;
    usedTrackedPaths.add(standalonePath);
    const standalone = await readTrackedJson(
      source,
      expectedCommit,
      inventory,
      standalonePath,
      1024 * 1024,
      `${identity} standalone Catalog entry`,
      runner,
    );
    assert(canonical(standalone.value) === canonical(entry), `${identity} standalone entry differs from aggregate Catalog`);

    usedTrackedPaths.add(entry.preview.path);
    const previewBytes = await readTrackedBytes(
      source,
      expectedCommit,
      inventory,
      entry.preview.path,
      MAX_PREVIEW_PACK_BYTES,
      `${identity} preview`,
      runner,
    );
    assert(previewBytes.byteLength === entry.preview.bytes && sha256(previewBytes) === entry.preview.sha256, `${identity} preview byte identity mismatch`);
    const decoded = PNG.sync.read(Buffer.from(previewBytes), { checkCRC: true });
    assert(decoded.width === entry.preview.width && decoded.height === entry.preview.height, `${identity} preview dimensions mismatch`);
    assert(sha256(decoded.data) === entry.preview.canonicalRgbaSha256, `${identity} preview RGBA digest mismatch`);
    previewPackBytes += previewBytes.byteLength;
    assert(previewPackBytes <= MAX_PREVIEW_PACK_BYTES, "Community preview pack exceeds 64 MiB");
    previewFiles.push({ relative: entry.preview.path, bytes: previewBytes });
    expectedPreviews.push({ templateId: entry.templateId, releaseVersion: entry.releaseVersion, ...entry.preview });
  }
  assert(canonical(previewManifest.entries) === canonical(expectedPreviews), "preview manifest does not exactly match Catalog previews");

  const orphanCatalogAssets = [...inventory.keys()].filter((relative) =>
    (relative.startsWith("catalog/") || relative.startsWith("thumbs/")) &&
      !usedTrackedPaths.has(relative) &&
      relative !== "catalog/entries/.gitkeep" &&
      relative !== "thumbs/.gitkeep");
  assert(
    orphanCatalogAssets.length === 0,
    `Community commit contains orphan Catalog/thumbnail assets: ${orphanCatalogAssets.sort().join(", ")}`,
  );

  const licensePaths = [...inventory.keys()].filter((relative) => relative.startsWith("LICENSES/")).sort();
  const missingLicensePaths = [...requiredLicensePaths].filter((relative) => !inventory.has(relative)).sort();
  assert(
    missingLicensePaths.length === 0,
    `Community snapshot is missing required tracked license texts: ${missingLicensePaths.join(", ")}`,
  );
  const licenseFiles = [];
  for (const relative of licensePaths) {
    licenseFiles.push({
      relative,
      bytes: await readTrackedBytes(source, expectedCommit, inventory, relative, MAX_LICENSE_BYTES, relative, runner),
    });
  }

  const assetsRoot = path.dirname(target);
  await fs.mkdir(assetsRoot, { recursive: true });
  const staging = path.join(assetsRoot, `.${path.basename(target)}-sync-${randomUUID()}`);
  const backup = path.join(assetsRoot, `.${path.basename(target)}-backup-${randomUUID()}`);
  await fs.mkdir(staging, { recursive: false });

  async function write(relative, bytes) {
    const safe = assertPortableRelativePath(relative, relative);
    const destination = path.join(staging, ...safe.split("/"));
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, bytes, { flag: "wx" });
  }

  try {
    await write("catalog.json", catalogBytes);
    await write("preview-manifest.json", previewManifestBytes);
    for (const preview of previewFiles) await write(preview.relative, preview.bytes);
    for (const license of licenseFiles) await write(license.relative, license.bytes);
    const sourceLock = {
      schema: "figure-library.community-source-lock.v1",
      providerId: PROVIDER_ID,
      catalogRepository: CATALOG_REPOSITORY,
      catalogCommit: expectedCommit,
      archiveRepository: ARCHIVE_REPOSITORY,
      catalog: { path: "catalog.json", bytes: catalogBytes.byteLength, sha256: sha256(catalogBytes) },
      previewManifest: { path: "preview-manifest.json", bytes: previewManifestBytes.byteLength, sha256: sha256(previewManifestBytes) },
    };
    await write("source.lock.json", Buffer.from(`${JSON.stringify(sourceLock, null, 2)}\n`, "utf8"));

    let movedOld = false;
    const warnings = [];
    try {
      await fileOperations.rename(target, backup);
      movedOld = true;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    try {
      await fileOperations.rename(staging, target);
    } catch (switchError) {
      if (movedOld) {
        try {
          await fileOperations.rename(backup, target);
          movedOld = false;
        } catch (restoreError) {
          const compound = new AggregateError(
            [switchError, restoreError],
            `Community snapshot activation failed and rollback also failed; ` +
              `the prior snapshot remains at ${backup} and the candidate remains at ${staging}`,
            { cause: switchError },
          );
          compound.code = "community_sync_restore_failed";
          compound.target = target;
          compound.backup = backup;
          compound.staging = staging;
          throw compound;
        }
      }
      throw switchError;
    }
    if (movedOld) {
      try {
        await fileOperations.remove(backup, { recursive: true, force: true });
      } catch (cleanupError) {
        warnings.push({
          code: "community_sync_backup_cleanup_failed",
          path: backup,
          message: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        });
      }
    }
    return {
      target,
      releases: catalog.entries.length,
      commit: expectedCommit,
      catalogSha256: sha256(catalogBytes),
      previewManifestSha256: sha256(previewManifestBytes),
      warnings,
    };
  } catch (error) {
    if (error?.code === "community_sync_restore_failed") throw error;
    try {
      await fileOperations.remove(staging, { recursive: true, force: true });
    } catch (cleanupError) {
      const compound = new AggregateError(
        [error, cleanupError],
        `Community sync failed and staging cleanup also failed; recoverable staging remains at ${staging}`,
        { cause: error },
      );
      compound.code = "community_sync_staging_cleanup_failed";
      compound.staging = staging;
      throw compound;
    }
    throw error;
  }
}

export async function main(argv = process.argv.slice(2)) {
  const sourceArgument = argument(argv, "--source");
  const expectedCommit = argument(argv, "--commit")?.toLocaleLowerCase("en-US");
  const targetArgument = argument(argv, "--target");
  if (!sourceArgument || !expectedCommit || !COMMIT.test(expectedCommit)) {
    throw new Error(
      "usage: node scripts/sync-community.mjs --source <checked-out Community repository> --commit <40-hex exact commit> [--target <output directory>]",
    );
  }
  const result = await syncCommunitySnapshot({
    source: sourceArgument,
    commit: expectedCommit,
    ...(targetArgument ? { target: targetArgument } : {}),
  });
  process.stdout.write(
    `synced ${result.releases} Community releases from ${CATALOG_REPOSITORY}@${result.commit}\n` +
      `catalog sha256 ${result.catalogSha256}\npreview manifest sha256 ${result.previewManifestSha256}\n`,
  );
  for (const warning of result.warnings) {
    process.stderr.write(`warning ${warning.code}: ${warning.message}; retained at ${warning.path}\n`);
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  await main();
}
