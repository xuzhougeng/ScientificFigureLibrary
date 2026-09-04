import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { canonicalJson, compareCanonicalStrings } from "./canonical-json.ts";
import type { CurrentLibraryContext, ToolOutcomeEnvelope } from "./library-binding-tools.ts";
import { readLibraryRootMarker } from "./library-runtime.ts";
import {
  FIGUREYA_PROVIDER_ID,
  LOCAL_LIBRARY_PROVIDER_ID,
  PERSONAL_MODULE_PROVIDER_ID,
  assertLocalPublishedExactSelector,
  canonicalSelectorJson,
} from "./providers.ts";
import type { LocalPublishedExactSelector, SearchRequest, TemplateCandidate } from "./types.ts";
import {
  OPEN_FIGURE_ARCHIVE_MANIFEST_SCHEMA,
  OPEN_FIGURE_PROVIDER_ID,
  OPEN_FIGURE_REPOSITORY,
  OPEN_FIGURE_SOURCE_LABEL,
  archiveOpenFigureModule,
  buildOpenFigureModule,
  normalizeComparableText,
  stableJson,
  type OpenFigureModuleBuild,
  type OpenFigureModuleFile,
} from "./open-figure-module.ts";
export { OPEN_FIGURE_REPOSITORY, OPEN_FIGURE_PROVIDER_ID, OPEN_FIGURE_SOURCE_LABEL } from "./open-figure-module.ts";
import { createGhCliRunner, type GhCommandResult, type GhRunner } from "./github-publication-tools.ts";
import type { ModuleCatalogIndex } from "./module-catalog.ts";
import type { CatalogIndex } from "./catalog.ts";

const HOST = "github.com" as const;
const BASE_BRANCH = "main" as const;
const HASH = /^[a-f0-9]{64}$/u;
const GIT_HASH = /^[a-f0-9]{40}$/u;
const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const PLAN_TTL_MS = 30 * 60 * 1_000;
const PLAN_LIMIT = 64;
const MAX_GH_OUTPUT_BYTES = 150 * 1024 * 1024;
const RECEIPT_SCHEMA = "figure-library.open-figure-pr-receipt.v1" as const;
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;

export const OPEN_FIGURE_SEARCH_PROVIDER_IDS = [FIGUREYA_PROVIDER_ID, PERSONAL_MODULE_PROVIDER_ID] as const;

type GhFailureKind =
  | "cli_missing"
  | "not_authenticated"
  | "credential_invalid"
  | "insufficient_scope"
  | "github_unreachable"
  | "not_found"
  | "conflict"
  | "command_failed";

class GhInvocationError extends Error {
  readonly kind: GhFailureKind;
  readonly operation: string;
  constructor(kind: GhFailureKind, operation: string) {
    super(`GitHub CLI ${operation} failed (${kind})`);
    this.kind = kind;
    this.operation = operation;
  }
}

export interface SimilarSearchRequest extends SearchRequest {
  providerIds: string[];
  limit: number;
}

export interface SimilarSearchSession {
  queryDigest: string;
  providerIds: string[];
}

export interface SimilarSearchResult {
  candidates: TemplateCandidate[];
  queryDigest: string;
}

export interface OpenFigureSimilarCandidate {
  providerId: string;
  templateId: string;
  title: string;
  sourceLabel: string;
  retrievalScore: number;
  matchKind: "identity" | "similar";
  previewSha256?: string;
}

export interface OpenFigurePrPlan {
  schema: "figure-library.open-figure-pr-plan.v1";
  providerId: typeof LOCAL_LIBRARY_PROVIDER_ID;
  exactSelector: LocalPublishedExactSelector;
  moduleId: string;
  title: string;
  titleEn: string;
  titleEnDerived: boolean;
  expectedGithubLogin: string;
  target: {
    repository: typeof OPEN_FIGURE_REPOSITORY;
    base: typeof BASE_BRANCH;
    baseCommit: string;
    baseTree: string;
  };
  head: {
    repository: string;
    branch: string;
    forkWillBeCreated: boolean;
  };
  similarSearch: {
    query: string;
    providerIds: string[];
    plotFamily?: string;
    language?: string;
    limit: number;
    queryDigest: string;
  };
  similarCandidates: OpenFigureSimilarCandidate[];
  similarReviewRequired: boolean;
  excludedLogicalPaths: string[];
  files: Array<{ path: string; bytes: number; sha256: string; change: "add" | "modify" }>;
  archive: { path: string; bytes: number; sha256: string };
  pullRequest: { title: string; body: string };
  written: false;
  planDigest: string;
}

interface PreparedPlan {
  plan: OpenFigurePrPlan;
  moduleFiles: Map<string, Uint8Array>;
  archiveZip: Uint8Array;
  archiveFileList: string[];
  generatedAt: string;
  build: OpenFigureModuleBuild;
}

