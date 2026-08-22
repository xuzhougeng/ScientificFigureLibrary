import { execFile as execFileCallback } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  COMMUNITY_PROVIDER_ID,
  loadBundledCommunitySnapshot,
} from "../src/public-catalog-provider.ts";

const execFile = promisify(execFileCallback);

export const CENTRAL_CATALOG_REPOSITORY =
  "jarxunlai/ScientificFigureLibrary-community";
export const CENTRAL_ARCHIVE_REPOSITORY =
  "jarxunlai/ScientificFigureLibrary-community-archives";
export const BOOTSTRAP_COMMUNITY_COMMIT =
  "be1080c4c637dbf0f3580abbbd145fd03e2491c4";
export const REQUIRED_COMMUNITY_RELEASES = Object.freeze([
  "ggsankeyfier-layout-color-combo@1.0.0",
  "single-cell-enrichment-bar-pathway-genes@1.0.0",
  "umap-unchull-main-type-circles@1.0.0",
]);

export const STANDARD_TOOL_NAMES = Object.freeze([
  "figure_library_apply_adopt_versioning",
  "figure_library_apply_bind_global",
  "figure_library_apply_bind_workspace",
  "figure_library_apply_bundle_export",
  "figure_library_apply_discard_working_revision",
  "figure_library_apply_full_restore",
  "figure_library_apply_materialize",
  "figure_library_apply_provider_source_change",
  "figure_library_apply_publication_export",
  "figure_library_apply_publication_pr",
  "figure_library_apply_publish_working_revision",
  "figure_library_apply_recover_write_lock",
  "figure_library_apply_restore_release",
  "figure_library_apply_review_gate_update",
  "figure_library_apply_template_bundle_import",
  "figure_library_apply_working_revision",
  "figure_library_confirm_selection",
  "figure_library_confirm_selection_headless",
  "figure_library_describe",
  "figure_library_diff_revisions",
  "figure_library_export_diagnostics",
  "figure_library_github_auth_instructions",
  "figure_library_github_auth_status",
  "figure_library_list_provider_sources",
  "figure_library_open",
  "figure_library_plan_adopt_versioning",
  "figure_library_plan_bind_global",
  "figure_library_plan_bind_workspace",
  "figure_library_plan_bundle_export",
  "figure_library_plan_discard_working_revision",
  "figure_library_plan_full_restore",
  "figure_library_plan_materialize",
  "figure_library_plan_provider_source_change",
  "figure_library_plan_publication_export",
  "figure_library_plan_publication_pr",
  "figure_library_plan_publish_working_revision",
  "figure_library_plan_recover_write_lock",
  "figure_library_plan_restore_release",
  "figure_library_plan_review_gate_update",
  "figure_library_plan_template_bundle_import",
  "figure_library_plan_working_revision",
  "figure_library_preview",
  "figure_library_preview_exact",
  "figure_library_preview_exact_headless",
  "figure_library_preview_working_revision",
  "figure_library_record_ui_event",
  "figure_library_review_open",
  "figure_library_search",
  "figure_library_search_page",
  "figure_library_source_status",
  "figure_library_template_history",
].sort());