interface OpenFigureReceipt {
  schema: typeof RECEIPT_SCHEMA;
  operationId: string;
  planDigest: string;
  login: string;
  targetRepository: string;
  headRepository: string;
  branch: string;
  sourceCommit: string;
  archiveCommit: string;
  pullRequestNumber: number;
  pullRequestUrl: string;
  recordedAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sha256(value: Uint8Array | string) {
  return createHash("sha256").update(value).digest("hex");
}

function gitBlobSha(value: Uint8Array) {
  return createHash("sha1").update(`blob ${value.byteLength}\0`, "utf8").update(value).digest("hex");
}

function encodeRepositoryPath(value: string) {
  return value.split("/").map(encodeURIComponent).join("/");
}

function envelope(
  outcome: ToolOutcomeEnvelope["outcome"],
  code: string,
  summary: string,
  nextAction: ToolOutcomeEnvelope["nextAction"],
  missingConfirmations?: string[],
): ToolOutcomeEnvelope {
  return {
    schema: "figure-library.tool-outcome.v1",
    outcome,
    terminal: true,
    retrySameCall: false,
    code,
    summary,
    nextAction,
    ...(missingConfirmations?.length ? { missingConfirmations } : {}),
  };
}

function response(value: ToolOutcomeEnvelope, details: Record<string, unknown> = {}, lines: string[] = []): CallToolResult {
  return {
    content: [{
      type: "text",
      text: [
        `OUTCOME: ${value.outcome}`,
        "TERMINAL: true",
        "RETRY_SAME_CALL: false",
        `CODE: ${value.code}`,
        `NEXT_ACTION: ${value.nextAction}`,
        value.summary,
        ...lines,
      ].join("\n"),
    }],
    structuredContent: { envelope: value, ...details },
  };
}

function classifyGhFailure(result: GhCommandResult): GhFailureKind {
  if (result.errorCode === "ENOENT" || result.exitCode === 127) return "cli_missing";
  const safe = `${result.stderr}\n${result.stdout}`.toLocaleLowerCase("en-US");
  if (/not logged|authenticate|authentication required|no oauth token/u.test(safe)) return "not_authenticated";
  if (/bad credentials|http 401|authentication token is invalid/u.test(safe)) return "credential_invalid";
  if (/http 403|resource not accessible|insufficient scope|requires .* scope/u.test(safe)) return "insufficient_scope";
  if (/could not resolve|connection (?:refused|reset)|timed out|network is unreachable|http 5\d\d/u.test(safe)) {
    return "github_unreachable";
  }
  if (/http 404|not found/u.test(safe)) return "not_found";
  if (/http 409|http 422|reference already exists|unprocessable/u.test(safe)) return "conflict";
  return "command_failed";
}

function assertSafeGhArguments(args: readonly string[]) {
  const joined = args.join(" ").toLocaleLowerCase("en-US");
  if (joined.includes("auth token") || joined.includes("--show-token") || joined.includes("hosts.yml") || joined.includes("--verbose")) {
    throw new Error("forbidden GitHub CLI credential or verbose operation");
  }
  if (args[0] !== "auth" && args[0] !== "api") throw new Error("only official gh auth status and gh api operations are allowed");
  if (args[0] === "auth" && args[1] !== "status") throw new Error("SFL never starts GitHub authentication or reads tokens");
}

async function runGh(runner: GhRunner, args: readonly string[], options?: { stdin?: string; timeoutMs?: number }) {
  assertSafeGhArguments(args);
  const result = await runner.run(args, options);
  if (result.exitCode !== 0) throw new GhInvocationError(classifyGhFailure(result), args.slice(0, 3).join(" "));
  return result.stdout;
}

async function ghJson<T>(
  runner: GhRunner,
  endpoint: string,
  options: { method?: "GET" | "POST"; body?: unknown; timeoutMs?: number } = {},
): Promise<T> {
  const args = ["api", endpoint, "--hostname", HOST];
  if (options.method && options.method !== "GET") args.push("--method", options.method);
  if (options.body !== undefined) args.push("--input", "-");
  const output = await runGh(runner, args, {
    ...(options.body !== undefined ? { stdin: canonicalJson(options.body) } : {}),
    timeoutMs: options.timeoutMs,
  });
  try {
    return JSON.parse(output) as T;
  } catch {
    throw new GhInvocationError("command_failed", `parse ${endpoint}`);
  }
}

async function optionalGhJson<T>(runner: GhRunner, endpoint: string): Promise<T | undefined> {
  try {
    return await ghJson<T>(runner, endpoint);
  } catch (error) {
    if (error instanceof GhInvocationError && error.kind === "not_found") return undefined;
    throw error;
  }
}

function validatePortablePath(value: string) {
  if (
    !value || value.includes("\\") || value.includes("\0") || value.startsWith("/") ||
    /^[A-Za-z]:/u.test(value) || /[\u0000-\u001f\u007f-\u009f]/u.test(value) ||
    path.posix.normalize(value) !== value
  ) throw new Error(`invalid portable path: ${value}`);
  for (const segment of value.split("/")) {
    if (!segment || segment === "." || segment === ".." || segment.normalize("NFC") !== segment || /[<>:"|?*]/u.test(segment) || segment.endsWith(".") || segment.endsWith(" ") || WINDOWS_RESERVED.test(segment)) {
      throw new Error(`invalid portable path segment in ${value}`);
    }
  }
  return value;
}

function assertAllowedOpenFigurePath(value: string, moduleId: string) {
  validatePortablePath(value);
  if (/^(?:\.github|workflows?|ci|polic(?:y|ies))(?:\/|$)/iu.test(value)) {
    throw new Error(`Open Figure PR may not modify workflow, CI, or policy files: ${value}`);
  }
  if (
    value === `archives/${moduleId}.zip` ||
    value === "catalog/archive-manifest.json" ||
    value.startsWith(`modules/${moduleId}/`)
  ) return;
  throw new Error(`Open Figure PR path is outside the module namespace: ${value}`);
}

async function readAuthAccount(runner: GhRunner) {
  const authOutput = await runGh(runner, ["auth", "status", "--active", "--hostname", HOST, "--json", "hosts"]);
  let parsed: unknown;
  try {
    parsed = JSON.parse(authOutput) as unknown;
  } catch {
    throw new GhInvocationError("command_failed", "parse auth status");
  }
  const hostEntries = isRecord(parsed) && isRecord(parsed.hosts) ? parsed.hosts[HOST] : undefined;
  const entries = Array.isArray(hostEntries) ? hostEntries : [];
  const active = entries.find((entry) => isRecord(entry) && entry.active === true);
  if (!isRecord(active)) throw new GhInvocationError("not_authenticated", "auth status");
  if (active.state !== "success") throw new GhInvocationError("credential_invalid", "auth status");
  const loginOutput = await runGh(runner, ["api", "user", "--jq", ".login", "--hostname", HOST]);
  const login = loginOutput.trim();
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u.test(login)) {
    throw new GhInvocationError("credential_invalid", "api user");
  }
  return login;
}

async function getRepository(runner: GhRunner, repository: string) {
  const value = await ghJson<Record<string, unknown>>(runner, `repos/${repository}`);
  if (!isRecord(value) || value.full_name !== repository || typeof value.default_branch !== "string") {
    throw new Error("GitHub repository identity response is invalid");
  }
  const permissions = isRecord(value.permissions) ? value.permissions : {};
  const parent = isRecord(value.parent) && typeof value.parent.full_name === "string" ? value.parent.full_name : null;
  return {
    full_name: value.full_name,
    default_branch: value.default_branch,
    archived: value.archived === true,
    disabled: value.disabled === true,
    fork: value.fork === true,
    parent,
    permissions,
  };
}

async function optionalRepository(runner: GhRunner, repository: string) {
  const value = await optionalGhJson<Record<string, unknown>>(runner, `repos/${repository}`);
  return value ? getRepository(runner, repository) : undefined;
}

async function getBaseIdentity(runner: GhRunner, repository: string) {
  const ref = await ghJson<Record<string, unknown>>(runner, `repos/${repository}/git/ref/heads/${BASE_BRANCH}`);
  const object = isRecord(ref.object) ? ref.object : undefined;
  const baseCommit = object && typeof object.sha === "string" ? object.sha : "";
  if (!GIT_HASH.test(baseCommit)) throw new Error("GitHub base ref did not return a commit SHA");
  const commit = await ghJson<Record<string, unknown>>(runner, `repos/${repository}/git/commits/${baseCommit}`);
  const tree = isRecord(commit.tree) ? commit.tree : undefined;
  const baseTree = tree && typeof tree.sha === "string" ? tree.sha : "";
  if (!GIT_HASH.test(baseTree)) throw new Error("GitHub base commit did not return a tree SHA");
  return { baseCommit, baseTree };
}

async function repositoryPathExists(runner: GhRunner, repository: string, ref: string, filePath: string) {
  const endpoint = `repos/${repository}/contents/${encodeRepositoryPath(filePath)}?ref=${encodeURIComponent(ref)}`;
  return (await optionalGhJson(runner, endpoint)) !== undefined;
}

async function getRepositoryFile(runner: GhRunner, repository: string, ref: string, filePath: string) {
  validatePortablePath(filePath);
  const endpoint = `repos/${repository}/contents/${encodeRepositoryPath(filePath)}?ref=${encodeURIComponent(ref)}`;
  const metadata = await ghJson<Record<string, unknown>>(runner, endpoint);
  if (metadata.type !== "file" || typeof metadata.sha !== "string" || !GIT_HASH.test(metadata.sha)) {
    throw new Error(`GitHub content identity is invalid for ${filePath}`);
  }
  const blob = await ghJson<Record<string, unknown>>(runner, `repos/${repository}/git/blobs/${metadata.sha}`, { timeoutMs: 120_000 });
  if (blob.encoding !== "base64" || typeof blob.content !== "string") throw new Error(`GitHub blob is not base64: ${filePath}`);
  return new Uint8Array(Buffer.from(blob.content.replace(/\s/gu, ""), "base64"));
}

function expectedHeadRepository(login: string, targetRepository: string) {
  const repositoryName = targetRepository.split("/")[1];
  if (!repositoryName) throw new Error("invalid target repository");
  return login.toLocaleLowerCase("en-US") === "jarxunlai" ? targetRepository : `${login}/${repositoryName}`;
}

function requireWritable(metadata: Awaited<ReturnType<typeof getRepository>>) {
  if (metadata.archived || metadata.disabled) throw new Error("GitHub head repository is archived or disabled");
  if (!metadata.permissions.admin && !metadata.permissions.maintain && !metadata.permissions.push) {
    throw new GhInvocationError("insufficient_scope", "repository write permission");
  }
}

async function prepareHead(runner: GhRunner, login: string, targetRepository: string) {
  const headRepository = expectedHeadRepository(login, targetRepository);
  if (headRepository === targetRepository) {
    const metadata = await getRepository(runner, headRepository);
    requireWritable(metadata);
    return { headRepository, forkWillBeCreated: false };
  }
  const metadata = await optionalRepository(runner, headRepository);
  if (!metadata) return { headRepository, forkWillBeCreated: true };
  if (!metadata.fork || metadata.parent?.toLocaleLowerCase("en-US") !== targetRepository.toLocaleLowerCase("en-US")) {
    throw new Error("the expected head repository exists but is not a fork of the Open Figure Modules repository");
  }
  requireWritable(metadata);
  return { headRepository, forkWillBeCreated: false };
}

async function ensureFork(runner: GhRunner, headRepository: string, targetRepository: string, forkWillBeCreated: boolean) {
  if (headRepository === targetRepository) return;
  let metadata = await optionalRepository(runner, headRepository);
  if (!metadata) {
    if (!forkWillBeCreated) throw new Error("Open Figure PR Plan expected an existing fork");
    await ghJson(runner, `repos/${targetRepository}/forks`, { method: "POST", body: { default_branch_only: true } });
    for (let attempt = 0; attempt < 10 && !metadata; attempt += 1) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 1_000));
      metadata = await optionalRepository(runner, headRepository);
    }
  }
  if (!metadata || !metadata.fork || metadata.parent?.toLocaleLowerCase("en-US") !== targetRepository.toLocaleLowerCase("en-US")) {
    throw new Error("GitHub fork was not ready or did not match the Open Figure Modules repository");
  }
  requireWritable(metadata);
}