const SHA256 = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const TEXT_FILE_LIMIT = 32 * 1024 * 1024;
const PRIVATE_KEY_PEM = /-----BEGIN (?:OPENSSH |EC |RSA )?PRIVATE KEY-----/u;
const GITHUB_TOKEN = /(?:^|[^A-Za-z0-9_])(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/u;
const FORBIDDEN_STATE_PATHS = [
  /(?:^|\/)(?:locator|workspace-locator)\.json$/iu,
  /(?:^|\/)provider-sources\.json$/iu,
  /(?:^|\/)provider-sources(?:\/|$)/iu,
  /(?:^|\/)github-publication-receipts(?:\/|$)/iu,
  /(?:^|\/)(?:binding-receipts|operations|receipts|imports|quarantine)(?:\/|$)/iu,
  /(?:^|\/)(?:seed-staging|submission-staging|publication-staging)(?:\/|$)/iu,
  /(?:^|\/)submission\.json$/iu,
  /(?:^|\/)snapshot-inventory\.jsonl$/iu,
  /(?:^|\/)(?:id_ed25519|id_rsa|id_ecdsa)(?:\.[^/]*)?$/iu,
  /(?:^|\/)[^/]*(?:private[-_.]?key|secret[-_.]?key)[^/]*$/iu,
  /(?:^|\/)[^/]+\.(?:pem|key|p8|p12|pfx)$/iu,
];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function normalizeArchivePath(value, label = "package path") {
  assert(typeof value === "string" && value.length > 0, `${label} is empty`);
  assert(!value.includes("\\") && !value.startsWith("/") && !/^[A-Za-z]:/u.test(value), `${label} is absolute or platform-specific: ${value}`);
  assert(path.posix.normalize(value) === value, `${label} is not canonical: ${value}`);
  assert(
    !value.split("/").some((part) => !part || part === "." || part === ".."),
    `${label} contains an unsafe segment: ${value}`,
  );
  return value;
}

async function walkRegularFiles(directory, prefix = "") {
  const output = [];
  const stat = await fs.lstat(directory);
  assert(stat.isDirectory() && !stat.isSymbolicLink(), `${directory} is not a regular directory`);
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    const relative = normalizeArchivePath(path.posix.join(prefix, entry.name));
    if (entry.isSymbolicLink()) throw new Error(`package input contains a symlink: ${relative}`);
    if (entry.isDirectory()) output.push(...(await walkRegularFiles(absolute, relative)));
    else if (entry.isFile()) output.push({ absolute, relative });
    else throw new Error(`package input contains a non-regular file: ${relative}`);
  }
  return output.sort((left, right) => left.relative.localeCompare(right.relative, "en"));
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new Error(`${label} is not strict UTF-8 JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Release-only Community gate. Development smoke tests intentionally do not
 * call this function, so the checked-in empty bootstrap snapshot remains a
 * valid development fixture until the three reviewed Catalog PRs are merged.
 */
export async function assertFinalCommunitySnapshot(options = {}) {
  const repositoryRoot = path.resolve(options.repositoryRoot ?? path.resolve(import.meta.dirname, ".."));
  const communityRoot = path.resolve(
    options.communityRoot ?? path.join(repositoryRoot, "assets", "community"),
  );
  const lockBytes = new Uint8Array(await fs.readFile(path.join(communityRoot, "source.lock.json")));
  const sourceLock = parseJson(lockBytes, "Community source.lock.json");
  assert(isRecord(sourceLock), "Community source.lock.json must be an object");
  assert(sourceLock.schema === "figure-library.community-source-lock.v1", "Community source.lock.json schema is invalid");
  assert(sourceLock.providerId === COMMUNITY_PROVIDER_ID, "Community source.lock.json providerId is invalid");
  assert(sourceLock.catalogRepository === CENTRAL_CATALOG_REPOSITORY, "Community source.lock.json Catalog repository is invalid");
  assert(sourceLock.archiveRepository === CENTRAL_ARCHIVE_REPOSITORY, "Community source.lock.json archive repository is invalid");
  assert(typeof sourceLock.catalogCommit === "string" && COMMIT.test(sourceLock.catalogCommit), "Community source.lock.json catalogCommit must be exact 40-hex");
  assert(
    sourceLock.catalogCommit !== BOOTSTRAP_COMMUNITY_COMMIT &&
      !sourceLock.catalogCommit.startsWith("be1080c"),
    "release Community Catalog still points at the empty bootstrap commit be1080c",
  );
  assert(isRecord(sourceLock.catalog) && sourceLock.catalog.path === "catalog.json", "Community source.lock.json must bind catalog.json");
  assert(isRecord(sourceLock.previewManifest) && sourceLock.previewManifest.path === "preview-manifest.json", "Community source.lock.json must bind preview-manifest.json");

  const snapshot = await loadBundledCommunitySnapshot(communityRoot);
  const catalog = snapshot.catalog;
  assert(catalog.provider.providerId === COMMUNITY_PROVIDER_ID, "release Community Catalog providerId is invalid");
  assert(catalog.provider.catalogRepository === CENTRAL_CATALOG_REPOSITORY, "release Community Catalog repository is invalid");
  assert(catalog.provider.archiveRepository === CENTRAL_ARCHIVE_REPOSITORY, "release Community archive repository is invalid");
  assert(catalog.entries.length >= REQUIRED_COMMUNITY_RELEASES.length, "release Community Catalog has fewer than the three required seed releases");

  const identities = new Map(
    catalog.entries.map((entry) => [`${entry.templateId}@${entry.releaseVersion}`, entry]),
  );
  for (const identity of REQUIRED_COMMUNITY_RELEASES) {
    const entry = identities.get(identity);
    assert(entry, `release Community Catalog omitted required seed ${identity}`);
    assert(entry.archive.repository === CENTRAL_ARCHIVE_REPOSITORY, `${identity} archive repository is invalid`);
    assert(COMMIT.test(entry.archive.commit) && !/^0+$/u.test(entry.archive.commit), `${identity} archive commit is not immutable`);
    assert(SHA256.test(entry.archive.sha256) && !/^0+$/u.test(entry.archive.sha256), `${identity} archive SHA-256 is invalid`);
    assert(
      entry.archive.path === `archives/${entry.templateId}/${entry.releaseVersion}/${entry.templateId}-${entry.releaseVersion}.zip`,
      `${identity} archive path is not canonical`,
    );
    assert(
      entry.status.publisherVerified === false,
      `${identity} falsely claims publisher verification for a frozen clean-room seed`,
    );
    assert(entry.status.curationStatus === "curated", `${identity} is not centrally curated`);
    assert(entry.status.renderValidation === "ci_rendered", `${identity} did not pass central CI rendering`);
    assert(entry.status.localReviewStatus === "not_reviewed", `${identity} falsely claims recipient review`);
    assert(entry.status.plotExecutionByRecipient === "not_run", `${identity} falsely claims recipient execution`);
    assert(entry.licenses.code === "MIT", `${identity} code license is not the approved MIT seed license`);
    assert(entry.licenses.content === "CC-BY-4.0", `${identity} content license is not the approved CC-BY-4.0 seed license`);
    assert(entry.licenses.documentation === "CC-BY-4.0", `${identity} documentation license is not the approved CC-BY-4.0 seed license`);
  }

  const observed = await walkRegularFiles(communityRoot);
  const observedPaths = new Set(observed.map((file) => file.relative));
  const expected = new Set(["catalog.json", "preview-manifest.json", "source.lock.json"]);
  for (const entry of catalog.entries) expected.add(entry.preview.path);
  for (const file of observed) {
    if (file.relative.startsWith("LICENSES/")) {
      const stat = await fs.stat(file.absolute);
      assert(stat.size > 0 && stat.size <= 1024 * 1024, `Community license has invalid size: ${file.relative}`);
      expected.add(file.relative);
    }
  }
  for (const license of ["LICENSES/MIT.txt", "LICENSES/CC-BY-4.0.txt"]) {
    assert(observedPaths.has(license), `release Community snapshot omitted required license text ${license}`);
  }
  const missing = [...expected].filter((relative) => !observedPaths.has(relative)).sort();
  const unexpected = [...observedPaths].filter((relative) => !expected.has(relative)).sort();
  assert(missing.length === 0, `release Community snapshot is missing inventory: ${missing.join(", ")}`);
  assert(unexpected.length === 0, `release Community snapshot has unexpected inventory: ${unexpected.join(", ")}`);

  return {
    catalogCommit: sourceLock.catalogCommit,
    catalogSha256: snapshot.catalogSha256,
    previewManifestSha256: snapshot.previewManifestSha256,
    releaseCount: catalog.entries.length,
    requiredReleases: [...REQUIRED_COMMUNITY_RELEASES],
    inventory: [...expected].sort(),
  };
}

function pathVariants(value) {
  if (!value) return [];
  const resolved = path.resolve(value);
  return [
    resolved,
    resolved.replaceAll("\\", "/"),
    JSON.stringify(resolved).slice(1, -1),
  ].filter(Boolean);
}

function currentMachinePaths(repositoryRoot) {
  const values = new Set([
    ...pathVariants(repositoryRoot),
    ...pathVariants(path.dirname(repositoryRoot)),
    ...pathVariants(os.homedir()),
    ...pathVariants(process.env.USERPROFILE),
    ...pathVariants(process.env.HOME),
  ]);
  // A source checkout nested under a worktree must not leak its authoritative
  // sibling project path either. This is intentionally value-based rather than
  // a broad drive-letter regex, which would misclassify URL schemes and code
  // that merely implements portable path handling.
  if (path.win32.isAbsolute(repositoryRoot)) {
    values.add(path.win32.join(path.win32.parse(repositoryRoot).root, "plot"));
    values.add(path.win32.join(path.win32.parse(repositoryRoot).root, "ScientificFigureLibrary"));
  }
  return [...values].filter((value) => value.length >= 4);
}

function isProbablyText(bytes) {
  if (bytes.byteLength > TEXT_FILE_LIMIT || bytes.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/** Audit a normalized package inventory without treating documented state-file
 * names or URL schemes in source code as leaked state. */
export function auditPackageContents(files, options = {}) {
  const label = options.label ?? "package";
  const repositoryRoot = path.resolve(options.repositoryRoot ?? path.resolve(import.meta.dirname, ".."));
  const entries = files instanceof Map ? [...files.entries()] : Object.entries(files);
  const seen = new Set();
  const seenFolded = new Map();
  const forbiddenMachinePaths = currentMachinePaths(repositoryRoot);
  for (const [rawRelative, rawBytes] of entries) {
    const relative = normalizeArchivePath(rawRelative, `${label} path`);
    assert(!seen.has(relative), `${label} contains duplicate path ${relative}`);
    seen.add(relative);
    const folded = relative.normalize("NFC").toLocaleLowerCase("en-US");
    const prior = seenFolded.get(folded);
    assert(!prior, `${label} contains case-fold path collision: ${prior} and ${relative}`);
    seenFolded.set(folded, relative);
    for (const forbidden of FORBIDDEN_STATE_PATHS) {
      assert(!forbidden.test(relative), `${label} contains forbidden local/private state path ${relative}`);
    }
    const bytes = rawBytes instanceof Uint8Array ? rawBytes : new Uint8Array(rawBytes);
    if (!isProbablyText(bytes)) continue;
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    assert(!PRIVATE_KEY_PEM.test(text), `${label} contains private-key material in ${relative}`);
    assert(!GITHUB_TOKEN.test(text), `${label} contains a GitHub credential-like token in ${relative}`);
    for (const absolutePath of forbiddenMachinePaths) {
      assert(
        !text.includes(absolutePath),
        `${label} leaked development-machine absolute path ${absolutePath} in ${relative}`,
      );
    }
  }
  return { files: [...seen].sort() };
}

export async function authoritativeNpmInventory(repositoryRoot) {
  const root = path.resolve(repositoryRoot);
  const packageJson = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
  assert(Array.isArray(packageJson.files), "package.json files must be an explicit array");
  const output = new Map();
  const addFile = async (absolute, relative) => {
    const safe = normalizeArchivePath(relative, "npm authoritative path");
    assert(!output.has(safe), `npm authoritative inventory duplicated ${safe}`);
    output.set(safe, new Uint8Array(await fs.readFile(absolute)));
  };
  await addFile(path.join(root, "package.json"), "package.json");
  for (const declared of packageJson.files) {
    const relative = normalizeArchivePath(declared, "package.json files entry");
    const absolute = path.join(root, ...relative.split("/"));
    const stat = await fs.lstat(absolute);
    if (stat.isSymbolicLink()) throw new Error(`npm package input is a symlink: ${relative}`);
    if (stat.isFile()) await addFile(absolute, relative);
    else if (stat.isDirectory()) {
      for (const file of await walkRegularFiles(absolute, relative)) {
        await addFile(file.absolute, file.relative);
      }
    } else throw new Error(`npm package input is not regular: ${relative}`);
  }
  return output;
}

function parseTarString(bytes) {
  const zero = bytes.indexOf(0);
  return Buffer.from(zero === -1 ? bytes : bytes.subarray(0, zero)).toString("utf8");
}

function parseTarOctal(bytes, label) {
  const text = parseTarString(bytes).trim();
  assert(/^[0-7]+$/u.test(text), `${label} is not canonical octal`);
  const value = Number.parseInt(text, 8);
  assert(Number.isSafeInteger(value) && value >= 0, `${label} is out of range`);
  return value;
}

/** Parse the restricted regular-file tar format emitted by npm pack. */
export function readNpmTarball(tgzBytes) {
  const tar = new Uint8Array(gunzipSync(tgzBytes));
  const output = new Map();
  let offset = 0;
  let ended = false;
  while (offset + 512 <= tar.byteLength) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      ended = true;
      break;
    }
    const storedChecksum = parseTarOctal(header.subarray(148, 156), "tar header checksum");
    let checksum = 0;
    for (let index = 0; index < 512; index += 1) {
      checksum += index >= 148 && index < 156 ? 0x20 : header[index];
    }
    assert(checksum === storedChecksum, "npm tarball header checksum is invalid");
    const type = header[156] === 0 ? "0" : String.fromCharCode(header[156]);
    assert(type === "0", `npm tarball contains unsupported non-regular entry type ${type}`);
    const prefix = parseTarString(header.subarray(345, 500));
    const name = parseTarString(header.subarray(0, 100));
    const archived = prefix ? `${prefix}/${name}` : name;
    assert(archived.startsWith("package/"), `npm tarball entry is outside package/: ${archived}`);
    const relative = normalizeArchivePath(archived.slice("package/".length), "npm tarball path");
    assert(!output.has(relative), `npm tarball contains duplicate path ${relative}`);
    const size = parseTarOctal(header.subarray(124, 136), `${relative} tar size`);
    const start = offset + 512;
    const end = start + size;
    assert(end <= tar.byteLength, `npm tarball truncates ${relative}`);
    output.set(relative, new Uint8Array(tar.slice(start, end)));
    offset = start + Math.ceil(size / 512) * 512;
  }
  assert(ended, "npm tarball has no zero-block terminator");
  assert(output.size > 0, "npm tarball is empty");
  return output;
}

export function assertExactInventory(actual, expected, label) {
  const actualPaths = [...actual.keys()].sort();
  const expectedPaths = [...expected.keys()].sort();
  const missing = expectedPaths.filter((relative) => !actual.has(relative));
  const unexpected = actualPaths.filter((relative) => !expected.has(relative));
  assert(missing.length === 0 && unexpected.length === 0, `${label} inventory differs: missing=${missing.join(",")} unexpected=${unexpected.join(",")}`);
  for (const relative of expectedPaths) {
    assert(
      sha256(actual.get(relative)) === sha256(expected.get(relative)),
      `${label} bytes differ from authoritative source at ${relative}`,
    );
  }
  return actualPaths;
}

export async function extractPackageFiles(files, destination) {
  await fs.mkdir(destination, { recursive: true });
  for (const [relative, bytes] of files) {
    const safe = normalizeArchivePath(relative);
    const target = path.join(destination, ...safe.split("/"));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, bytes, { flag: "wx" });
  }
}

function withTimeout(promise, milliseconds, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${milliseconds} ms`)), milliseconds);
    }),
  ]).finally(() => clearTimeout(timer));
}