async function createBlobs(runner: GhRunner, repository: string, files: Map<string, Uint8Array>) {
  const blobs = new Map<string, string>();
  for (const [filePath, bytes] of [...files.entries()].sort(([left], [right]) => compareCanonicalStrings(left, right))) {
    const result = await ghJson<Record<string, unknown>>(runner, `repos/${repository}/git/blobs`, {
      method: "POST",
      body: { content: Buffer.from(bytes).toString("base64"), encoding: "base64" },
      timeoutMs: 120_000,
    });
    if (typeof result.sha !== "string" || !GIT_HASH.test(result.sha) || result.sha !== gitBlobSha(bytes)) {
      throw new Error(`GitHub returned a mismatched blob identity for ${filePath}`);
    }
    blobs.set(filePath, result.sha);
  }
  return blobs;
}

async function createTree(
  runner: GhRunner,
  repository: string,
  baseTree: string,
  blobs: Map<string, string>,
) {
  const tree = await ghJson<Record<string, unknown>>(runner, `repos/${repository}/git/trees`, {
    method: "POST",
    body: {
      base_tree: baseTree,
      tree: [...blobs.entries()].map(([filePath, blobSha]) => ({ path: filePath, mode: "100644", type: "blob", sha: blobSha })),
    },
  });
  if (typeof tree.sha !== "string" || !GIT_HASH.test(tree.sha)) throw new Error("GitHub did not return a tree SHA");
  return tree.sha;
}

async function createCommit(
  runner: GhRunner,
  repository: string,
  message: string,
  tree: string,
  parents: string[],
) {
  const commit = await ghJson<Record<string, unknown>>(runner, `repos/${repository}/git/commits`, {
    method: "POST",
    body: { message, tree, parents },
  });
  if (typeof commit.sha !== "string" || !GIT_HASH.test(commit.sha)) throw new Error("GitHub did not return a commit SHA");
  return commit.sha;
}

function titlesOverlap(candidateTitle: string, moduleTitle: string, moduleTitleEn: string) {
  const haystack = normalizeComparableText(candidateTitle);
  const titles = [moduleTitle, moduleTitleEn].map(normalizeComparableText).filter(Boolean);
  return titles.some((title) => haystack === title || haystack.includes(title) || title.includes(haystack));
}

export function annotateSimilarMatchKind(options: {
  candidate: TemplateCandidate;
  build: OpenFigureModuleBuild;
  figureYa?: CatalogIndex;
  openFigure?: ModuleCatalogIndex;
}): "identity" | "similar" {
  const { candidate, build } = options;
  if (candidate.templateId === build.moduleId) return "identity";
  if (titlesOverlap(candidate.title, build.title, build.titleEn)) return "identity";
  if (candidate.previewSha256 && candidate.previewSha256 === build.previewSha256) return "identity";
  if (candidate.providerId === PERSONAL_MODULE_PROVIDER_ID && options.openFigure) {
    const module = options.openFigure.get(candidate.templateId);
    const code = module?.files.find((file) => file.path === module.canonicalCode);
    if (code?.sha256 === build.canonicalCodeSha256) return "identity";
  }
  if (candidate.providerId === FIGUREYA_PROVIDER_ID && options.figureYa) {
    const module = options.figureYa.get(candidate.templateId);
    if (module?.previewSha256 === build.previewSha256) return "identity";
    if (module && titlesOverlap(module.title, build.title, build.titleEn)) return "identity";
  }
  return "similar";
}

async function assertModulePathAvailable(runner: GhRunner, moduleId: string, baseCommit: string) {
  if (await repositoryPathExists(runner, OPEN_FIGURE_REPOSITORY, baseCommit, `modules/${moduleId}`)) {
    throw new Error(`Open Figure Modules already contains modules/${moduleId} on main`);
  }
  if (await repositoryPathExists(runner, OPEN_FIGURE_REPOSITORY, baseCommit, `modules/${moduleId}/module.yml`)) {
    throw new Error(`Open Figure Modules already contains modules/${moduleId}/module.yml on main`);
  }
  const pulls = await ghJson<unknown[]>(runner, `repos/${OPEN_FIGURE_REPOSITORY}/pulls?state=open&per_page=100`);
  if (!Array.isArray(pulls)) throw new Error("GitHub open pull request list is invalid");
  for (const pull of pulls) {
    if (!isRecord(pull) || typeof pull.number !== "number") continue;
    const files = await ghJson<unknown[]>(runner, `repos/${OPEN_FIGURE_REPOSITORY}/pulls/${pull.number}/files?per_page=100`);
    if (!Array.isArray(files)) continue;
    if (files.some((file) => isRecord(file) && typeof file.filename === "string" && file.filename.startsWith(`modules/${moduleId}/`))) {
      throw new Error(`An open Open Figure Modules PR already contains modules/${moduleId}/: https://github.com/${OPEN_FIGURE_REPOSITORY}/pull/${pull.number}`);
    }
  }
}

function similarSearchInput(build: OpenFigureModuleBuild): SimilarSearchRequest {
  return {
    query: build.searchQuery,
    plotFamily: build.plotFamily,
    language: build.language,
    providerIds: [...OPEN_FIGURE_SEARCH_PROVIDER_IDS],
    limit: 6,
  };
}

function defaultReceiptDirectory() {
  if (process.platform === "win32") {
    const root = process.env.LOCALAPPDATA?.trim();
    return root
      ? path.join(root, "ScientificFigureLibrary", "open-figure-pr-receipts")
      : path.join(os.homedir(), "AppData", "Local", "ScientificFigureLibrary", "open-figure-pr-receipts");
  }
  const root = process.env.XDG_DATA_HOME?.trim() || path.join(os.homedir(), ".local", "share");
  return path.join(root, "scientific-figure-library", "open-figure-pr-receipts");
}

async function readReceipt(receiptDirectory: string, operationId: string) {
  const filePath = path.join(receiptDirectory, `${sha256(operationId)}.json`);
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as OpenFigureReceipt;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("Open Figure PR receipt is unreadable");
  }
}