export function assertExactToolInventory(tools, label) {
  const names = tools.map((tool) => tool.name).sort();
  const expected = [...STANDARD_TOOL_NAMES];
  const missing = expected.filter((name) => !names.includes(name));
  const unexpected = names.filter((name) => !expected.includes(name));
  assert(
    JSON.stringify(names) === JSON.stringify(expected),
    `${label} tool inventory differs: missing=${JSON.stringify(missing)} unexpected=${JSON.stringify(unexpected)}`,
  );
  return names;
}

export async function smokePackagedNpm(options) {
  const root = path.resolve(options.packageRoot);
  const foreignProjectDirectory = path.resolve(options.foreignProjectDirectory);
  const isolatedUserState = path.resolve(options.isolatedUserState);
  const entry = path.join(root, "dist", "index.js");
  await fs.mkdir(foreignProjectDirectory, { recursive: true });
  await fs.mkdir(isolatedUserState, { recursive: true });
  const environment = Object.fromEntries(
    Object.entries(process.env).filter((item) => typeof item[1] === "string"),
  );
  delete environment.FIGURE_LIBRARY_DIR;
  environment.APPDATA = isolatedUserState;
  environment.LOCALAPPDATA = isolatedUserState;
  environment.XDG_CONFIG_HOME = isolatedUserState;
  environment.XDG_DATA_HOME = isolatedUserState;
  let stderr = "";
  const client = new Client({ name: "sfl-npm-foreign-cwd-smoke", version: options.version });
  try {
    const transport = new StdioClientTransport({
      command: "node",
      args: [entry],
      cwd: foreignProjectDirectory,
      env: environment,
      stderr: "pipe",
    });
    transport.stderr?.on("data", (chunk) => {
      if (stderr.length < 32_768) stderr += chunk.toString();
    });
    await withTimeout(client.connect(transport), 20_000, "npm MCP initialize");
    const listed = await withTimeout(client.listTools(), 20_000, "npm MCP tools/list");
    return { toolCount: assertExactToolInventory(listed.tools, "npm package").length };
  } catch (error) {
    const detail = stderr.trim() ? `\npackaged server stderr:\n${stderr.trim()}` : "";
    throw new Error(`npm foreign-cwd package smoke failed: ${error instanceof Error ? error.message : String(error)}${detail}`, { cause: error });
  } finally {
    await client.close().catch(() => undefined);
  }
}

export async function runNpm(repositoryRoot, arguments_, options = {}) {
  const root = path.resolve(repositoryRoot);
  const environment = { ...process.env, ...options.env };
  let npmExecPath = process.env.npm_execpath;
  if (!npmExecPath && process.platform === "win32") {
    const bundled = path.join(
      path.dirname(process.execPath),
      "node_modules",
      "npm",
      "bin",
      "npm-cli.js",
    );
    try {
      const stat = await fs.lstat(bundled);
      if (stat.isFile() && !stat.isSymbolicLink()) npmExecPath = bundled;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  if (npmExecPath) {
    return execFile(process.execPath, [npmExecPath, ...arguments_], {
      cwd: root,
      env: environment,
      encoding: "utf8",
      windowsHide: true,
      timeout: options.timeout ?? 180_000,
      maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
    });
  }
  const executable = process.platform === "win32" ? "npm.cmd" : "npm";
  return execFile(executable, arguments_, {
    cwd: root,
    env: environment,
    encoding: "utf8",
    windowsHide: true,
    timeout: options.timeout ?? 180_000,
    maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
  });
}

/** Publish already-verified artifacts only after every validation/smoke gate
 * has passed. Per-file renames are rollback-protected on platforms that cannot
 * atomically exchange a directory while preserving older release artifacts. */
export async function publishArtifactsToDirectory(releaseDirectory, artifacts) {
  const release = path.resolve(releaseDirectory);
  await fs.mkdir(release, { recursive: true });
  const transaction = randomUUID();
  const prepared = [];
  const backups = [];
  const published = [];
  try {
    for (const [name, bytes] of [...artifacts].sort(([left], [right]) => left.localeCompare(right, "en"))) {
      assert(path.basename(name) === name && name.length > 0, `invalid release artifact name ${name}`);
      const temporary = path.join(release, `.${name}.${transaction}.tmp`);
      await fs.writeFile(temporary, bytes, { flag: "wx" });
      assert(sha256(await fs.readFile(temporary)) === sha256(bytes), `prepared release artifact failed verification: ${name}`);
      prepared.push({ name, bytes, temporary, target: path.join(release, name) });
    }
    for (const item of prepared) {
      const backup = path.join(release, `.${item.name}.${transaction}.backup`);
      let hadPrior = false;
      try {
        await fs.rename(item.target, backup);
        hadPrior = true;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      try {
        await fs.rename(item.temporary, item.target);
      } catch (activationError) {
        if (hadPrior) {
          try {
            await fs.rename(backup, item.target);
          } catch (restoreError) {
            throw new AggregateError(
              [activationError, restoreError],
              `release artifact activation and rollback both failed: target=${item.target} backup=${backup} temporary=${item.temporary}`,
              { cause: activationError },
            );
          }
        }
        throw activationError;
      }
      if (hadPrior) backups.push({ target: item.target, backup });
      published.push(item.target);
    }
    for (const item of backups) {
      await fs.rm(item.backup, { force: true }).catch((error) => {
        console.warn(
          `RELEASE_BACKUP_CLEANUP_FAILED: ${item.backup}: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }
    return published;
  } catch (error) {
    for (const target of published.reverse()) await fs.rm(target, { force: true }).catch(() => undefined);
    for (const item of backups.reverse()) await fs.rename(item.backup, item.target).catch(() => undefined);
    for (const item of prepared) await fs.rm(item.temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function publishReleaseArtifacts(repositoryRoot, artifacts) {
  return publishArtifactsToDirectory(
    path.join(path.resolve(repositoryRoot), "release"),
    artifacts,
  );
}

export async function temporaryDirectory(label) {
  return fs.mkdtemp(path.join(os.tmpdir(), `${label} with spaces-`));
}