async function writeReceipt(receiptDirectory: string, receipt: OpenFigureReceipt) {
  await fs.mkdir(receiptDirectory, { recursive: true });
  const target = path.join(receiptDirectory, `${sha256(receipt.operationId)}.json`);
  try {
    await fs.writeFile(target, `${canonicalJson(receipt)}\n`, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await readReceipt(receiptDirectory, receipt.operationId);
    if (!existing || canonicalJson(existing) !== canonicalJson(receipt)) {
      throw new Error("operationId receipt was concurrently bound to a different Open Figure PR result");
    }
  }
}

function branchName(moduleId: string, digest: string) {
  return `sfl/open-figure/${moduleId}/${digest.slice(0, 12)}`;
}

function planWithDigest(plan: Omit<OpenFigurePrPlan, "planDigest">): OpenFigurePrPlan {
  const planDigest = sha256(canonicalJson(plan));
  return { ...plan, planDigest };
}

async function resolvePublished(context: CurrentLibraryContext, selector: LocalPublishedExactSelector) {
  assertLocalPublishedExactSelector(selector);
  const identity = selector.identity;
  const [content, release, history] = await Promise.all([
    context.versionedLibrary.getContent(identity.templateId, identity.revisionId, identity.contentDigest),
    context.versionedLibrary.getRelease(identity.templateId, identity.releaseId),
    context.versionedLibrary.history(identity.templateId),
  ]);
  if (
    !content || !release || release.revisionId !== identity.revisionId ||
    release.contentDigest !== identity.contentDigest ||
    !history.releases.some((item) => item.releaseId === identity.releaseId && item.revisionId === identity.revisionId)
  ) {
    throw new Error("stale or unreachable Local Published release");
  }
  return { content, release };
}

export class OpenFigurePublicationService {
  readonly #plans = new Map<string, { prepared: PreparedPlan; expiresAt: number }>();
  readonly #runner: GhRunner;
  readonly #receiptDirectory: string;
  readonly #now: () => Date;
  readonly #searchSimilar: (request: SimilarSearchRequest) => Promise<SimilarSearchResult>;
  readonly #lookupSearchSession: (resultSetId: string) => SimilarSearchSession | undefined;
  readonly #figureYa: () => Promise<CatalogIndex | undefined>;
  readonly #openFigure: () => Promise<ModuleCatalogIndex | undefined>;
  readonly #currentLibraries: () => Promise<CurrentLibraryContext>;

  constructor(options: {
    currentLibraries: () => Promise<CurrentLibraryContext>;
    searchSimilar: (request: SimilarSearchRequest) => Promise<SimilarSearchResult>;
    lookupSearchSession: (resultSetId: string) => SimilarSearchSession | undefined;
    figureYa?: () => Promise<CatalogIndex | undefined>;
    openFigure?: () => Promise<ModuleCatalogIndex | undefined>;
    ghRunner?: GhRunner;
    receiptDirectory?: string;
    now?: () => Date;
  }) {
    this.#currentLibraries = options.currentLibraries;
    this.#searchSimilar = options.searchSimilar;
    this.#lookupSearchSession = options.lookupSearchSession;
    this.#figureYa = options.figureYa ?? (async () => undefined);
    this.#openFigure = options.openFigure ?? (async () => undefined);
    this.#runner = options.ghRunner ?? createGhCliRunner();
    this.#receiptDirectory = path.resolve(options.receiptDirectory ?? defaultReceiptDirectory());
    this.#now = options.now ?? (() => new Date());
  }

  #prune() {
    const now = this.#now().getTime();
    for (const [key, value] of this.#plans) if (value.expiresAt <= now) this.#plans.delete(key);
    while (this.#plans.size >= PLAN_LIMIT) {
      const first = this.#plans.keys().next().value as string | undefined;
      if (!first) break;
      this.#plans.delete(first);
    }
  }

  async #prepare(selector: LocalPublishedExactSelector): Promise<PreparedPlan> {
    const context = await this.#currentLibraries();
    if (!context.snapshot.writesEnabled) throw new Error("a writable global Library is required to plan an Open Figure PR");
    const marker = await readLibraryRootMarker(context.snapshot.root);
    if (!marker) throw new Error("global Library root marker is missing");
    const { content } = await resolvePublished(context, selector);
    const build = await buildOpenFigureModule({ library: context.versionedLibrary, content });
    const login = await readAuthAccount(this.#runner);
    const target = await getRepository(this.#runner, OPEN_FIGURE_REPOSITORY);
    if (target.default_branch !== BASE_BRANCH || target.archived || target.disabled) {
      throw new Error("Open Figure Modules repository is not writable through main PRs");
    }
    const base = await getBaseIdentity(this.#runner, OPEN_FIGURE_REPOSITORY);
    await assertModulePathAvailable(this.#runner, build.moduleId, base.baseCommit);
    const head = await prepareHead(this.#runner, login, OPEN_FIGURE_REPOSITORY);
    const archive = archiveOpenFigureModule(build.files);
    const searchInput = similarSearchInput(build);
    const similar = await this.#searchSimilar(searchInput);
    const figureYa = await this.#figureYa();
    const openFigure = await this.#openFigure();
    const similarCandidates = similar.candidates.slice(0, 6).map((candidate) => ({
      providerId: candidate.providerId,
      templateId: candidate.templateId,
      title: candidate.title,
      sourceLabel: candidate.sourceLabel,
      retrievalScore: candidate.retrievalScore,
      matchKind: annotateSimilarMatchKind({ candidate, build, figureYa, openFigure }),
      ...(candidate.previewSha256 ? { previewSha256: candidate.previewSha256 } : {}),
    }));
    if (similarCandidates.some((item) => item.providerId === LOCAL_LIBRARY_PROVIDER_ID)) {
      throw new Error("Open Figure similar search included Local Published");
    }
    const moduleFiles = new Map(build.files.map((file) => [`modules/${build.moduleId}/${file.path}`, file.bytes]));
    const generatedAt = this.#now().toISOString();
    const fileList = [
      ...[...moduleFiles.entries()].map(([filePath, bytes]) => ({
        path: filePath,
        bytes: bytes.byteLength,
        sha256: sha256(bytes),
        change: "add" as const,
      })),
      {
        path: `archives/${build.moduleId}.zip`,
        bytes: archive.bytes.byteLength,
        sha256: archive.sha256,
        change: "add" as const,
      },
      {
        path: "catalog/archive-manifest.json",
        bytes: 0,
        sha256: "pending_source_commit",
        change: "modify" as const,
      },
    ].sort((left, right) => compareCanonicalStrings(left.path, right.path));
    const unsigned: Omit<OpenFigurePrPlan, "planDigest"> = {
      schema: "figure-library.open-figure-pr-plan.v1",
      providerId: LOCAL_LIBRARY_PROVIDER_ID,
      exactSelector: selector,
      moduleId: build.moduleId,
      title: build.title,
      titleEn: build.titleEn,
      titleEnDerived: build.titleEnDerived,
      expectedGithubLogin: login,
      target: {
        repository: OPEN_FIGURE_REPOSITORY,
        base: BASE_BRANCH,
        ...base,
      },
      head: {
        repository: head.headRepository,
        branch: branchName(build.moduleId, archive.sha256),
        forkWillBeCreated: head.forkWillBeCreated,
      },
      similarSearch: {
        query: searchInput.query,
        providerIds: searchInput.providerIds,
        plotFamily: searchInput.plotFamily,
        language: searchInput.language,
        limit: searchInput.limit,
        queryDigest: similar.queryDigest,
      },
      similarCandidates,
      similarReviewRequired: similarCandidates.length > 0,
      excludedLogicalPaths: build.excludedLogicalPaths,
      files: fileList,
      archive: { path: `archives/${build.moduleId}.zip`, bytes: archive.bytes.byteLength, sha256: archive.sha256 },
      pullRequest: {
        title: `feat(modules): add ${build.moduleId}`,
        body: [
          `Add Open Figure Modules submission \`${build.moduleId}\` (\`${build.title}\`).`,
          "",
          build.titleEnDerived ? `English title was derived from the module ID: \`${build.titleEn}\`.` : `English title: ${build.titleEn}`,
          "",
          "Source/reference images, PDFs, evidence, receipts, and Local Library state are excluded.",
          "This PR keeps two logical commits (source, then generated archive) and must not be squash-merged.",
          "This tool will never merge the PR. Default search still requires a later bundled snapshot update after merge.",
          "",
          "Retrieval scores of similar candidates are ranking only and are not proof of duplication.",
        ].join("\n"),
      },
      written: false,
    };
    const plan = planWithDigest(unsigned);
    for (const file of plan.files) {
      if (file.sha256 !== "pending_source_commit") assertAllowedOpenFigurePath(file.path, build.moduleId);
    }
    return {
      plan,
      moduleFiles,
      archiveZip: archive.bytes,
      archiveFileList: archive.files,
      generatedAt,
      build,
    };
  }

  async plan(selector: LocalPublishedExactSelector) {
    const prepared = await this.#prepare(selector);
    this.#prune();
    this.#plans.set(prepared.plan.planDigest, { prepared, expiresAt: this.#now().getTime() + PLAN_TTL_MS });
    return prepared.plan;
  }

  async apply(options: {
    planDigest: string;
    operationId: string;
    similarReviewConfirmed?: boolean;
    expectedResultSetId?: string;
  }) {
    if (!HASH.test(options.planDigest) || !OPERATION_ID.test(options.operationId)) {
      throw new Error("invalid planDigest or operationId");
    }
    const prior = await readReceipt(this.#receiptDirectory, options.operationId);
    if (prior) {
      if (prior.planDigest !== options.planDigest) throw new Error("operationId is already bound to a different Open Figure PR Plan");
      return { outcome: "replayed" as const, receipt: prior };
    }
    this.#prune();
    const cached = this.#plans.get(options.planDigest);
    if (!cached) throw new Error("Open Figure PR Plan expired or belongs to another server process");
    if (cached.prepared.plan.similarReviewRequired) {
      if (options.similarReviewConfirmed !== true || !options.expectedResultSetId) {
        throw new Error("similar Open Figure candidates must be reviewed in the SFL window before Apply");
      }
      const session = this.#lookupSearchSession(options.expectedResultSetId);
      if (!session) throw new Error("expectedResultSetId is not a current similar-search result set");
      if (session.queryDigest !== cached.prepared.plan.similarSearch.queryDigest) {
        throw new Error("similar-search result set does not match the reviewed Open Figure Plan");
      }
      const expected = [...cached.prepared.plan.similarSearch.providerIds].sort();
      const actual = [...session.providerIds].sort();
      if (canonicalJson(expected) !== canonicalJson(actual)) {
        throw new Error("similar-search providers do not match the reviewed Open Figure Plan");
      }
      if (actual.includes(LOCAL_LIBRARY_PROVIDER_ID)) {
        throw new Error("similar-search result set included Local Published");
      }
    }
    const rebuilt = await this.#prepare(cached.prepared.plan.exactSelector);
    const comparable = (plan: OpenFigurePrPlan) => canonicalJson({
      ...plan,
      head: { ...plan.head, forkWillBeCreated: false },
      planDigest: "",
    });
    if (comparable(cached.prepared.plan) !== comparable(rebuilt.plan)) {
      throw new Error("GitHub account, permissions, base, source, or proposed files changed after planning; create a new Plan");
    }
    const login = await readAuthAccount(this.#runner);
    if (login !== rebuilt.plan.expectedGithubLogin) throw new Error("GitHub login changed after planning");
    const created = await this.#createPullRequest(cached.prepared, rebuilt);
    const receipt: OpenFigureReceipt = {
      schema: RECEIPT_SCHEMA,
      operationId: options.operationId,
      planDigest: options.planDigest,
      login,
      targetRepository: OPEN_FIGURE_REPOSITORY,
      headRepository: rebuilt.plan.head.repository,
      branch: rebuilt.plan.head.branch,
      sourceCommit: created.sourceCommit,
      archiveCommit: created.archiveCommit,
      pullRequestNumber: created.number,
      pullRequestUrl: created.url,
      recordedAt: this.#now().toISOString(),
    };
    await writeReceipt(this.#receiptDirectory, receipt);
    return { outcome: created.replayed ? "replayed" as const : "applied" as const, receipt };
  }

  async #createPullRequest(cached: PreparedPlan, rebuilt: PreparedPlan) {
    const plan = rebuilt.plan;
    const currentBase = await getBaseIdentity(this.#runner, OPEN_FIGURE_REPOSITORY);
    if (currentBase.baseCommit !== plan.target.baseCommit || currentBase.baseTree !== plan.target.baseTree) {
      throw new Error("GitHub target base changed after planning");
    }
    await assertModulePathAvailable(this.#runner, plan.moduleId, currentBase.baseCommit);
    await ensureFork(this.#runner, plan.head.repository, OPEN_FIGURE_REPOSITORY, cached.plan.head.forkWillBeCreated);
    const refEndpoint = `repos/${plan.head.repository}/git/ref/heads/${plan.head.branch}`;
    const existingRef = await optionalGhJson<Record<string, unknown>>(this.#runner, refEndpoint);
    if (existingRef) {
      const object = isRecord(existingRef.object) ? existingRef.object : {};
      const commitSha = typeof object.sha === "string" ? object.sha : "";
      const existing = await this.#findExistingPr(plan, commitSha);
      if (!existing) throw new Error("Open Figure branch exists but no matching PR was found");
      return { ...existing, sourceCommit: existing.sourceCommit, archiveCommit: commitSha, replayed: true };
    }
    const moduleBlobs = await createBlobs(this.#runner, plan.head.repository, rebuilt.moduleFiles);
    const sourceTree = await createTree(this.#runner, plan.head.repository, plan.target.baseTree, moduleBlobs);
    const sourceCommit = await createCommit(
      this.#runner,
      plan.head.repository,
      `feat(modules): add ${plan.moduleId}\n\nSFL-Plan-Digest: ${plan.planDigest}`,
      sourceTree,
      [plan.target.baseCommit],
    );
    let priorManifest: {
      schema: string;
      providerId: string;
      repository: string;
      generatedAt: string;
      entries: Array<Record<string, unknown>>;
    } | undefined;
    try {
      const bytes = await getRepositoryFile(this.#runner, OPEN_FIGURE_REPOSITORY, plan.target.baseCommit, "catalog/archive-manifest.json");
      priorManifest = JSON.parse(Buffer.from(bytes).toString("utf8")) as typeof priorManifest;
    } catch (error) {
      if (!(error instanceof GhInvocationError) || error.kind !== "not_found") {
        if (!(error instanceof Error && /invalid for catalog\/archive-manifest|not found|GitHub content identity/iu.test(error.message))) {
          // Missing manifest is allowed for an empty repository; any other parse error is fatal after a successful read.
        }
      }
    }
    const preserved = Array.isArray(priorManifest?.entries)
      ? priorManifest.entries.filter((entry) => isRecord(entry) && entry.moduleId !== plan.moduleId)
      : [];
    const manifest = {
      schema: OPEN_FIGURE_ARCHIVE_MANIFEST_SCHEMA,
      providerId: OPEN_FIGURE_PROVIDER_ID,
      repository: OPEN_FIGURE_REPOSITORY,
      generatedAt: rebuilt.generatedAt,
      entries: [
        ...preserved,
        {
          moduleId: plan.moduleId,
          file: `archives/${plan.moduleId}.zip`,
          bytes: rebuilt.archiveZip.byteLength,
          sha256: sha256(rebuilt.archiveZip),
          files: rebuilt.archiveFileList,
          sourceCommit,
        },
      ].sort((left, right) => compareCanonicalStrings(String(left.moduleId), String(right.moduleId))),
    };
    const archiveFiles = new Map<string, Uint8Array>([
      [`archives/${plan.moduleId}.zip`, rebuilt.archiveZip],
      ["catalog/archive-manifest.json", new Uint8Array(Buffer.from(stableJson(manifest), "utf8"))],
    ]);
    const archiveBlobs = await createBlobs(this.#runner, plan.head.repository, archiveFiles);
    const archiveTree = await createTree(this.#runner, plan.head.repository, sourceTree, archiveBlobs);
    const archiveCommit = await createCommit(
      this.#runner,
      plan.head.repository,
      `build(archives): add ${plan.moduleId} archive\n\nSFL-Plan-Digest: ${plan.planDigest}`,
      archiveTree,
      [sourceCommit],
    );
    await ghJson(this.#runner, `repos/${plan.head.repository}/git/refs`, {
      method: "POST",
      body: { ref: `refs/heads/${plan.head.branch}`, sha: archiveCommit },
    });
    const owner = plan.head.repository.split("/")[0];
    const created = await ghJson<Record<string, unknown>>(this.#runner, `repos/${OPEN_FIGURE_REPOSITORY}/pulls`, {
      method: "POST",
      body: {
        title: plan.pullRequest.title,
        body: `${plan.pullRequest.body}\n\nSFL-Plan-Digest: ${plan.planDigest}`,
        head: `${owner}:${plan.head.branch}`,
        base: BASE_BRANCH,
        maintainer_can_modify: false,
      },
    });
    if (
      typeof created.number !== "number" || !Number.isSafeInteger(created.number) || created.number <= 0 ||
      created.html_url !== `https://github.com/${OPEN_FIGURE_REPOSITORY}/pull/${created.number}`
    ) throw new Error("GitHub did not return a pull request identity");
    return {
      number: created.number,
      url: String(created.html_url),
      sourceCommit,
      archiveCommit,
      replayed: false,
    };
  }

  async #findExistingPr(plan: OpenFigurePrPlan, archiveCommit: string) {
    const owner = plan.head.repository.split("/")[0];
    const endpoint = `repos/${OPEN_FIGURE_REPOSITORY}/pulls?state=all&head=${encodeURIComponent(`${owner}:${plan.head.branch}`)}&base=${BASE_BRANCH}`;
    const values = await ghJson<unknown[]>(this.#runner, endpoint);
    if (!Array.isArray(values)) throw new Error("GitHub pull request lookup response is invalid");
    const found = values.find((value) => isRecord(value) && typeof value.body === "string" && value.body.includes(plan.planDigest));
    if (!isRecord(found)) return undefined;
    if (typeof found.number !== "number" || found.html_url !== `https://github.com/${OPEN_FIGURE_REPOSITORY}/pull/${found.number}`) {
      throw new Error("GitHub pull request identity response is invalid");
    }
    const commit = await ghJson<Record<string, unknown>>(this.#runner, `repos/${plan.head.repository}/git/commits/${archiveCommit}`);
    const parents = Array.isArray(commit.parents) ? commit.parents : [];
    const sourceCommit = isRecord(parents[0]) && typeof parents[0].sha === "string" ? parents[0].sha : "";
    return { number: found.number, url: String(found.html_url), sourceCommit, archiveCommit };
  }
}

function toolFailure(prefix: string, error: unknown): CallToolResult {
  if (error instanceof GhInvocationError) {
    const nextAction = ["cli_missing", "not_authenticated", "credential_invalid", "insufficient_scope"].includes(error.kind)
      ? "ask_user"
      : error.kind === "conflict"
        ? "create_new_plan"
        : "none";
    return response(envelope(error.kind === "conflict" ? "conflict" : "blocked", `github_${error.kind}`, `${prefix}: ${error.message}`, nextAction));
  }
  const message = error instanceof Error ? error.message : String(error);
  const conflict = /already exists|stale|changed after planning|does not match|similar/iu.test(message);
  return response(
    envelope(conflict ? "conflict" : "failed", conflict ? "open_figure_pr_blocked" : "open_figure_pr_failed", `${prefix}: ${message}`, conflict ? "create_new_plan" : "none"),
  );
}

const ExactSelectorSchema = z.record(z.string(), z.unknown());
const PlanInput = z.object({
  providerId: z.literal(LOCAL_LIBRARY_PROVIDER_ID),
  exactSelector: ExactSelectorSchema,
});
const ApplyInput = z.object({
  planDigest: z.string().regex(HASH),
  operationId: z.string().regex(OPERATION_ID),
  similarReviewConfirmed: z.boolean().optional(),
  expectedResultSetId: z.string().min(1).max(256).optional(),
});

export function registerOpenFigurePrTools(options: {
  server: McpServer;
  currentLibraries: () => Promise<CurrentLibraryContext>;
  searchSimilar: (request: SimilarSearchRequest) => Promise<SimilarSearchResult>;
  lookupSearchSession: (resultSetId: string) => SimilarSearchSession | undefined;
  figureYa?: () => Promise<CatalogIndex | undefined>;
  openFigure?: () => Promise<ModuleCatalogIndex | undefined>;
  ghRunner?: GhRunner;
  receiptDirectory?: string;
  now?: () => Date;
}) {
  const service = new OpenFigurePublicationService(options);
  options.server.registerTool(
    "figure_library_plan_open_figure_module_pr",
    {
      title: "Plan an Open Figure Modules pull request",
      description:
        "Sanitize one exact Local Published Release into an Open Figure module, search FigureYa and Open Figure Modules for similar figures, and show a GitHub PR Plan without writing or merging. Path collisions fail closed. Similar hits require user review in the SFL window before Apply.",
      inputSchema: PlanInput.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (input): Promise<CallToolResult> => {
      try {
        const exactSelector = input.exactSelector as unknown as LocalPublishedExactSelector;
        assertLocalPublishedExactSelector(exactSelector);
        const plan = await service.plan(exactSelector);
        const nextAction = plan.similarReviewRequired ? "ask_user" : "apply_confirmed_plan";
        return response(
          envelope(
            "needs_user_confirmation",
            plan.similarReviewRequired ? "open_figure_similar_review_required" : "open_figure_pr_plan_ready",
            plan.similarReviewRequired
              ? "Similar FigureYa or Open Figure Modules candidates were found. Show them in the SFL window, then Apply only after the user confirms they are not duplicates."
              : "No similar FigureYa or Open Figure Modules candidates were found. Review the PR Plan; this call wrote nothing.",
            nextAction,
            plan.similarReviewRequired ? ["similarCandidatesReviewed"] : undefined,
          ),
          { plan },
          [
            `PLAN_DIGEST: ${plan.planDigest}`,
            `MODULE_ID: ${plan.moduleId}`,
            `TARGET: ${plan.target.repository}`,
            `SIMILAR_COUNT: ${plan.similarCandidates.length}`,
            `SIMILAR_QUERY: ${plan.similarSearch.query}`,
            `SIMILAR_PROVIDERS: ${plan.similarSearch.providerIds.join(",")}`,
            `EXCLUDED: ${plan.excludedLogicalPaths.join(", ") || "none"}`,
            "WRITTEN: false",
            "The MCP tool will not merge this pull request.",
          ],
        );
      } catch (error) {
        return toolFailure("Open Figure Modules PR Plan was not created", error);
      }
    },
  );
  options.server.registerTool(
    "figure_library_apply_open_figure_module_pr",
    {
      title: "Apply a reviewed Open Figure Modules pull request",
      description:
        "Re-check GitHub identity, module path collisions, optional similar-search confirmation, and file identities; then create a two-commit PR through the Git Data API. Never merges.",
      inputSchema: ApplyInput.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (input): Promise<CallToolResult> => {
      try {
        const applied = await service.apply(input);
        return response(
          envelope(
            applied.outcome,
            applied.outcome === "applied" ? "open_figure_pr_created" : "open_figure_pr_replayed",
            applied.outcome === "applied"
              ? "The Open Figure Modules pull request was created but not merged. Review it on GitHub; the repository owner decides whether to merge."
              : "The operationId replayed the existing Open Figure Modules pull request; no duplicate PR was created.",
            "none",
          ),
          { receipt: applied.receipt },
          [applied.receipt.pullRequestUrl, "The MCP tool did not merge this pull request."],
        );
      } catch (error) {
        return toolFailure("Open Figure Modules PR Apply was not completed", error);
      }
    },
  );
  return service;
}
