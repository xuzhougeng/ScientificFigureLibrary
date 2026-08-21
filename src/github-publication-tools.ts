import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { unzipSync, zipSync, type UnzipFileInfo, type Zippable } from "fflate";
import { z } from "zod";
import { canonicalJson, compareCanonicalStrings } from "./canonical-json.ts";
import type { ToolOutcomeEnvelope } from "./library-binding-tools.ts";
import { parsePublicProviderCatalog } from "./public-catalog-provider.ts";
import { STRICT_SEMVER } from "./semver.ts";

export const CENTRAL_ARCHIVE_REPOSITORY =
  "jarxunlai/ScientificFigureLibrary-community-archives" as const;
export const CENTRAL_CATALOG_REPOSITORY =
  "jarxunlai/ScientificFigureLibrary-community" as const;
export const CENTRAL_PUBLIC_PROVIDER_ID =
  "io.github.jarxunlai.scientific-figure-community" as const;

const HOST = "github.com" as const;
const BASE_BRANCH = "main" as const;
const ARCHIVE_VALIDATION_WORKFLOW_NAME = "validate-archive-pr" as const;
const ARCHIVE_VALIDATION_WORKFLOW_PATH = ".github/workflows/validate-archive-pr.yml" as const;
const ARCHIVE_VALIDATION_RUN_TITLE_VERSION = "sfl-archive-validation-v2" as const;
const HASH = /^[a-f0-9]{64}$/u;
const GIT_HASH = /^[a-f0-9]{40}$/u;
const TEMPLATE_ID = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/u;
const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const PRIVATE_PATH = /(?:\b[A-Za-z]:[\\/]|\\\\[^\\\s]+\\[^\\\s]+|(?:^|[\s"'`(=])\/(?:Users|home|mnt\/[A-Za-z]|private|var|tmp|etc|opt|root|srv|Volumes)\/)/mu;
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
const PLAN_TTL_MS = 30 * 60 * 1_000;
const PLAN_LIMIT = 64;
const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 128 * 1024 * 1024;
const MAX_SINGLE_FILE_BYTES = 64 * 1024 * 1024;
const MAX_FILES = 10_000;
const MAX_GH_OUTPUT_BYTES = 150 * 1024 * 1024;
const MAX_METADATA_BYTES = 1024 * 1024;
const RECEIPT_SCHEMA = "figure-library.github-publication-pr-receipt.v1" as const;

type PublicationPrAction = "archive" | "catalog";
type GhFailureKind =
  | "cli_missing"
  | "not_authenticated"
  | "credential_invalid"
  | "insufficient_scope"
  | "github_unreachable"
  | "not_found"
  | "conflict"
  | "command_failed";

export interface GhCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  errorCode?: string;
}

export interface GhRunner {
  run(
    args: readonly string[],
    options?: { stdin?: string; timeoutMs?: number },
  ): Promise<GhCommandResult>;
}

export interface GitHubAuthRepositoryStatus {
  repository: string;
  permission: "admin" | "maintain" | "push" | "triage" | "pull" | "none" | "unavailable";
  archived: boolean | null;
  disabled: boolean | null;
}

export interface GitHubAuthStatus {
  schema: "figure-library.github-auth-status.v1";
  status:
    | "authenticated"
    | "cli_missing"
    | "not_authenticated"
    | "credential_invalid"
    | "insufficient_scope"
    | "github_unreachable";
  login: string | null;
  host: typeof HOST;
  repositories: GitHubAuthRepositoryStatus[];
  credentialStorage: "managed_by_github_cli";
  secureStorageVerified: boolean;
  tokenReadBySfl: false;
}

interface PublicationIdentity {
  templateId: string;
  releaseVersion: string;
  contentDigest: string;
}

interface ProposedFile {
  path: string;
  bytes: number;
  sha256: string;
  change: "add" | "modify";
}

interface ArchiveIdentity {
  repository: typeof CENTRAL_ARCHIVE_REPOSITORY;
  commit: string;
  path: string;
  bytes: number;
  sha256: string;
}

export interface GitHubPublicationPrPlan {
  schema: "figure-library.github-publication-pr-plan.v1";
  action: PublicationPrAction;
  expectedGithubLogin: string;
  target: {
    repository: typeof CENTRAL_ARCHIVE_REPOSITORY | typeof CENTRAL_CATALOG_REPOSITORY;
    base: typeof BASE_BRANCH;
    baseCommit: string;
    baseTree: string;
    permission: GitHubAuthRepositoryStatus["permission"];
  };
  head: {
    repository: string;
    branch: string;
    forkWillBeCreated: boolean;
    permission: GitHubAuthRepositoryStatus["permission"] | "fork_creation_required";
  };
  commitMessage: string;
  pullRequest: { title: string; body: string };
  identity: PublicationIdentity;
  files: ProposedFile[];
  archive?: ArchiveIdentity & {
    rawUrl: string;
    archivePullRequest: string;
    validationRun: string;
  };
  source:
    | { kind: "publication_submission"; directory: string; directoryDigest: string }
    | {
        kind: "merged_archive_pr";
        pullRequestNumber: number;
        pullRequestUrl: string;
        mergeCommit: string;
      };
  written: false;
  planDigest: string;
}

interface PreparedPlan {
  plan: GitHubPublicationPrPlan;
  files: Map<string, Uint8Array>;
}

interface PlanRequest {
  action: PublicationPrAction;
  submissionDirectory?: string;
  archivePullRequestNumber?: number;
  expectedTemplateId?: string;
  expectedReleaseVersion?: string;
}

interface GithubPrReceipt {
  schema: typeof RECEIPT_SCHEMA;
  operationId: string;
  planDigest: string;
  action: PublicationPrAction;
  login: string;
  targetRepository: string;
  headRepository: string;
  branch: string;
  commit: string;
  pullRequestNumber: number;
  pullRequestUrl: string;
  recordedAt: string;
}

interface RepositoryMetadata {
  full_name: string;
  default_branch: string;
  archived: boolean;
  disabled: boolean;
  fork: boolean;
  parent: string | null;
  permissions: Record<string, unknown>;
}

interface SubmissionInspection {
  identity: PublicationIdentity;
  submission: Record<string, unknown>;
  template: Record<string, unknown>;
  licenses: Record<string, unknown>;
  renderReceipt: Record<string, unknown>;
  evidence: NormalizedSubmissionEvidence;
  preview: Uint8Array;
  files: Map<string, Uint8Array>;
  directoryDigest: string;
}

type SubmissionFlavor = "publication_export" | "frozen_clean_room_seed";

interface NormalizedPublicMetadata {
  title: string;
  description: string;
  application: string;
  dataProfile: string;
  plotFamily: string;
  language: string;
  tags: string[];
  provenance: Array<{ type: "doi" | "url" | "inspiration" | "note"; value: string }>;
}

interface NormalizedSubmissionEvidence {
  submissionFlavor: SubmissionFlavor;
  /** Only the publication-export contract contains a publisher/login claim. */
  publisherLoginClaim: string | null;
  codePaths: string[];
  inputPaths: string[];
  previewPath: "payload/preview/preview.png";
  metadata: NormalizedPublicMetadata;
}

class GhInvocationError extends Error {
  readonly kind: GhFailureKind;
  readonly operation: string;

  constructor(kind: GhFailureKind, operation: string) {
    super(`GitHub CLI ${operation} failed (${kind})`);
    this.kind = kind;
    this.operation = operation;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sha256(value: Uint8Array | string) {
  return createHash("sha256").update(value).digest("hex");
}

function digest(value: unknown) {
  return sha256(canonicalJson(value));
}

function gitBlobSha(value: Uint8Array) {
  return createHash("sha1")
    .update(`blob ${value.byteLength}\0`, "utf8")
    .update(value)
    .digest("hex");
}

function encodeRepositoryPath(value: string) {
  return value.split("/").map(encodeURIComponent).join("/");
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
  if (
    joined.includes("auth token") || joined.includes("--show-token") ||
    joined.includes("hosts.yml") || joined.includes("--verbose")
  ) throw new Error("forbidden GitHub CLI credential or verbose operation");
  if (args[0] !== "auth" && args[0] !== "api") {
    throw new Error("only official gh auth status and gh api operations are allowed");
  }
  if (args[0] === "auth" && args[1] !== "status") {
    throw new Error("SFL never starts GitHub authentication or reads tokens");
  }
}

/** Spawn the official GitHub CLI directly, without a shell or git remote dependency. */
export function createGhCliRunner(): GhRunner {
  return {
    async run(args, options = {}) {
      assertSafeGhArguments(args);
      return await new Promise<GhCommandResult>((resolve) => {
        const child = spawn("gh", [...args], {
          shell: false,
          windowsHide: true,
          cwd: os.tmpdir(),
          stdio: ["pipe", "pipe", "pipe"],
          env: process.env,
        });
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let total = 0;
        let settled = false;
        let timer: NodeJS.Timeout | undefined;
        const finish = (result: GhCommandResult) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          resolve(result);
        };
        child.on("error", (error: NodeJS.ErrnoException) => {
          finish({ exitCode: -1, stdout: "", stderr: "", errorCode: error.code });
        });
        const collect = (target: Buffer[], chunk: Buffer) => {
          total += chunk.byteLength;
          if (total > MAX_GH_OUTPUT_BYTES) {
            child.kill();
            finish({ exitCode: -1, stdout: "", stderr: "", errorCode: "OUTPUT_LIMIT" });
          } else target.push(chunk);
        };
        child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
        child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
        child.on("close", (code) => {
          finish({
            exitCode: code ?? -1,
            stdout: Buffer.concat(stdout).toString("utf8"),
            stderr: Buffer.concat(stderr).toString("utf8"),
          });
        });
        timer = setTimeout(() => {
          child.kill();
          finish({ exitCode: -1, stdout: "", stderr: "", errorCode: "TIMEOUT" });
        }, options.timeoutMs ?? 60_000);
        child.stdin.end(options.stdin, "utf8");
      });
    },
  };
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
    if (
      !segment || segment === "." || segment === ".." || segment.normalize("NFC") !== segment ||
      /[<>:"|?*]/u.test(segment) || segment.endsWith(".") || segment.endsWith(" ") ||
      WINDOWS_RESERVED.test(segment)
    ) throw new Error(`invalid portable path segment in ${value}`);
  }
  return value;
}

function assertAllowedRepositoryFile(action: PublicationPrAction, value: string) {
  validatePortablePath(value);
  if (/^(?:\.github|workflows?|ci|polic(?:y|ies))(?:\/|$)/iu.test(value)) {
    throw new Error(`publication PR may not modify workflow, CI, or policy files: ${value}`);
  }
  if (action === "archive") {
    if (!/^archives\/[a-z0-9._-]+\/[0-9A-Za-z.+-]+\/[a-z0-9._-]+-[0-9A-Za-z.+-]+\.zip$/u.test(value)) {
      throw new Error(`archive PR path is outside the immutable archive namespace: ${value}`);
    }
    return;
  }
  if (!(
    /^catalog\/entries\/[a-z0-9._-]+\/[0-9A-Za-z.+-]+\.json$/u.test(value) ||
    /^thumbs\/[a-z0-9._-]+\/[0-9A-Za-z.+-]+\.png$/u.test(value) ||
    /^reviews\/[a-z0-9._-]+\/[0-9A-Za-z.+-]+\.md$/u.test(value) ||
    value === "catalog/catalog.json" || value === "catalog/preview-manifest.json"
  )) throw new Error(`catalog PR path is outside the fixed review shape: ${value}`);
}

function parseJsonFile(files: Map<string, Uint8Array>, name: string) {
  const bytes = files.get(name);
  if (!bytes) throw new Error(`submission is missing ${name}`);
  if (bytes.byteLength > MAX_METADATA_BYTES) throw new Error(`submission metadata exceeds 1 MiB: ${name}`);
  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    if (!isRecord(value)) throw new Error("not an object");
    return value;
  } catch {
    throw new Error(`submission contains invalid UTF-8 JSON: ${name}`);
  }
}

interface FileIdentity {
  path: string;
  bytes: number;
  sha256: string;
}

function parseInventory(files: Map<string, Uint8Array>, identities: Map<string, FileIdentity>) {
  const bytes = files.get("inventory.jsonl");
  if (!bytes) throw new Error("submission is missing inventory.jsonl");
  if (bytes.byteLength > MAX_METADATA_BYTES) throw new Error("submission inventory exceeds 1 MiB");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("submission inventory is not UTF-8");
  }
  const entries = text.split(/\r?\n/u).filter(Boolean).map((line) => {
    const value = JSON.parse(line) as unknown;
    if (
      !isRecord(value) || typeof value.path !== "string" ||
      !Number.isSafeInteger(value.bytes) || Number(value.bytes) < 0 ||
      typeof value.sha256 !== "string" || !HASH.test(value.sha256)
    ) throw new Error("submission inventory contains an invalid entry");
    return { path: validatePortablePath(value.path), bytes: Number(value.bytes), sha256: value.sha256 };
  });
  const names = entries.map((item) => item.path);
  const sorted = [...names].sort(compareCanonicalStrings);
  if (canonicalJson(names) !== canonicalJson(sorted) || new Set(names).size !== names.length) {
    throw new Error("submission inventory must be unique and canonically ordered");
  }
  const expectedNames = [...files.keys()].filter((name) => name !== "inventory.jsonl").sort(compareCanonicalStrings);
  if (canonicalJson(names) !== canonicalJson(expectedNames)) {
    throw new Error("submission inventory does not cover exactly every payload file");
  }
  for (const item of entries) {
    const identity = identities.get(item.path)!;
    if (identity.bytes !== item.bytes || identity.sha256 !== item.sha256) {
      throw new Error(`submission inventory identity mismatch: ${item.path}`);
    }
  }
}

function assertNoPrivatePathLeaks(files: Map<string, Uint8Array>) {
  const textual = new Set([".json", ".jsonl", ".md", ".txt", ".r", ".csv", ".tsv", ".yml", ".yaml"]);
  for (const [name, bytes] of files) {
    if (!textual.has(path.posix.extname(name).toLocaleLowerCase("en-US"))) continue;
    if (bytes.byteLength > MAX_METADATA_BYTES) throw new Error(`public text payload exceeds 1 MiB: ${name}`);
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error(`public text payload is not valid UTF-8: ${name}`);
    }
    if (PRIVATE_PATH.test(text)) throw new Error(`submission leaks an absolute/private machine path in ${name}`);
  }
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]) {
  const actual = Object.keys(value).sort(compareCanonicalStrings);
  const wanted = [...expected].sort(compareCanonicalStrings);
  return canonicalJson(actual) === canonicalJson(wanted);
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[], label: string) {
  if (!hasExactKeys(value, expected)) throw new Error(`${label} does not match its fixed v1 shape`);
}

function requiredText(value: unknown, label: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be non-empty text`);
  return value.trim();
}

function sameStringSet(left: readonly string[], right: readonly string[]) {
  const normalizedLeft = [...new Set(left)].sort(compareCanonicalStrings);
  const normalizedRight = [...new Set(right)].sort(compareCanonicalStrings);
  return canonicalJson(normalizedLeft) === canonicalJson(normalizedRight);
}

function pathArray(value: unknown, label: string, requireCanonicalOrder = true) {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} must be a non-empty path array`);
  const paths = value.map((item) => {
    if (typeof item !== "string") throw new Error(`${label} contains a non-string path`);
    return validatePortablePath(item);
  });
  const sorted = [...paths].sort(compareCanonicalStrings);
  if (new Set(paths).size !== paths.length || (requireCanonicalOrder && canonicalJson(paths) !== canonicalJson(sorted))) {
    throw new Error(`${label} must be unique${requireCanonicalOrder ? " and canonically ordered" : ""}`);
  }
  return sorted;
}

function normalizePublicationMetadata(value: unknown): NormalizedPublicMetadata {
  if (!isRecord(value)) throw new Error("publication export lacks publicMetadata");
  assertExactKeys(value, ["title", "description", "application", "dataProfile", "plotFamily", "language", "tags", "provenance"], "publicMetadata");
  if (!Array.isArray(value.tags) || value.tags.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error("publicMetadata.tags must contain only non-empty strings");
  }
  if (!Array.isArray(value.provenance)) throw new Error("publicMetadata.provenance must be an array");
  const provenance = value.provenance.map((raw) => {
    if (!isRecord(raw)) throw new Error("publicMetadata.provenance contains an invalid entry");
    assertExactKeys(raw, ["type", "value"], "publicMetadata provenance entry");
    if (!(["doi", "url", "inspiration", "note"] as const).includes(raw.type as "doi" | "url" | "inspiration" | "note")) {
      throw new Error("publicMetadata.provenance contains an invalid type");
    }
    return {
      type: raw.type as "doi" | "url" | "inspiration" | "note",
      value: requiredText(raw.value, "publicMetadata provenance value"),
    };
  });
  return {
    title: requiredText(value.title, "publicMetadata.title"),
    description: requiredText(value.description, "publicMetadata.description"),
    application: requiredText(value.application, "publicMetadata.application"),
    dataProfile: requiredText(value.dataProfile, "publicMetadata.dataProfile"),
    plotFamily: requiredText(value.plotFamily, "publicMetadata.plotFamily"),
    language: requiredText(value.language, "publicMetadata.language"),
    tags: [...new Set((value.tags as string[]).map((item) => item.trim()))].sort(compareCanonicalStrings),
    provenance,
  };
}

function seedPlotFamily(keywords: readonly string[]) {
  const normalized = keywords.map((item) => item.toLocaleLowerCase("en-US"));
  if (normalized.some((item) => item === "sankey" || item === "alluvial")) return "sankey";
  if (normalized.some((item) => item === "bar" || item === "bar chart")) return "bar";
  if (normalized.some((item) => item === "scatter")) return "scatter";
  return "scientific-figure-template";
}

function normalizeSeedMetadata(value: unknown, inputPaths: readonly string[]): NormalizedPublicMetadata {
  if (!isRecord(value)) throw new Error("frozen clean-room seed lacks template metadata");
  assertExactKeys(value, [
    "title", "summary", "keywords", "upstreamStatus", "publisherVerified", "curationStatus",
    "renderValidation", "localReviewStatus", "plotExecutionByRecipient", "provenance", "contentDigestAlgorithm",
  ], "frozen clean-room seed metadata");
  if (
    value.upstreamStatus !== "published" || value.publisherVerified !== true || value.curationStatus !== "unreviewed" ||
    value.renderValidation !== "publisher_attested" || value.localReviewStatus !== "not_reviewed" ||
    value.plotExecutionByRecipient !== "not_run" ||
    value.contentDigestAlgorithm !== "sha256(canonical JSON list of code, data, preview, and documentation identities)"
  ) throw new Error("frozen clean-room seed metadata status/provenance contract is invalid");
  if (!Array.isArray(value.keywords) || value.keywords.length === 0 || value.keywords.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error("frozen clean-room seed keywords must be non-empty strings");
  }
  const title = requiredText(value.title, "frozen clean-room seed title");
  const summary = requiredText(value.summary, "frozen clean-room seed summary");
  const provenance = requiredText(value.provenance, "frozen clean-room seed provenance");
  const tags = [...new Set((value.keywords as string[]).map((item) => item.trim()))].sort(compareCanonicalStrings);
  const inputNames = inputPaths.map((item) => path.posix.basename(item)).sort(compareCanonicalStrings);
  return {
    title,
    description: summary,
    application: summary,
    dataProfile: `Synthetic data: ${inputNames.join(", ")}`,
    plotFamily: seedPlotFamily(tags),
    language: "R",
    tags,
    provenance: [{ type: "note", value: provenance }],
  };
}

function assertTimestamp(value: unknown, label: string) {
  if (
    typeof value !== "string" || value.length > 64 ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) throw new Error(`${label} must be a UTC RFC 3339 timestamp`);
}

function recomputePublicationExportContentDigest(
  submission: Record<string, unknown>,
  metadata: NormalizedPublicMetadata,
  render: Record<string, unknown>,
) {
  const assets = (submission.assets as Record<string, unknown>[]).map((asset) => ({
    path: asset.path,
    bytes: asset.bytes,
    sha256: asset.sha256,
    role: asset.role,
    license: asset.license,
    source: asset.source,
  }));
  return digest({
    schema: "figure-library.public-template-content-digest.v1",
    providerId: CENTRAL_PUBLIC_PROVIDER_ID,
    templateId: submission.templateId,
    releaseVersion: submission.releaseVersion,
    metadata,
    licenses: { code: "MIT", content: "CC-BY-4.0", documentation: "CC-BY-4.0" },
    assets,
    render,
  });
}

function recomputeFrozenSeedContentDigest(submission: Record<string, unknown>) {
  const rows = (submission.assets as Record<string, unknown>[])
    .filter((asset) => asset.path !== "payload/template.json")
    .map((asset) => ({ path: asset.path, bytes: asset.bytes, sha256: asset.sha256 }))
    .sort((left, right) => compareCanonicalStrings(String(left.path), String(right.path)));
  // This is the frozen-seed v1 contract already emitted by the clean-room seed builder.
  // Property insertion order is part of that explicitly named legacy JSON-list encoding.
  return sha256(JSON.stringify(rows));
}

function validateSubmissionFiles(files: Map<string, Uint8Array>): SubmissionInspection {
  if (files.size > MAX_FILES) throw new Error("submission contains too many files");
  let total = 0;
  const folded = new Set<string>();
  const identities = new Map<string, FileIdentity>();
  for (const [name, bytes] of files) {
    validatePortablePath(name);
    if (bytes.byteLength > MAX_SINGLE_FILE_BYTES) throw new Error(`submission file exceeds 64 MiB: ${name}`);
    total += bytes.byteLength;
    if (total > MAX_EXPANDED_BYTES) throw new Error("submission exceeds 128 MiB expanded limit");
    const key = name.normalize("NFC").toLocaleLowerCase("en-US");
    if (folded.has(key)) throw new Error(`submission contains a case-fold path collision: ${name}`);
    folded.add(key);
    identities.set(name, { path: name, bytes: bytes.byteLength, sha256: sha256(bytes) });
  }
  const required = [
    "submission.json", "licenses.json", "render-receipt.json", "inventory.jsonl",
    "payload/template.json", "payload/code/render.R", "payload/preview/preview.png",
  ];
  for (const name of required) if (!files.has(name)) throw new Error(`submission is missing ${name}`);
  if (![...files.keys()].some((name) => name.startsWith("payload/data/"))) throw new Error("submission contains no synthetic data");
  parseInventory(files, identities);
  assertNoPrivatePathLeaks(files);
  const submission = parseJsonFile(files, "submission.json");
  const template = parseJsonFile(files, "payload/template.json");
  const licenses = parseJsonFile(files, "licenses.json");
  const renderReceipt = parseJsonFile(files, "render-receipt.json");
  assertExactKeys(template, [
    "schema", "providerId", "templateId", "releaseVersion", "contentDigest", "metadata", "licenses", "render",
    "codeExecutedBySflClient",
  ], "public template archive");
  if (submission.schema !== "figure-library.publication-submission.v1") throw new Error("invalid publication submission schema");
  if (template.schema !== "figure-library.public-template-archive.v1") throw new Error("invalid public template schema");
  if (submission.providerId !== CENTRAL_PUBLIC_PROVIDER_ID || template.providerId !== CENTRAL_PUBLIC_PROVIDER_ID) throw new Error("publication submission provider mismatch");
  const templateId = submission.templateId;
  const releaseVersion = submission.releaseVersion;
  const contentDigest = submission.contentDigest;
  if (typeof templateId !== "string" || !TEMPLATE_ID.test(templateId)) throw new Error("invalid public templateId");
  if (typeof releaseVersion !== "string" || !STRICT_SEMVER.test(releaseVersion)) throw new Error("invalid public releaseVersion");
  if (typeof contentDigest !== "string" || !HASH.test(contentDigest)) throw new Error("invalid public contentDigest");
  if (
    template.templateId !== templateId || template.releaseVersion !== releaseVersion ||
    template.contentDigest !== contentDigest || template.codeExecutedBySflClient !== false
  ) throw new Error("submission and public-template identities disagree");
  if (licenses.schema !== "figure-library.publication-licenses.v1") throw new Error("invalid public submission license schema");
  if (licenses.code !== "MIT" || licenses.syntheticData !== "CC-BY-4.0" || licenses.preview !== "CC-BY-4.0" || licenses.documentation !== "CC-BY-4.0") {
    throw new Error("public submission license declarations are invalid");
  }
  if (!Array.isArray(submission.assets) || submission.assets.length === 0) throw new Error("submission asset declarations are missing");
  const parent = isRecord(submission.parentLocalRelease) ? submission.parentLocalRelease : {};
  if (Object.keys(parent).some((key) => /(?:library|release|revision|operation|receipt|locator|path|directory).*id|(?:path|directory|locator)/iu.test(key))) {
    throw new Error("submission parent provenance exposes a private lifecycle or machine-path field");
  }
  const rights = isRecord(submission.rightsAttestation) ? submission.rightsAttestation : {};
  const exportRights = [
    "publisher", "codeRightsConfirmed", "syntheticDataConfirmed", "generatedPreviewConfirmed",
    "noThirdPartyMediaConfirmed", "immutableReleaseAcknowledged",
  ];
  const seedRights = [
    "codeLicense", "contentLicense", "cleanRoomAuthored", "syntheticDataOnly",
    "previewGeneratedByIncludedCodeAndData", "thirdPartyMediaIncluded", "screenshotsIncluded",
    "paperOrPdfContentIncluded", "patientOrExperimentalDataIncluded",
  ];
  let submissionFlavor: SubmissionFlavor;
  let publisherLoginClaim: string | null;
  if (hasExactKeys(rights, exportRights)) {
    assertExactKeys(submission, [
      "schema", "providerId", "templateId", "releaseVersion", "contentDigest", "parentLocalRelease",
      ...(Object.hasOwn(submission, "publicMetadata") ? ["publicMetadata"] : []),
      "assets", "rightsAttestation", "excludedPrivateState", "createdAt",
    ], "publication-export submission");
    for (const field of exportRights.slice(1)) if (rights[field] !== true) throw new Error(`publication rights attestation is incomplete: ${field}`);
    publisherLoginClaim = requiredText(rights.publisher, "publication publisher attestation");
    submissionFlavor = "publication_export";
    assertExactKeys(parent, ["relationship", "explicitlySelectedAssetsOnly", "privateLifecycleIdentifiersIncluded"], "publication-export parent provenance");
    if (
      parent.relationship !== "sanitized-export-from-local-published" ||
      parent.explicitlySelectedAssetsOnly !== true || parent.privateLifecycleIdentifiersIncluded !== false
    ) throw new Error("publication-export parent provenance is invalid");
    assertExactKeys(licenses, ["schema", "code", "syntheticData", "preview", "documentation"], "publication-export licenses");
  } else if (hasExactKeys(rights, seedRights)) {
    assertExactKeys(submission, [
      "schema", "providerId", "templateId", "releaseVersion", "contentDigest", "parentLocalRelease",
      "assets", "rightsAttestation", "excludedPrivateState", "createdAt",
    ], "frozen clean-room seed submission");
    if (
      rights.codeLicense !== "MIT" || rights.contentLicense !== "CC-BY-4.0" || rights.cleanRoomAuthored !== true ||
      rights.syntheticDataOnly !== true || rights.previewGeneratedByIncludedCodeAndData !== true ||
      rights.thirdPartyMediaIncluded !== false || rights.screenshotsIncluded !== false ||
      rights.paperOrPdfContentIncluded !== false || rights.patientOrExperimentalDataIncluded !== false
    ) throw new Error("frozen clean-room seed rights attestation is invalid");
    publisherLoginClaim = null;
    submissionFlavor = "frozen_clean_room_seed";
    assertExactKeys(parent, ["relationship", "bytesCopied", "metadataCopied", "privateAssetsIncluded"], "frozen-seed parent provenance");
    if (
      parent.relationship !== "design-and-exclusion-audit-only" || parent.bytesCopied !== false ||
      parent.metadataCopied !== false || parent.privateAssetsIncluded !== false
    ) throw new Error("frozen-seed parent provenance is invalid");
    assertExactKeys(licenses, ["schema", "code", "syntheticData", "preview", "documentation", "assetLicenses"], "frozen clean-room seed licenses");
  } else {
    throw new Error("rightsAttestation matches neither the publication-export nor frozen clean-room seed contract");
  }
  assertTimestamp(submission.createdAt, "publication submission createdAt");
  if (
    !Array.isArray(submission.excludedPrivateState) || submission.excludedPrivateState.length === 0 ||
    submission.excludedPrivateState.length > 100 ||
    submission.excludedPrivateState.some((item) => typeof item !== "string" || !item.trim() || item.length > 200)
  ) throw new Error("excludedPrivateState must be a bounded non-empty string array");
  const declared = new Set<string>();
  const declaredByRole = new Map<string, string[]>();
  let previewTrace: string[] = [];
  for (const raw of submission.assets) {
    if (!isRecord(raw) || typeof raw.path !== "string") throw new Error("invalid public asset declaration");
    const name = validatePortablePath(raw.path);
    const role = String(raw.role);
    const baseKeys = ["path", "role", "include", "source", "license", "bytes", "sha256"];
    assertExactKeys(raw, submissionFlavor === "publication_export" && role === "generated_preview" ? [...baseKeys, "generatedFrom"] : baseKeys, "public asset declaration");
    if (declared.has(name) || !files.has(name) || raw.include !== true) throw new Error(`invalid public asset declaration: ${name}`);
    if (["source_reference", "evidence", "screenshot", "paper_pdf"].includes(String(raw.role))) throw new Error(`forbidden public asset role: ${name}`);
    const normalizedRole = submissionFlavor === "frozen_clean_room_seed" && role === "render_code" ? "code" : role;
    const expectedPrefix = normalizedRole === "code" ? "payload/code/"
      : role === "synthetic_data" ? "payload/data/"
        : role === "generated_preview" ? "payload/preview/"
          : role === "documentation" ? "payload/docs/"
            : submissionFlavor === "frozen_clean_room_seed" && role === "metadata" ? "payload/template.json" : "";
    if (!expectedPrefix || !name.startsWith(expectedPrefix)) throw new Error(`public asset role/path mismatch: ${name}`);
    if (raw.license !== (normalizedRole === "code" ? "MIT" : "CC-BY-4.0")) throw new Error(`public asset license mismatch: ${name}`);
    if (submissionFlavor === "publication_export") {
      if (!["code", "synthetic_data", "generated_preview", "documentation"].includes(role)) throw new Error(`unsupported publication-export asset role: ${name}`);
      if (!["clean_room", "generated", "synthetic", "authored"].includes(String(raw.source))) throw new Error(`public asset lacks an allowed source declaration: ${name}`);
    } else {
      const sourceAllowed = role === "metadata" ? raw.source === "authored"
        : role === "render_code" ? raw.source === "clean_room" || raw.source === "authored"
          : role === "synthetic_data" ? raw.source === "synthetic"
            : role === "generated_preview" ? raw.source === "generated"
              : role === "documentation" ? raw.source === "authored" : false;
      if (!sourceAllowed) throw new Error(`frozen clean-room seed asset source/role mismatch: ${name}`);
    }
    const extension = path.posix.extname(name).toLocaleLowerCase("en-US");
    const allowedExtension = normalizedRole === "code" ? [".r", ".py", ".jl", ".m", ".sh"].includes(extension)
      : role === "synthetic_data" ? [".csv", ".tsv", ".json", ".txt"].includes(extension)
        : role === "generated_preview" ? name === "payload/preview/preview.png"
          : role === "documentation" ? [".md", ".txt"].includes(extension)
            : role === "metadata" && name === "payload/template.json";
    if (!allowedExtension) throw new Error(`public asset type is outside the code-generated submission policy: ${name}`);
    const identity = identities.get(name)!;
    if (raw.bytes !== identity.bytes || raw.sha256 !== identity.sha256) throw new Error(`public asset identity mismatch: ${name}`);
    declared.add(name);
    declaredByRole.set(role, [...(declaredByRole.get(role) ?? []), name]);
    if (submissionFlavor === "publication_export" && role === "generated_preview") {
      previewTrace = pathArray(raw.generatedFrom, "generated preview trace", false);
      if (previewTrace.some((item) => !files.has(item))) throw new Error("generated preview trace references an absent file");
    }
  }
  const requiredRoles = submissionFlavor === "publication_export"
    ? ["code", "synthetic_data", "generated_preview", "documentation"]
    : ["metadata", "render_code", "synthetic_data", "generated_preview", "documentation"];
  for (const role of requiredRoles) {
    if (!(declaredByRole.get(role)?.length)) throw new Error(`submission lacks a required public asset role: ${role}`);
  }
  if ((declaredByRole.get("generated_preview")?.length ?? 0) !== 1) throw new Error("submission must contain exactly one generated preview");
  if (submissionFlavor === "frozen_clean_room_seed") {
    if ((declaredByRole.get("metadata")?.length ?? 0) !== 1 || declaredByRole.get("metadata")?.[0] !== "payload/template.json") {
      throw new Error("frozen clean-room seed must declare exactly payload/template.json as metadata");
    }
    if ((declaredByRole.get("render_code")?.length ?? 0) !== 1 || declaredByRole.get("render_code")?.[0] !== "payload/code/render.R") {
      throw new Error("frozen clean-room seed must declare exactly payload/code/render.R as render_code");
    }
    const assetLicenses = isRecord(licenses.assetLicenses) ? licenses.assetLicenses : {};
    const expectedLicensePaths = [...declared].sort(compareCanonicalStrings);
    if (!sameStringSet(Object.keys(assetLicenses), expectedLicensePaths)) throw new Error("frozen clean-room seed assetLicenses inventory mismatch");
    for (const raw of submission.assets) {
      const asset = raw as Record<string, unknown>;
      if (assetLicenses[String(asset.path)] !== asset.license) throw new Error(`frozen clean-room seed asset license mismatch: ${String(asset.path)}`);
    }
  }
  for (const name of files.keys()) {
    if (name.startsWith("payload/") && name !== "payload/template.json" && !declared.has(name)) {
      throw new Error(`submission contains an undeclared payload asset: ${name}`);
    }
  }
  if (renderReceipt.schema !== "figure-library.render-receipt.v1" || renderReceipt.entrypoint !== "payload/code/render.R" || renderReceipt.mediaType !== "image/png") {
    throw new Error("invalid fixed render receipt");
  }
  let codePaths: string[];
  let inputPaths: string[];
  if (submissionFlavor === "publication_export") {
    assertExactKeys(renderReceipt, [
      "schema", "entrypoint", "inputPaths", "codePaths", "previewPath", "previewBytes", "previewSha256",
      "mediaType", "width", "height", "canonicalRgbaSha256", "sourceExecution", "codeExecutedBySflClient",
    ], "publication-export render receipt");
    if (renderReceipt.previewPath !== "payload/preview/preview.png" || renderReceipt.sourceExecution !== "publisher_attested" || renderReceipt.codeExecutedBySflClient !== false) {
      throw new Error("publication-export render receipt authority fields are invalid");
    }
    codePaths = pathArray(renderReceipt.codePaths, "render receipt codePaths");
    inputPaths = pathArray(renderReceipt.inputPaths, "render receipt inputPaths");
    if (!codePaths.includes("payload/code/render.R") || !codePaths.every((item) => declaredByRole.get("code")?.includes(item))) {
      throw new Error("render receipt codePaths do not bind declared code");
    }
    if (!inputPaths.every((item) => declaredByRole.get("synthetic_data")?.includes(item))) throw new Error("render receipt inputPaths do not bind declared synthetic data");
    if (!sameStringSet(previewTrace, [...codePaths, ...inputPaths])) throw new Error("generated preview and render receipt traces disagree");
  } else {
    assertExactKeys(renderReceipt, [
      "schema", "entrypoint", "inputFiles", "code", "output", "publisherRuntime", "reviewedCiRuntime", "randomSeed",
      "previewBytes", "previewSha256", "width", "height", "mediaType", "canonicalRgbaSha256",
      "generatedFromSubmittedCodeAndSyntheticData",
    ], "frozen clean-room seed render receipt");
    if (renderReceipt.generatedFromSubmittedCodeAndSyntheticData !== true) throw new Error("frozen seed preview lacks publisher render provenance");
    const code = isRecord(renderReceipt.code) ? renderReceipt.code : {};
    assertExactKeys(code, ["path", "bytes", "sha256", "license"], "frozen seed render code identity");
    const codePath = typeof code.path === "string" ? validatePortablePath(code.path) : "";
    const codeIdentity = identities.get(codePath);
    if (
      codePath !== "payload/code/render.R" || !declaredByRole.get("render_code")?.includes(codePath) || !codeIdentity ||
      code.bytes !== codeIdentity.bytes || code.sha256 !== codeIdentity.sha256 || code.license !== "MIT"
    ) throw new Error("frozen seed render code identity disagrees with the declared asset");
    if (!Array.isArray(renderReceipt.inputFiles) || renderReceipt.inputFiles.length === 0) throw new Error("frozen seed render receipt has no synthetic inputs");
    inputPaths = [];
    for (const raw of renderReceipt.inputFiles) {
      if (!isRecord(raw)) throw new Error("frozen seed input identity is invalid");
      assertExactKeys(raw, ["path", "bytes", "sha256"], "frozen seed input identity");
      const inputPath = typeof raw.path === "string" ? validatePortablePath(raw.path) : "";
      const inputIdentity = identities.get(inputPath);
      if (!declaredByRole.get("synthetic_data")?.includes(inputPath) || !inputIdentity || raw.bytes !== inputIdentity.bytes || raw.sha256 !== inputIdentity.sha256) {
        throw new Error(`frozen seed input identity disagrees with the declared asset: ${inputPath}`);
      }
      inputPaths.push(inputPath);
    }
    inputPaths = pathArray(inputPaths, "frozen seed input files");
    if (!sameStringSet(inputPaths, declaredByRole.get("synthetic_data") ?? [])) throw new Error("frozen seed receipt must bind every synthetic input");
    const output = isRecord(renderReceipt.output) ? renderReceipt.output : {};
    assertExactKeys(output, ["path", "license"], "frozen seed render output");
    if (output.path !== "payload/preview/preview.png" || output.license !== "CC-BY-4.0") throw new Error("frozen seed render output identity is invalid");
    const publisherRuntime = isRecord(renderReceipt.publisherRuntime) ? renderReceipt.publisherRuntime : {};
    const reviewedRuntime = isRecord(renderReceipt.reviewedCiRuntime) ? renderReceipt.reviewedCiRuntime : {};
    if (publisherRuntime.engine !== "R" || reviewedRuntime.engine !== "R" || reviewedRuntime.networkRequired !== false) {
      throw new Error("frozen seed runtime attestation is invalid");
    }
    codePaths = [codePath];
  }
  const preview = files.get("payload/preview/preview.png")!;
  const png = Buffer.from(preview);
  const previewIdentity = identities.get("payload/preview/preview.png")!;
  if (renderReceipt.previewBytes !== previewIdentity.bytes || renderReceipt.previewSha256 !== previewIdentity.sha256) throw new Error("preview identity disagrees with render receipt");
  if (
    preview.byteLength < 24 || Buffer.compare(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) !== 0 ||
    renderReceipt.width !== png.readUInt32BE(16) || renderReceipt.height !== png.readUInt32BE(20) ||
    typeof renderReceipt.canonicalRgbaSha256 !== "string" || !HASH.test(renderReceipt.canonicalRgbaSha256)
  ) throw new Error("preview dimensions or canonical RGBA identity are invalid");
  const templateLicenses = isRecord(template.licenses) ? template.licenses : {};
  assertExactKeys(templateLicenses, ["code", "syntheticData", "preview", "documentation"], "public template licenses");
  if (templateLicenses.code !== "MIT" || templateLicenses.syntheticData !== "CC-BY-4.0" || templateLicenses.preview !== "CC-BY-4.0" || templateLicenses.documentation !== "CC-BY-4.0") {
    throw new Error("public template licenses are invalid");
  }
  const templateMetadata = isRecord(template.metadata) ? template.metadata : {};
  const templateRender = isRecord(template.render) ? template.render : {};
  let metadata: NormalizedPublicMetadata;
  if (submissionFlavor === "publication_export") {
    const rawPublicMetadata = isRecord(submission.publicMetadata)
      ? submission.publicMetadata
      : {
          title: templateMetadata.title,
          description: templateMetadata.description,
          application: templateMetadata.application,
          dataProfile: templateMetadata.dataProfile,
          plotFamily: templateMetadata.plotFamily,
          language: templateMetadata.language,
          tags: templateMetadata.tags,
          provenance: templateMetadata.provenance,
        };
    metadata = normalizePublicationMetadata(rawPublicMetadata);
    assertExactKeys(templateMetadata, [
      "title", "description", "application", "dataProfile", "plotFamily", "language", "tags", "provenance",
      "upstreamStatus", "publisherVerified", "curationStatus", "renderValidation", "localReviewStatus", "plotExecutionByRecipient",
    ], "publication-export template metadata");
    if (
      templateMetadata.upstreamStatus !== "published" || templateMetadata.publisherVerified !== false || templateMetadata.curationStatus !== "unreviewed" ||
      templateMetadata.renderValidation !== "publisher_attested" || templateMetadata.localReviewStatus !== "not_reviewed" ||
      templateMetadata.plotExecutionByRecipient !== "not_run"
    ) throw new Error("publication-export template status fields are invalid");
    for (const key of ["title", "description", "application", "dataProfile", "plotFamily", "language"] as const) {
      if (templateMetadata[key] !== metadata[key]) throw new Error(`publication-export template metadata disagrees on ${key}`);
    }
    if (canonicalJson(templateMetadata.tags) !== canonicalJson(metadata.tags) ||
      canonicalJson(templateMetadata.provenance) !== canonicalJson(metadata.provenance)) {
      throw new Error("publication-export template tags/provenance disagree with publicMetadata");
    }
    assertExactKeys(templateRender, [
      "entrypoint", "previewPath", "sourceCode", "sourceData", "previewBytes", "previewSha256", "mediaType", "width", "height", "canonicalRgbaSha256",
    ], "publication-export template render identity");
    if (
      templateRender.entrypoint !== "payload/code/render.R" || templateRender.previewPath !== "payload/preview/preview.png" ||
      !sameStringSet(Array.isArray(templateRender.sourceCode) ? templateRender.sourceCode.filter((item): item is string => typeof item === "string") : [], codePaths) ||
      !sameStringSet(Array.isArray(templateRender.sourceData) ? templateRender.sourceData.filter((item): item is string => typeof item === "string") : [], inputPaths) ||
      templateRender.previewBytes !== previewIdentity.bytes || templateRender.previewSha256 !== previewIdentity.sha256 ||
      templateRender.mediaType !== "image/png" || templateRender.width !== renderReceipt.width || templateRender.height !== renderReceipt.height ||
      templateRender.canonicalRgbaSha256 !== renderReceipt.canonicalRgbaSha256
    ) throw new Error("publication-export template render identity disagrees with the receipt");
  } else {
    metadata = normalizeSeedMetadata(templateMetadata, inputPaths);
    assertExactKeys(templateRender, ["entrypoint", "inputDirectory", "outputMediaType", "width", "height", "canonicalRgbaSha256", "clientExecutionRequired"], "frozen seed template render identity");
    if (
      templateRender.entrypoint !== "payload/code/render.R" || templateRender.inputDirectory !== "payload/data" ||
      templateRender.outputMediaType !== "image/png" || templateRender.width !== renderReceipt.width ||
      templateRender.height !== renderReceipt.height || templateRender.canonicalRgbaSha256 !== renderReceipt.canonicalRgbaSha256 ||
      templateRender.clientExecutionRequired !== false
    ) throw new Error("frozen seed template render identity disagrees with the receipt");
  }
  const recomputedContentDigest = submissionFlavor === "publication_export"
    ? recomputePublicationExportContentDigest(submission, metadata, templateRender)
    : recomputeFrozenSeedContentDigest(submission);
  if (recomputedContentDigest !== contentDigest) {
    throw new Error("public contentDigest does not match the actual submitted assets and metadata");
  }
  const inventoryIdentity = [...identities.values()].sort((left, right) => compareCanonicalStrings(left.path, right.path));
  return {
    identity: { templateId, releaseVersion, contentDigest },
    submission,
    template,
    licenses,
    renderReceipt,
    evidence: {
      submissionFlavor,
      publisherLoginClaim,
      codePaths,
      inputPaths,
      previewPath: "payload/preview/preview.png",
      metadata,
    },
    preview,
    files,
    directoryDigest: digest({ schema: "figure-library.publication-directory-identity.v1", files: inventoryIdentity }),
  };
}

async function inspectSubmissionDirectory(directory: string) {
  if (!path.isAbsolute(directory)) throw new Error("submissionDirectory must be an absolute path");
  const root = path.resolve(directory);
  const rootStat = await fs.lstat(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error("submissionDirectory is not a regular directory");
  const files = new Map<string, Uint8Array>();
  const walk = async (current: string, relativeDirectory = ""): Promise<void> => {
    const entries = (await fs.readdir(current, { withFileTypes: true })).sort((left, right) => compareCanonicalStrings(left.name, right.name));
    for (const entry of entries) {
      const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      validatePortablePath(relative);
      const absolute = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`submission contains a symlink: ${relative}`);
      if (entry.isDirectory()) await walk(absolute, relative);
      else if (entry.isFile()) files.set(relative, new Uint8Array(await fs.readFile(absolute)));
      else throw new Error(`submission contains a non-file: ${relative}`);
    }
  };
  await walk(root);
  return validateSubmissionFiles(files);
}

function assertZipCentralDirectorySafe(bytes: Uint8Array) {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let index = buffer.byteLength - 22; index >= Math.max(0, buffer.byteLength - 65_557); index -= 1) {
    if (buffer.readUInt32LE(index) === 0x06054b50) {
      eocd = index;
      break;
    }
  }
  if (eocd < 0) throw new Error("archive has no valid ZIP end record");
  const disk = buffer.readUInt16LE(eocd + 4);
  const centralDisk = buffer.readUInt16LE(eocd + 6);
  const entriesOnDisk = buffer.readUInt16LE(eocd + 8);
  const entries = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  const zipCommentLength = buffer.readUInt16LE(eocd + 20);
  if (
    disk !== 0 || centralDisk !== 0 || entriesOnDisk !== entries || entries === 0xffff ||
    centralOffset === 0xffffffff || centralSize === 0xffffffff
  ) throw new Error("multi-disk and ZIP64 archives are not accepted");
  if (entries > MAX_FILES) throw new Error("archive contains too many entries");
  if (eocd + 22 + zipCommentLength !== buffer.byteLength) throw new Error("archive contains trailing or malformed ZIP data");
  if (centralOffset + centralSize !== eocd) throw new Error("archive central directory is out of bounds");
  let cursor = centralOffset;
  const localSpans: Array<{ start: number; end: number }> = [];
  for (let index = 0; index < entries; index += 1) {
    if (cursor + 46 > eocd || buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error("invalid ZIP central entry");
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const crc = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const expandedSize = buffer.readUInt32LE(cursor + 24);
    const madeBy = buffer.readUInt16LE(cursor + 4) >>> 8;
    const external = buffer.readUInt32LE(cursor + 38);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const startingDisk = buffer.readUInt16LE(cursor + 34);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const centralEnd = cursor + 46 + nameLength + extraLength + commentLength;
    if (
      centralEnd > eocd || startingDisk !== 0 || compressedSize === 0xffffffff ||
      expandedSize === 0xffffffff || localOffset === 0xffffffff
    ) throw new Error("invalid ZIP entry boundaries or ZIP64 fields");
    if ((flags & ~0x0800) !== 0) throw new Error("encrypted, descriptor, or unsupported ZIP flags are not accepted");
    if (method !== 0 && method !== 8) throw new Error("unsupported ZIP compression method");
    if (madeBy === 3 && (((external >>> 16) & 0xf000) === 0xa000)) throw new Error("ZIP symlink entries are not accepted");
    const centralName = buffer.subarray(cursor + 46, cursor + 46 + nameLength);
    let decodedName: string;
    try {
      decodedName = new TextDecoder("utf-8", { fatal: true }).decode(centralName);
    } catch {
      throw new Error("ZIP entry name is not valid UTF-8");
    }
    validatePortablePath(decodedName);
    if (localOffset + 30 > centralOffset || buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error("invalid ZIP local header");
    const localFlags = buffer.readUInt16LE(localOffset + 6);
    const localMethod = buffer.readUInt16LE(localOffset + 8);
    const localCrc = buffer.readUInt32LE(localOffset + 14);
    const localCompressed = buffer.readUInt32LE(localOffset + 18);
    const localExpanded = buffer.readUInt32LE(localOffset + 22);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const localName = buffer.subarray(localOffset + 30, localOffset + 30 + localNameLength);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (
      localFlags !== flags || localMethod !== method || localCrc !== crc ||
      localCompressed !== compressedSize || localExpanded !== expandedSize ||
      localNameLength !== nameLength || !localName.equals(centralName) || dataEnd > centralOffset
    ) throw new Error("ZIP local and central identities disagree");
    localSpans.push({ start: localOffset, end: dataEnd });
    cursor = centralEnd;
  }
  if (cursor !== centralOffset + centralSize) throw new Error("ZIP central directory size mismatch");
  localSpans.sort((left, right) => left.start - right.start);
  for (let index = 1; index < localSpans.length; index += 1) {
    if (localSpans[index]!.start < localSpans[index - 1]!.end) throw new Error("ZIP local entry ranges overlap");
  }
}

function inspectSubmissionArchive(bytes: Uint8Array) {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_ARCHIVE_BYTES) throw new Error("archive exceeds the 100 MiB limit");
  assertZipCentralDirectorySafe(bytes);
  let count = 0;
  let expanded = 0;
  const names = new Set<string>();
  const folded = new Set<string>();
  const extracted = unzipSync(bytes, {
    filter(info: UnzipFileInfo) {
      count += 1;
      if (count > MAX_FILES) throw new Error("archive contains too many entries");
      const name = validatePortablePath(info.name);
      if (name.endsWith("/")) return false;
      if (info.originalSize > MAX_SINGLE_FILE_BYTES) throw new Error(`archive file exceeds 64 MiB: ${name}`);
      expanded += info.originalSize;
      if (expanded > MAX_EXPANDED_BYTES) throw new Error("archive exceeds the 128 MiB expanded limit");
      const fold = name.normalize("NFC").toLocaleLowerCase("en-US");
      if (names.has(name) || folded.has(fold)) throw new Error(`archive path collision: ${name}`);
      names.add(name);
      folded.add(fold);
      return true;
    },
  });
  const files = new Map<string, Uint8Array>();
  for (const [name, content] of Object.entries(extracted)) files.set(validatePortablePath(name), content);
  return validateSubmissionFiles(files);
}

function createDeterministicZip(files: Map<string, Uint8Array>) {
  const zippable: Zippable = Object.create(null) as Zippable;
  // fflate serializes ZIP dates with local Date getters. Construct the reviewed
  // DOS timestamp in the active timezone so every timezone emits 1980-01-01
  // 08:00:00 (time=0x4000, date=0x0021), matching the central Archive policy.
  const canonicalMtime = new Date(1980, 0, 1, 8, 0, 0, 0);
  for (const [name, bytes] of [...files.entries()].sort(([left], [right]) => compareCanonicalStrings(left, right))) {
    zippable[name] = [bytes, { mtime: canonicalMtime, level: 9, os: 0 }];
  }
  const archive = zipSync(zippable, { level: 9 });
  if (archive.byteLength > MAX_ARCHIVE_BYTES) throw new Error("deterministic ZIP exceeds the 100 MiB archive limit");
  return archive;
}

function repositoryPermission(value: RepositoryMetadata): GitHubAuthRepositoryStatus["permission"] {
  if (value.permissions.admin === true) return "admin";
  if (value.permissions.maintain === true) return "maintain";
  if (value.permissions.push === true) return "push";
  if (value.permissions.triage === true) return "triage";
  if (value.permissions.pull === true) return "pull";
  return "none";
}

function parseRepositoryMetadata(value: unknown, expected: string): RepositoryMetadata {
  if (!isRecord(value)) throw new Error("GitHub repository response is invalid");
  const permissions = isRecord(value.permissions) ? value.permissions : {};
  const parent = isRecord(value.parent) && typeof value.parent.full_name === "string" ? value.parent.full_name : null;
  if (
    value.full_name !== expected || typeof value.default_branch !== "string" ||
    typeof value.archived !== "boolean" || typeof value.disabled !== "boolean" || typeof value.fork !== "boolean"
  ) throw new Error("GitHub repository identity response is invalid");
  return {
    full_name: value.full_name,
    default_branch: value.default_branch,
    archived: value.archived,
    disabled: value.disabled,
    fork: value.fork,
    parent,
    permissions,
  };
}

async function getRepository(runner: GhRunner, repository: string) {
  return parseRepositoryMetadata(await ghJson(runner, `repos/${repository}`), repository);
}

async function optionalRepository(runner: GhRunner, repository: string) {
  const value = await optionalGhJson(runner, `repos/${repository}`);
  return value === undefined ? undefined : parseRepositoryMetadata(value, repository);
}

function secureStorageFromTokenSource(value: unknown) {
  return typeof value === "string" && /(?:keyring|keychain|credential manager|wincred|secret service|libsecret)/iu.test(value);
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
  // Keep the identity check equivalent to the documented `gh api user --jq .login`.
  const loginOutput = await runGh(runner, ["api", "user", "--jq", ".login", "--hostname", HOST]);
  const login = loginOutput.trim();
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u.test(login)) {
    throw new GhInvocationError("credential_invalid", "api user");
  }
  if (typeof active.login === "string" && active.login.toLocaleLowerCase("en-US") !== login.toLocaleLowerCase("en-US")) {
    throw new GhInvocationError("credential_invalid", "account identity mismatch");
  }
  return { login, secureStorageVerified: secureStorageFromTokenSource(active.tokenSource) };
}

function authFailureStatus(kind: GhFailureKind): GitHubAuthStatus["status"] {
  if (["cli_missing", "not_authenticated", "credential_invalid", "insufficient_scope", "github_unreachable"].includes(kind)) {
    return kind as GitHubAuthStatus["status"];
  }
  return "github_unreachable";
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

async function getRepositoryFile(runner: GhRunner, repository: string, ref: string, filePath: string) {
  validatePortablePath(filePath);
  const endpoint = `repos/${repository}/contents/${encodeRepositoryPath(filePath)}?ref=${encodeURIComponent(ref)}`;
  const metadata = await ghJson<Record<string, unknown>>(runner, endpoint);
  if (metadata.type !== "file" || typeof metadata.sha !== "string" || !GIT_HASH.test(metadata.sha) || !Number.isSafeInteger(metadata.size)) {
    throw new Error(`GitHub content identity is invalid for ${filePath}`);
  }
  const blob = await ghJson<Record<string, unknown>>(runner, `repos/${repository}/git/blobs/${metadata.sha}`, { timeoutMs: 120_000 });
  if (blob.encoding !== "base64" || typeof blob.content !== "string") throw new Error(`GitHub blob is not base64: ${filePath}`);
  const bytes = new Uint8Array(Buffer.from(blob.content.replace(/\s/gu, ""), "base64"));
  if (bytes.byteLength !== metadata.size || gitBlobSha(bytes) !== metadata.sha) throw new Error(`GitHub blob identity mismatch: ${filePath}`);
  return bytes;
}

async function repositoryPathExists(runner: GhRunner, repository: string, ref: string, filePath: string) {
  const endpoint = `repos/${repository}/contents/${encodeRepositoryPath(filePath)}?ref=${encodeURIComponent(ref)}`;
  return (await optionalGhJson(runner, endpoint)) !== undefined;
}

function branchName(action: PublicationPrAction, identity: PublicationIdentity, contentIdentity: string) {
  const safeSegment = (value: string) => {
    let result = value.replace(/[^A-Za-z0-9._-]/gu, "-").replace(/\.{2,}/gu, ".");
    result = result.replace(/^[.-]+|[.-]+$/gu, "");
    if (!result || result.toLocaleLowerCase("en-US").endsWith(".lock")) result = sha256(value).slice(0, 16);
    return result.slice(0, 80);
  };
  return `sfl/${action}/${safeSegment(identity.templateId)}/${safeSegment(identity.releaseVersion)}/${contentIdentity.slice(0, 12)}`;
}

function proposedFiles(files: Map<string, Uint8Array>, action: PublicationPrAction) {
  return [...files.entries()].map(([filePath, bytes]) => {
    assertAllowedRepositoryFile(action, filePath);
    return {
      path: filePath,
      bytes: bytes.byteLength,
      sha256: sha256(bytes),
      change: (action === "catalog" && ["catalog/catalog.json", "catalog/preview-manifest.json"].includes(filePath) ? "modify" : "add") as "add" | "modify",
    };
  }).sort((left, right) => compareCanonicalStrings(left.path, right.path));
}

function planWithDigest(plan: Omit<GitHubPublicationPrPlan, "planDigest">): GitHubPublicationPrPlan {
  return { ...plan, planDigest: digest(plan) };
}

function archivePath(identity: PublicationIdentity) {
  return `archives/${identity.templateId}/${identity.releaseVersion}/${identity.templateId}-${identity.releaseVersion}.zip`;
}

function utf8Canonical(value: unknown) {
  return new Uint8Array(Buffer.from(`${canonicalJson(value)}\n`, "utf8"));
}

function parseJsonBytes(bytes: Uint8Array, label: string) {
  if (bytes.byteLength > MAX_METADATA_BYTES) throw new Error(`${label} exceeds 1 MiB`);
  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    if (!isRecord(value)) throw new Error("not object");
    return value;
  } catch {
    throw new Error(`invalid ${label} JSON`);
  }
}

function parseBaseCatalog(bytes: Uint8Array) {
  const catalog = parsePublicProviderCatalog(bytes);
  if (
    catalog.provider.providerId !== CENTRAL_PUBLIC_PROVIDER_ID ||
    catalog.provider.catalogRepository !== CENTRAL_CATALOG_REPOSITORY ||
    catalog.provider.archiveRepository !== CENTRAL_ARCHIVE_REPOSITORY
  ) throw new Error("central Catalog base has the wrong Provider identity");
  for (const entry of catalog.entries) {
    if (!TEMPLATE_ID.test(entry.templateId) || !STRICT_SEMVER.test(entry.releaseVersion)) {
      throw new Error("central Catalog base contains a non-canonical template or strict SemVer identity");
    }
  }
  return catalog;
}

function parseBasePreviewManifest(bytes: Uint8Array, catalog: ReturnType<typeof parsePublicProviderCatalog>) {
  const value = parseJsonBytes(bytes, "central preview manifest");
  assertExactKeys(value, ["schema", "providerId", "entries"], "central preview manifest");
  if (
    value.schema !== "figure-library.public-preview-manifest.v1" ||
    value.providerId !== CENTRAL_PUBLIC_PROVIDER_ID || !Array.isArray(value.entries) ||
    value.entries.length !== catalog.entries.length
  ) throw new Error("central Catalog base has an invalid preview manifest");
  const normalized = value.entries.map((raw, index) => {
    if (!isRecord(raw)) throw new Error(`central preview manifest entry ${index} is invalid`);
    assertExactKeys(raw, [
      "templateId", "releaseVersion", "path", "bytes", "sha256", "mediaType", "width", "height", "canonicalRgbaSha256",
    ], `central preview manifest entry ${index}`);
    const entry = catalog.entries[index];
    const expected = entry ? { templateId: entry.templateId, releaseVersion: entry.releaseVersion, ...entry.preview } : undefined;
    if (!expected || canonicalJson(raw) !== canonicalJson(expected)) {
      throw new Error(`central preview manifest entry ${index} differs from Catalog`);
    }
    return expected;
  });
  return { schema: "figure-library.public-preview-manifest.v1", providerId: CENTRAL_PUBLIC_PROVIDER_ID, entries: normalized };
}

function canonicalSortCatalogEntries(entries: unknown[]) {
  return [...entries].sort((left, right) => {
    const leftRecord = isRecord(left) ? left : {};
    const rightRecord = isRecord(right) ? right : {};
    return compareCanonicalStrings(`${String(leftRecord.templateId)}@${String(leftRecord.releaseVersion)}`, `${String(rightRecord.templateId)}@${String(rightRecord.releaseVersion)}`);
  });
}

function deriveCatalogFiles(
  archiveInspection: SubmissionInspection,
  archive: ArchiveIdentity,
  archivePr: { number: number; url: string; mergedAt: string; author: string; validationRun: string },
  catalog: Record<string, unknown>,
  previewManifest: Record<string, unknown>,
) {
  const { identity, evidence, preview } = archiveInspection;
  if (catalog.schema !== "figure-library.public-provider-catalog.v1" || !Array.isArray(catalog.entries)) {
    throw new Error("central Catalog base has an invalid catalog schema");
  }
  const provider = isRecord(catalog.provider) ? catalog.provider : {};
  if (
    provider.providerId !== CENTRAL_PUBLIC_PROVIDER_ID || provider.catalogRepository !== CENTRAL_CATALOG_REPOSITORY ||
    provider.archiveRepository !== CENTRAL_ARCHIVE_REPOSITORY
  ) throw new Error("central Catalog base has the wrong Provider identity");
  if (
    previewManifest.schema !== "figure-library.public-preview-manifest.v1" ||
    previewManifest.providerId !== CENTRAL_PUBLIC_PROVIDER_ID || !Array.isArray(previewManifest.entries)
  ) throw new Error("central Catalog base has an invalid preview manifest");
  if (catalog.entries.some((entry) => isRecord(entry) && entry.templateId === identity.templateId && entry.releaseVersion === identity.releaseVersion)) {
    throw new Error("the immutable public template release already exists in the Catalog");
  }
  const publicMetadata = evidence.metadata;
  const codePaths = evidence.codePaths;
  const inputPaths = evidence.inputPaths;
  const publisherVerified = evidence.submissionFlavor === "publication_export" && evidence.publisherLoginClaim !== null &&
    evidence.publisherLoginClaim.toLocaleLowerCase("en-US") === archivePr.author.toLocaleLowerCase("en-US");
  const renderReceipt = archiveInspection.renderReceipt;
  const previewPath = `thumbs/${identity.templateId}/${identity.releaseVersion}.png`;
  const previewIdentity = {
    path: previewPath,
    bytes: preview.byteLength,
    sha256: sha256(preview),
    mediaType: "image/png",
    width: renderReceipt.width,
    height: renderReceipt.height,
    canonicalRgbaSha256: renderReceipt.canonicalRgbaSha256,
  };
  const entry = {
    schema: "figure-library.public-template-entry.v1",
    providerId: CENTRAL_PUBLIC_PROVIDER_ID,
    templateId: identity.templateId,
    releaseVersion: identity.releaseVersion,
    contentDigest: identity.contentDigest,
    title: publicMetadata.title,
    description: publicMetadata.description,
    search: {
      application: publicMetadata.application,
      dataProfile: publicMetadata.dataProfile,
      plotFamily: publicMetadata.plotFamily,
      language: publicMetadata.language,
      tags: [...new Set(publicMetadata.tags.filter((item): item is string => typeof item === "string"))].sort(compareCanonicalStrings),
      packages: [],
      codeFiles: [...new Set(codePaths)].sort(compareCanonicalStrings),
      inputFiles: [...new Set(inputPaths)].sort(compareCanonicalStrings),
    },
    archive: { repository: archive.repository, commit: archive.commit, path: archive.path, bytes: archive.bytes, sha256: archive.sha256 },
    preview: previewIdentity,
    status: {
      upstreamStatus: "published",
      publisherVerified,
      curationStatus: "curated",
      renderValidation: "ci_rendered",
      localReviewStatus: "not_reviewed",
      plotExecutionByRecipient: "not_run",
    },
    licenses: { code: "MIT", content: "CC-BY-4.0", documentation: "CC-BY-4.0" },
    provenance: publicMetadata.provenance,
  };
  const nextCatalog = { ...catalog, generatedAt: archivePr.mergedAt, entries: canonicalSortCatalogEntries([...catalog.entries, entry]) };
  const nextPreviewManifest = {
    ...previewManifest,
    entries: canonicalSortCatalogEntries([
      ...previewManifest.entries,
      { templateId: identity.templateId, releaseVersion: identity.releaseVersion, ...previewIdentity },
    ]),
  };
  const review = [
    `# Community review: ${identity.templateId} ${identity.releaseVersion}`,
    "",
    `- Archive PR: ${archivePr.url}`,
    `- Archive merge commit: \`${archive.commit}\``,
    `- Archive path: \`${archive.path}\``,
    `- Archive bytes: ${archive.bytes}`,
    `- Archive SHA-256: \`${archive.sha256}\``,
    `- Content digest: \`${identity.contentDigest}\``,
    `- Fixed-render CI run: ${archivePr.validationRun}`,
    `- Publisher identity matched GitHub author: ${publisherVerified ? "yes" : "no"}`,
    "- Archive render gate: passed before manual Archive merge",
    "- Catalog curation gate: pending manual review of this PR",
    "- Recipient local review: not reviewed",
    "- Code execution by SFL client: false",
    "",
  ].join("\n");
  return new Map<string, Uint8Array>([
    [`catalog/entries/${identity.templateId}/${identity.releaseVersion}.json`, utf8Canonical(entry)],
    [previewPath, preview],
    [`reviews/${identity.templateId}/${identity.releaseVersion}.md`, new Uint8Array(Buffer.from(review, "utf8"))],
    ["catalog/catalog.json", utf8Canonical(nextCatalog)],
    ["catalog/preview-manifest.json", utf8Canonical(nextPreviewManifest)],
  ]);
}

function expectedHeadRepository(login: string, targetRepository: string) {
  const repositoryName = targetRepository.split("/")[1];
  if (!repositoryName) throw new Error("invalid target repository");
  return login.toLocaleLowerCase("en-US") === "jarxunlai" ? targetRepository : `${login}/${repositoryName}`;
}

function requireWritableRepository(metadata: RepositoryMetadata) {
  if (metadata.archived || metadata.disabled) throw new Error("GitHub head repository is archived or disabled");
  if (!metadata.permissions.admin && !metadata.permissions.maintain && !metadata.permissions.push) {
    throw new GhInvocationError("insufficient_scope", "repository write permission");
  }
}

function assertPlanInput(request: PlanRequest) {
  if (request.action === "archive") {
    if (
      !request.submissionDirectory || request.archivePullRequestNumber !== undefined ||
      request.expectedTemplateId !== undefined || request.expectedReleaseVersion !== undefined
    ) throw new Error("archive Plan requires only submissionDirectory");
  } else if (
    !Number.isSafeInteger(request.archivePullRequestNumber) || Number(request.archivePullRequestNumber) <= 0 ||
    !request.expectedTemplateId || !TEMPLATE_ID.test(request.expectedTemplateId) ||
    !request.expectedReleaseVersion || !STRICT_SEMVER.test(request.expectedReleaseVersion) || request.submissionDirectory !== undefined
  ) throw new Error("catalog Plan requires archivePullRequestNumber, expectedTemplateId, and expectedReleaseVersion");
}

async function prepareHead(runner: GhRunner, login: string, targetRepository: string) {
  const headRepository = expectedHeadRepository(login, targetRepository);
  if (headRepository === targetRepository) {
    const metadata = await getRepository(runner, headRepository);
    requireWritableRepository(metadata);
    return { headRepository, forkWillBeCreated: false, permission: repositoryPermission(metadata) };
  }
  const metadata = await optionalRepository(runner, headRepository);
  if (!metadata) return { headRepository, forkWillBeCreated: true, permission: "fork_creation_required" as const };
  if (!metadata.fork || metadata.parent?.toLocaleLowerCase("en-US") !== targetRepository.toLocaleLowerCase("en-US")) {
    throw new Error("the expected head repository exists but is not a fork of the central target");
  }
  requireWritableRepository(metadata);
  return { headRepository, forkWillBeCreated: false, permission: repositoryPermission(metadata) };
}

async function buildArchivePlan(runner: GhRunner, submissionDirectory: string): Promise<PreparedPlan> {
  const account = await readAuthAccount(runner);
  const targetMetadata = await getRepository(runner, CENTRAL_ARCHIVE_REPOSITORY);
  if (targetMetadata.default_branch !== BASE_BRANCH || targetMetadata.archived || targetMetadata.disabled) throw new Error("central Archives repository is not writable through main PRs");
  const source = await inspectSubmissionDirectory(submissionDirectory);
  const archive = createDeterministicZip(source.files);
  const archiveDigest = sha256(archive);
  const targetPath = archivePath(source.identity);
  const base = await getBaseIdentity(runner, CENTRAL_ARCHIVE_REPOSITORY);
  if (await repositoryPathExists(runner, CENTRAL_ARCHIVE_REPOSITORY, base.baseCommit, targetPath)) {
    throw new Error("the immutable Archive path already exists");
  }
  const head = await prepareHead(runner, account.login, CENTRAL_ARCHIVE_REPOSITORY);
  const branch = branchName("archive", source.identity, archiveDigest);
  const files = new Map([[targetPath, archive]]);
  const plan = planWithDigest({
    schema: "figure-library.github-publication-pr-plan.v1",
    action: "archive",
    expectedGithubLogin: account.login,
    target: {
      repository: CENTRAL_ARCHIVE_REPOSITORY,
      base: BASE_BRANCH,
      ...base,
      permission: repositoryPermission(targetMetadata),
    },
    head: {
      repository: head.headRepository,
      forkWillBeCreated: head.forkWillBeCreated,
      permission: head.permission,
      branch,
    },
    commitMessage: `feat(archives): add ${source.identity.templateId} ${source.identity.releaseVersion}`,
    pullRequest: {
      title: `archive: ${source.identity.templateId} ${source.identity.releaseVersion}`,
      body: [
        `Submit immutable public-template archive for \`${source.identity.templateId}\` \`${source.identity.releaseVersion}\`.`,
        "", `- Archive SHA-256: \`${archiveDigest}\``, `- Content digest: \`${source.identity.contentDigest}\``,
        "- This PR does not modify workflows, CI, policy, or any existing archive.",
        "- This tool will never merge the PR.",
      ].join("\n"),
    },
    identity: source.identity,
    files: proposedFiles(files, "archive"),
    source: { kind: "publication_submission", directory: path.resolve(submissionDirectory), directoryDigest: source.directoryDigest },
    written: false,
  });
  return { plan, files };
}

interface ArchivePrObservation {
  number: number;
  url: string;
  mergeCommit: string;
  mergedAt: string;
  author: string;
  archivePath: string;
  validationRun: string;
}

async function observeMergedArchivePr(runner: GhRunner, number: number): Promise<ArchivePrObservation> {
  const pr = await ghJson<Record<string, unknown>>(runner, `repos/${CENTRAL_ARCHIVE_REPOSITORY}/pulls/${number}`);
  const base = isRecord(pr.base) ? pr.base : {};
  const baseRepo = isRecord(base.repo) ? base.repo : {};
  const user = isRecord(pr.user) ? pr.user : {};
  const head = isRecord(pr.head) ? pr.head : {};
  const headRepo = isRecord(head.repo) ? head.repo : {};
  if (
    pr.merged !== true || typeof pr.merged_at !== "string" || typeof pr.merge_commit_sha !== "string" || !GIT_HASH.test(pr.merge_commit_sha) ||
    baseRepo.full_name !== CENTRAL_ARCHIVE_REPOSITORY || base.ref !== BASE_BRANCH || typeof pr.html_url !== "string" ||
    typeof headRepo.full_name !== "string" || typeof user.login !== "string" ||
    typeof head.sha !== "string" || !GIT_HASH.test(head.sha) || pr.changed_files !== 1
  ) throw new Error("Catalog Plan requires a merged, one-file central Archive PR into main");
  const mergeCommit = await ghJson<Record<string, unknown>>(
    runner,
    `repos/${CENTRAL_ARCHIVE_REPOSITORY}/git/commits/${pr.merge_commit_sha}`,
  );
  const mergeParents = Array.isArray(mergeCommit.parents) ? mergeCommit.parents : [];
  const mergeBase = isRecord(mergeParents[0]) ? mergeParents[0] : {};
  const mergeHead = isRecord(mergeParents[1]) ? mergeParents[1] : {};
  if (
    mergeParents.length !== 2 || typeof mergeBase.sha !== "string" || !GIT_HASH.test(mergeBase.sha) ||
    typeof mergeHead.sha !== "string" || !GIT_HASH.test(mergeHead.sha) || mergeHead.sha !== head.sha
  ) {
    throw new Error("Catalog Plan requires a two-parent Archive merge commit whose second parent is the exact PR head");
  }
  const expectedValidationRunTitle =
    `${ARCHIVE_VALIDATION_RUN_TITLE_VERSION} base=${mergeBase.sha} head=${head.sha}`;
  const changed = await ghJson<unknown[]>(runner, `repos/${CENTRAL_ARCHIVE_REPOSITORY}/pulls/${number}/files?per_page=100`);
  if (!Array.isArray(changed) || changed.length !== 1 || !isRecord(changed[0]) || changed[0].status !== "added" || typeof changed[0].filename !== "string") {
    throw new Error("merged Archive PR does not have exactly one added archive");
  }
  const filePath = validatePortablePath(changed[0].filename);
  assertAllowedRepositoryFile("archive", filePath);
  let validationRun = "";
  for (let page = 1; page <= 10 && !validationRun; page += 1) {
    const runs = await ghJson<Record<string, unknown>>(
      runner,
      `repos/${CENTRAL_ARCHIVE_REPOSITORY}/actions/workflows/${ARCHIVE_VALIDATION_WORKFLOW_NAME}.yml/runs?event=pull_request_target&status=completed&per_page=100&page=${page}`,
    );
    const values = Array.isArray(runs.workflow_runs) ? runs.workflow_runs : [];
    for (const raw of values) {
      if (!isRecord(raw) || raw.status !== "completed" || raw.conclusion !== "success" || raw.event !== "pull_request_target" ||
        raw.name !== ARCHIVE_VALIDATION_WORKFLOW_NAME || raw.path !== ARCHIVE_VALIDATION_WORKFLOW_PATH ||
        raw.display_title !== expectedValidationRunTitle || raw.head_sha !== head.sha || typeof raw.html_url !== "string") continue;
      const runRepository = isRecord(raw.repository) ? raw.repository : {};
      const runHeadRepository = isRecord(raw.head_repository) ? raw.head_repository : {};
      if (runRepository.full_name !== CENTRAL_ARCHIVE_REPOSITORY || runHeadRepository.full_name !== headRepo.full_name) continue;
      const pulls = Array.isArray(raw.pull_requests) ? raw.pull_requests : [];
      const exact = pulls.some((candidate) => {
        if (!isRecord(candidate) || candidate.number !== number) return false;
        const candidateHead = isRecord(candidate.head) ? candidate.head : {};
        const candidateHeadRepo = isRecord(candidateHead.repo) ? candidateHead.repo : {};
        const candidateBase = isRecord(candidate.base) ? candidate.base : {};
        const candidateBaseRepo = isRecord(candidateBase.repo) ? candidateBase.repo : {};
        const expectedHeadRepoUrl = `https://api.github.com/repos/${headRepo.full_name}`;
        const expectedBaseRepoUrl = `https://api.github.com/repos/${CENTRAL_ARCHIVE_REPOSITORY}`;
        const headRepoMatches = candidateHeadRepo.full_name === headRepo.full_name || candidateHeadRepo.url === expectedHeadRepoUrl;
        const baseRepoMatches = candidateBaseRepo.full_name === CENTRAL_ARCHIVE_REPOSITORY || candidateBaseRepo.url === expectedBaseRepoUrl;
        return candidateHead.sha === head.sha && headRepoMatches && candidateBase.ref === BASE_BRANCH &&
          baseRepoMatches;
      });
      if (exact) {
        validationRun = raw.html_url;
        break;
      }
    }
    if (values.length < 100) break;
  }
  if (!validationRun) {
    throw new Error("merged Archive PR has no successful fixed-render CI run with the exact trusted policy run-name for its exact PR, head repository/commit, and merge-parent base commit");
  }
  return {
    number,
    url: pr.html_url,
    mergeCommit: pr.merge_commit_sha,
    mergedAt: pr.merged_at,
    author: user.login,
    archivePath: filePath,
    validationRun,
  };
}

async function buildCatalogPlan(
  runner: GhRunner,
  archivePullRequestNumber: number,
  expectedTemplateId: string,
  expectedReleaseVersion: string,
): Promise<PreparedPlan> {
  const account = await readAuthAccount(runner);
  const targetMetadata = await getRepository(runner, CENTRAL_CATALOG_REPOSITORY);
  if (targetMetadata.default_branch !== BASE_BRANCH || targetMetadata.archived || targetMetadata.disabled) throw new Error("central Catalog repository is not writable through main PRs");
  const observed = await observeMergedArchivePr(runner, archivePullRequestNumber);
  const archiveBytes = await getRepositoryFile(runner, CENTRAL_ARCHIVE_REPOSITORY, observed.mergeCommit, observed.archivePath);
  const inspection = inspectSubmissionArchive(archiveBytes);
  if (inspection.identity.templateId !== expectedTemplateId || inspection.identity.releaseVersion !== expectedReleaseVersion) {
    throw new Error("merged Archive identity does not match the user's expected template and release");
  }
  if (observed.archivePath !== archivePath(inspection.identity)) throw new Error("merged Archive path disagrees with its immutable internal identity");
  const base = await getBaseIdentity(runner, CENTRAL_CATALOG_REPOSITORY);
  const [catalogBytes, previewManifestBytes] = await Promise.all([
    getRepositoryFile(runner, CENTRAL_CATALOG_REPOSITORY, base.baseCommit, "catalog/catalog.json"),
    getRepositoryFile(runner, CENTRAL_CATALOG_REPOSITORY, base.baseCommit, "catalog/preview-manifest.json"),
  ]);
  const baseCatalog = parseBaseCatalog(catalogBytes);
  const basePreviewManifest = parseBasePreviewManifest(previewManifestBytes, baseCatalog);
  const archive: ArchiveIdentity = {
    repository: CENTRAL_ARCHIVE_REPOSITORY,
    commit: observed.mergeCommit,
    path: observed.archivePath,
    bytes: archiveBytes.byteLength,
    sha256: sha256(archiveBytes),
  };
  const files = deriveCatalogFiles(
    inspection,
    archive,
    {
      number: observed.number,
      url: observed.url,
      mergedAt: observed.mergedAt,
      author: observed.author,
      validationRun: observed.validationRun,
    },
    baseCatalog as unknown as Record<string, unknown>,
    basePreviewManifest as unknown as Record<string, unknown>,
  );
  const head = await prepareHead(runner, account.login, CENTRAL_CATALOG_REPOSITORY);
  const fileIdentity = digest(proposedFiles(files, "catalog"));
  const branch = branchName("catalog", inspection.identity, fileIdentity);
  const rawUrl = `https://raw.githubusercontent.com/${CENTRAL_ARCHIVE_REPOSITORY}/${archive.commit}/${archive.path}`;
  const plan = planWithDigest({
    schema: "figure-library.github-publication-pr-plan.v1",
    action: "catalog",
    expectedGithubLogin: account.login,
    target: {
      repository: CENTRAL_CATALOG_REPOSITORY,
      base: BASE_BRANCH,
      ...base,
      permission: repositoryPermission(targetMetadata),
    },
    head: {
      repository: head.headRepository,
      forkWillBeCreated: head.forkWillBeCreated,
      permission: head.permission,
      branch,
    },
    commitMessage: `feat(catalog): add ${inspection.identity.templateId} ${inspection.identity.releaseVersion}`,
    pullRequest: {
      title: `catalog: ${inspection.identity.templateId} ${inspection.identity.releaseVersion}`,
      body: [
        `Propose central Catalog release for \`${inspection.identity.templateId}\` \`${inspection.identity.releaseVersion}\`.`,
        "", `- Merged Archive PR: ${observed.url}`, `- Archive merge commit: \`${archive.commit}\``,
        `- Successful Archive validation: ${observed.validationRun}`,
        `- Archive SHA-256: \`${archive.sha256}\``, `- Content digest: \`${inspection.identity.contentDigest}\``,
        "- This PR modifies only one entry, one thumbnail, one review, and the two aggregate Catalog files.",
        "- This tool will never merge the PR.",
      ].join("\n"),
    },
    identity: inspection.identity,
    files: proposedFiles(files, "catalog"),
    archive: {
      ...archive,
      rawUrl,
      archivePullRequest: observed.url,
      validationRun: observed.validationRun,
    },
    source: { kind: "merged_archive_pr", pullRequestNumber: observed.number, pullRequestUrl: observed.url, mergeCommit: observed.mergeCommit },
    written: false,
  });
  return { plan, files };
}

function defaultReceiptDirectory() {
  if (process.platform === "win32") {
    const root = process.env.LOCALAPPDATA?.trim();
    return root
      ? path.join(root, "ScientificFigureLibrary", "github-publication-receipts")
      : path.join(os.homedir(), "AppData", "Local", "ScientificFigureLibrary", "github-publication-receipts");
  }
  const root = process.env.XDG_DATA_HOME?.trim() || path.join(os.homedir(), ".local", "share");
  return path.join(root, "scientific-figure-library", "github-publication-receipts");
}

async function readReceipt(receiptDirectory: string, operationId: string) {
  const filePath = path.join(receiptDirectory, `${sha256(operationId)}.json`);
  let value: unknown;
  try {
    value = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("GitHub publication receipt is unreadable");
  }
  if (!isRecord(value)) throw new Error("GitHub publication receipt is corrupt or mismatched");
  assertExactKeys(value, [
    "schema", "operationId", "planDigest", "action", "login", "targetRepository", "headRepository",
    "branch", "commit", "pullRequestNumber", "pullRequestUrl", "recordedAt",
  ], "GitHub publication receipt");
  const expectedTarget = value.action === "archive" ? CENTRAL_ARCHIVE_REPOSITORY
    : value.action === "catalog" ? CENTRAL_CATALOG_REPOSITORY : "";
  const login = typeof value.login === "string" ? value.login : "";
  const pullNumber = Number(value.pullRequestNumber);
  const expectedUrl = `https://github.com/${expectedTarget}/pull/${pullNumber}`;
  if (
    value.schema !== RECEIPT_SCHEMA || value.operationId !== operationId || !OPERATION_ID.test(operationId) ||
    typeof value.planDigest !== "string" || !HASH.test(value.planDigest) ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u.test(login) ||
    value.targetRepository !== expectedTarget ||
    typeof value.headRepository !== "string" || !/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/u.test(value.headRepository) ||
    typeof value.branch !== "string" || !/^sfl\/(?:archive|catalog)\/[A-Za-z0-9._/-]+$/u.test(value.branch) ||
    typeof value.commit !== "string" || !GIT_HASH.test(value.commit) ||
    !Number.isSafeInteger(pullNumber) || pullNumber <= 0 || value.pullRequestUrl !== expectedUrl
  ) {
    throw new Error("GitHub publication receipt is corrupt or mismatched");
  }
  assertTimestamp(value.recordedAt, "GitHub publication receipt recordedAt");
  return value as unknown as GithubPrReceipt;
}

async function writeReceipt(receiptDirectory: string, receipt: GithubPrReceipt) {
  await fs.mkdir(receiptDirectory, { recursive: true });
  const target = path.join(receiptDirectory, `${sha256(receipt.operationId)}.json`);
  try {
    await fs.writeFile(target, `${canonicalJson(receipt)}\n`, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await readReceipt(receiptDirectory, receipt.operationId);
    if (!existing || canonicalJson(existing) !== canonicalJson(receipt)) {
      throw new Error("operationId receipt was concurrently bound to a different GitHub publication result");
    }
  }
}

async function revalidateReceipt(runner: GhRunner, receipt: GithubPrReceipt) {
  const account = await readAuthAccount(runner);
  if (account.login !== receipt.login) {
    throw new Error("GitHub login changed since the publication receipt was recorded");
  }
  const pr = await ghJson<Record<string, unknown>>(
    runner,
    `repos/${receipt.targetRepository}/pulls/${receipt.pullRequestNumber}`,
  );
  const base = isRecord(pr.base) ? pr.base : {};
  const baseRepo = isRecord(base.repo) ? base.repo : {};
  const head = isRecord(pr.head) ? pr.head : {};
  const headRepo = isRecord(head.repo) ? head.repo : {};
  const merged = pr.state === "closed" && pr.merged === true && typeof pr.merged_at === "string";
  const open = pr.state === "open" && pr.merged === false && pr.merged_at === null;
  if (!open && !merged) {
    if (pr.state === "closed" && pr.merged !== true && pr.merged_at == null) {
      throw new Error("the receipt-bound publication PR was closed without merge and cannot be replayed");
    }
    throw new Error("receipt-bound GitHub pull request state is invalid for replay");
  }
  if (
    pr.number !== receipt.pullRequestNumber || pr.html_url !== receipt.pullRequestUrl ||
    baseRepo.full_name !== receipt.targetRepository || base.ref !== BASE_BRANCH ||
    headRepo.full_name !== receipt.headRepository || head.ref !== receipt.branch || head.sha !== receipt.commit
  ) {
    throw new Error("receipt-bound GitHub pull request identity changed and cannot be replayed");
  }
}

async function ensureFork(runner: GhRunner, plan: GitHubPublicationPrPlan) {
  if (plan.head.repository === plan.target.repository) return;
  let metadata = await optionalRepository(runner, plan.head.repository);
  if (!metadata) {
    await ghJson(runner, `repos/${plan.target.repository}/forks`, { method: "POST", body: { default_branch_only: true } });
    for (let attempt = 0; attempt < 10 && !metadata; attempt += 1) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 1_000));
      metadata = await optionalRepository(runner, plan.head.repository);
    }
  }
  if (!metadata || !metadata.fork || metadata.parent?.toLocaleLowerCase("en-US") !== plan.target.repository.toLocaleLowerCase("en-US")) {
    throw new Error("GitHub fork was not ready or did not match the central repository");
  }
  requireWritableRepository(metadata);
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

async function findExistingPr(runner: GhRunner, plan: GitHubPublicationPrPlan) {
  const owner = plan.head.repository.split("/")[0];
  const endpoint = `repos/${plan.target.repository}/pulls?state=all&head=${encodeURIComponent(`${owner}:${plan.head.branch}`)}&base=${BASE_BRANCH}`;
  const values = await ghJson<unknown[]>(runner, endpoint);
  if (!Array.isArray(values)) throw new Error("GitHub pull request lookup response is invalid");
  const found = values.find((value) => isRecord(value) && typeof value.body === "string" && value.body.includes(plan.planDigest));
  if (!isRecord(found)) return undefined;
  if (
    typeof found.number !== "number" || typeof found.html_url !== "string" ||
    found.html_url !== `https://github.com/${plan.target.repository}/pull/${found.number}`
  ) throw new Error("GitHub pull request identity response is invalid");
  if (found.state === "closed" && found.merged_at == null && found.merged !== true) {
    throw new Error("the Plan-bound publication PR was closed without merge and cannot be replayed");
  }
  if (found.state !== "open" && found.merged_at == null && found.merged !== true) {
    throw new Error("GitHub pull request state is invalid for replay");
  }
  const head = isRecord(found.head) ? found.head : {};
  return { number: found.number, url: found.html_url, commit: typeof head.sha === "string" ? head.sha : "" };
}

async function verifyExistingBranch(runner: GhRunner, plan: GitHubPublicationPrPlan, files: Map<string, Uint8Array>, commitSha: string) {
  const commit = await ghJson<Record<string, unknown>>(runner, `repos/${plan.head.repository}/git/commits/${commitSha}`);
  const parents = Array.isArray(commit.parents) ? commit.parents : [];
  if (parents.length !== 1 || !isRecord(parents[0]) || parents[0].sha !== plan.target.baseCommit) {
    throw new Error("existing publication branch has the wrong base parent");
  }
  if (typeof commit.message !== "string" || !commit.message.includes(plan.planDigest)) throw new Error("existing publication branch is not bound to this Plan");
  const comparison = await ghJson<Record<string, unknown>>(
    runner,
    `repos/${plan.target.repository}/compare/${plan.target.baseCommit}...${encodeURIComponent(`${plan.expectedGithubLogin}:${plan.head.branch}`)}`,
  );
  const changed = Array.isArray(comparison.files) ? comparison.files : [];
  const expected = new Map([...files.entries()].map(([name, bytes]) => [name, gitBlobSha(bytes)]));
  if (changed.length !== expected.size) throw new Error("existing publication branch changed an unexpected number of files");
  for (const item of changed) {
    if (!isRecord(item) || typeof item.filename !== "string" || typeof item.sha !== "string" || expected.get(item.filename) !== item.sha) {
      throw new Error("existing publication branch file identities do not match this Plan");
    }
  }
}

async function createOrRecoverPullRequest(runner: GhRunner, plan: GitHubPublicationPrPlan, files: Map<string, Uint8Array>) {
  const currentBase = await getBaseIdentity(runner, plan.target.repository);
  if (currentBase.baseCommit !== plan.target.baseCommit || currentBase.baseTree !== plan.target.baseTree) {
    throw new Error("GitHub target base changed after planning");
  }
  for (const file of plan.files) {
    if (file.change === "add" && await repositoryPathExists(runner, plan.target.repository, currentBase.baseCommit, file.path)) {
      throw new Error(`GitHub target path already exists after planning: ${file.path}`);
    }
  }
  await ensureFork(runner, plan);
  const refEndpoint = `repos/${plan.head.repository}/git/ref/heads/${plan.head.branch}`;
  let ref = await optionalGhJson<Record<string, unknown>>(runner, refEndpoint);
  let commitSha = "";
  if (ref) {
    const object = isRecord(ref.object) ? ref.object : {};
    commitSha = typeof object.sha === "string" ? object.sha : "";
    if (!GIT_HASH.test(commitSha)) throw new Error("existing publication branch ref is invalid");
    await verifyExistingBranch(runner, plan, files, commitSha);
  } else {
    const blobs = await createBlobs(runner, plan.head.repository, files);
    const tree = await ghJson<Record<string, unknown>>(runner, `repos/${plan.head.repository}/git/trees`, {
      method: "POST",
      body: {
        base_tree: plan.target.baseTree,
        tree: [...blobs.entries()].map(([filePath, blobSha]) => ({ path: filePath, mode: "100644", type: "blob", sha: blobSha })),
      },
    });
    if (typeof tree.sha !== "string" || !GIT_HASH.test(tree.sha)) throw new Error("GitHub did not return a tree SHA");
    const commit = await ghJson<Record<string, unknown>>(runner, `repos/${plan.head.repository}/git/commits`, {
      method: "POST",
      body: {
        message: `${plan.commitMessage}\n\nSFL-Plan-Digest: ${plan.planDigest}`,
        tree: tree.sha,
        parents: [plan.target.baseCommit],
      },
    });
    if (typeof commit.sha !== "string" || !GIT_HASH.test(commit.sha)) throw new Error("GitHub did not return a commit SHA");
    commitSha = commit.sha;
    try {
      await ghJson(runner, `repos/${plan.head.repository}/git/refs`, {
        method: "POST",
        body: { ref: `refs/heads/${plan.head.branch}`, sha: commitSha },
      });
    } catch (error) {
      if (!(error instanceof GhInvocationError) || error.kind !== "conflict") throw error;
      ref = await ghJson<Record<string, unknown>>(runner, refEndpoint);
      const object = isRecord(ref.object) ? ref.object : {};
      const recovered = typeof object.sha === "string" ? object.sha : "";
      if (!GIT_HASH.test(recovered)) throw new Error("racing publication branch ref is invalid");
      commitSha = recovered;
      await verifyExistingBranch(runner, plan, files, commitSha);
    }
  }
  const existing = await findExistingPr(runner, plan);
  if (existing) {
    if (existing.commit && existing.commit !== commitSha) throw new Error("existing publication PR head changed after planning");
    return { ...existing, commit: commitSha, replayed: true };
  }
  const owner = plan.head.repository.split("/")[0];
  const created = await ghJson<Record<string, unknown>>(runner, `repos/${plan.target.repository}/pulls`, {
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
    created.html_url !== `https://github.com/${plan.target.repository}/pull/${created.number}`
  ) throw new Error("GitHub did not return a pull request identity");
  return { number: created.number, url: created.html_url, commit: commitSha, replayed: false };
}

function envelope(
  outcome: ToolOutcomeEnvelope["outcome"],
  code: string,
  summary: string,
  nextAction: ToolOutcomeEnvelope["nextAction"] = "none",
): ToolOutcomeEnvelope {
  return { schema: "figure-library.tool-outcome.v1", outcome, terminal: true, retrySameCall: false, code, summary, nextAction };
}

function response(value: ToolOutcomeEnvelope, details: Record<string, unknown> = {}, lines: string[] = []): CallToolResult {
  return {
    content: [{
      type: "text",
      text: [
        `OUTCOME: ${value.outcome}`, "TERMINAL: true", "RETRY_SAME_CALL: false",
        `CODE: ${value.code}`, `NEXT_ACTION: ${value.nextAction}`, value.summary, ...lines,
      ].join("\n"),
    }],
    structuredContent: { envelope: value, ...details },
  };
}

function toolFailure(prefix: string, error: unknown): CallToolResult {
  if (error instanceof GhInvocationError) {
    const code = `github_${error.kind}`;
    const nextAction = ["cli_missing", "not_authenticated", "credential_invalid", "insufficient_scope"].includes(error.kind)
      ? "ask_user" : error.kind === "conflict" ? "create_new_plan" : "none";
    return response(envelope(error.kind === "conflict" ? "conflict" : "blocked", code, `${prefix}: ${error.message}`, nextAction));
  }
  const message = error instanceof Error ? error.message : String(error);
  const conflict = /already exists|stale|changed after planning|does not match|wrong base|identity mismatch/iu.test(message);
  return response(envelope(conflict ? "conflict" : "failed", conflict ? "github_publication_stale" : "github_publication_failed", `${prefix}: ${message}`, conflict ? "create_new_plan" : "none"));
}

export class GitHubPublicationService {
  readonly #plans = new Map<string, { prepared: PreparedPlan; expiresAt: number }>();
  readonly #runner: GhRunner;
  readonly #receiptDirectory: string;
  readonly #now: () => Date;

  constructor(options: { ghRunner?: GhRunner; receiptDirectory?: string; now?: () => Date } = {}) {
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

  async authStatus(): Promise<GitHubAuthStatus> {
    let account: Awaited<ReturnType<typeof readAuthAccount>>;
    try {
      account = await readAuthAccount(this.#runner);
    } catch (error) {
      const kind = error instanceof GhInvocationError ? error.kind : "github_unreachable";
      return {
        schema: "figure-library.github-auth-status.v1",
        status: authFailureStatus(kind),
        login: null,
        host: HOST,
        repositories: [CENTRAL_ARCHIVE_REPOSITORY, CENTRAL_CATALOG_REPOSITORY].map((repository) => ({
          repository, permission: "unavailable", archived: null, disabled: null,
        })),
        credentialStorage: "managed_by_github_cli",
        secureStorageVerified: false,
        tokenReadBySfl: false,
      };
    }
    const repositories: GitHubAuthRepositoryStatus[] = [];
    try {
      for (const repository of [CENTRAL_ARCHIVE_REPOSITORY, CENTRAL_CATALOG_REPOSITORY]) {
        const metadata = await getRepository(this.#runner, repository);
        repositories.push({ repository, permission: repositoryPermission(metadata), archived: metadata.archived, disabled: metadata.disabled });
      }
      return {
        schema: "figure-library.github-auth-status.v1",
        status: "authenticated",
        login: account.login,
        host: HOST,
        repositories,
        credentialStorage: "managed_by_github_cli",
        secureStorageVerified: account.secureStorageVerified,
        tokenReadBySfl: false,
      };
    } catch (error) {
      const kind = error instanceof GhInvocationError ? error.kind : "github_unreachable";
      return {
        schema: "figure-library.github-auth-status.v1",
        status: authFailureStatus(kind),
        login: account.login,
        host: HOST,
        repositories: [CENTRAL_ARCHIVE_REPOSITORY, CENTRAL_CATALOG_REPOSITORY].map((repository) => ({
          repository,
          permission: "unavailable",
          archived: null,
          disabled: null,
        })),
        credentialStorage: "managed_by_github_cli",
        secureStorageVerified: account.secureStorageVerified,
        tokenReadBySfl: false,
      };
    }
  }

  authInstructions() {
    return {
      schema: "figure-library.github-auth-instructions.v1",
      host: HOST,
      command: "gh auth login --hostname github.com --web --git-protocol https --scopes public_repo",
      launchedBySfl: false,
      tokenReadBySfl: false,
      credentialStorage: "managed_by_github_cli" as const,
      notes: [
        "Run this command yourself in a terminal and complete GitHub CLI's official flow.",
        "SFL does not open a browser, start an interactive login, call gh auth token, or read hosts.yml.",
        "After login, call figure_library_github_auth_status before creating a publication PR Plan.",
      ],
    };
  }

  async plan(request: PlanRequest): Promise<GitHubPublicationPrPlan> {
    assertPlanInput(request);
    const prepared = request.action === "archive"
      ? await buildArchivePlan(this.#runner, request.submissionDirectory!)
      : await buildCatalogPlan(this.#runner, request.archivePullRequestNumber!, request.expectedTemplateId!, request.expectedReleaseVersion!);
    this.#prune();
    this.#plans.set(prepared.plan.planDigest, { prepared, expiresAt: this.#now().getTime() + PLAN_TTL_MS });
    return prepared.plan;
  }

  async apply(planDigest: string, operationId: string) {
    if (!HASH.test(planDigest) || !OPERATION_ID.test(operationId)) throw new Error("invalid planDigest or operationId");
    const prior = await readReceipt(this.#receiptDirectory, operationId);
    if (prior) {
      if (prior.planDigest !== planDigest) throw new Error("operationId is already bound to a different GitHub publication Plan");
      await revalidateReceipt(this.#runner, prior);
      return { outcome: "replayed" as const, receipt: prior };
    }
    this.#prune();
    const cached = this.#plans.get(planDigest);
    if (!cached) throw new Error("GitHub publication Plan expired or belongs to another server process");
    const source = cached.prepared.plan.source;
    const rebuilt = cached.prepared.plan.action === "archive"
      ? await buildArchivePlan(this.#runner, (source as Extract<typeof source, { kind: "publication_submission" }>).directory)
      : await buildCatalogPlan(
        this.#runner,
        (source as Extract<typeof source, { kind: "merged_archive_pr" }>).pullRequestNumber,
        cached.prepared.plan.identity.templateId,
        cached.prepared.plan.identity.releaseVersion,
      );
    const originallyMissingFork = cached.prepared.plan.head.forkWillBeCreated;
    const forkTransitionIsSafe = originallyMissingFork && !rebuilt.plan.head.forkWillBeCreated &&
      rebuilt.plan.head.repository === cached.prepared.plan.head.repository;
    const normalizedRebuiltPlan = forkTransitionIsSafe
      ? {
          ...rebuilt.plan,
          head: {
            ...rebuilt.plan.head,
            forkWillBeCreated: true,
            permission: "fork_creation_required" as const,
          },
          planDigest: cached.prepared.plan.planDigest,
        }
      : rebuilt.plan;
    if (canonicalJson(normalizedRebuiltPlan) !== canonicalJson(cached.prepared.plan)) {
      throw new Error("GitHub account, permissions, base, source, or proposed files changed after planning; create a new Plan");
    }
    const account = await readAuthAccount(this.#runner);
    if (account.login !== rebuilt.plan.expectedGithubLogin) throw new Error("GitHub login changed after planning");
    for (const file of cached.prepared.plan.files) assertAllowedRepositoryFile(cached.prepared.plan.action, file.path);
    const created = await createOrRecoverPullRequest(this.#runner, cached.prepared.plan, rebuilt.files);
    const receipt: GithubPrReceipt = {
      schema: RECEIPT_SCHEMA,
      operationId,
      planDigest,
      action: cached.prepared.plan.action,
      login: account.login,
      targetRepository: cached.prepared.plan.target.repository,
      headRepository: cached.prepared.plan.head.repository,
      branch: cached.prepared.plan.head.branch,
      commit: created.commit,
      pullRequestNumber: created.number,
      pullRequestUrl: created.url,
      recordedAt: this.#now().toISOString(),
    };
    await writeReceipt(this.#receiptDirectory, receipt);
    return { outcome: created.replayed ? "replayed" as const : "applied" as const, receipt };
  }
}

const EmptyInput = z.object({});
const PlanInput = z.object({
  action: z.enum(["archive", "catalog"]),
  submissionDirectory: z.string().min(1).max(4_000).optional(),
  archivePullRequestNumber: z.number().int().positive().optional(),
  expectedTemplateId: z.string().regex(TEMPLATE_ID).optional(),
  expectedReleaseVersion: z.string().regex(STRICT_SEMVER).optional(),
});
const ApplyInput = z.object({ planDigest: z.string().regex(HASH), operationId: z.string().regex(OPERATION_ID) });

/** Register the four GitHub publication tools. The caller owns server integration. */
export function registerGitHubPublicationTools(options: {
  server: McpServer;
  ghRunner?: GhRunner;
  receiptDirectory?: string;
  now?: () => Date;
}) {
  const service = new GitHubPublicationService(options);
  options.server.registerTool(
    "figure_library_github_auth_status",
    {
      title: "Inspect GitHub CLI publication authentication",
      description: "Read-only check of the official gh login and central repository permissions. SFL never reads or prints the token.",
      inputSchema: EmptyInput.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (): Promise<CallToolResult> => {
      const status = await service.authStatus();
      return response(
        envelope(status.status === "authenticated" ? "ok" : "blocked", `github_auth_${status.status}`, status.status === "authenticated" ? `GitHub CLI is authenticated as ${status.login}.` : `GitHub CLI authentication is not ready: ${status.status}.`, status.status === "authenticated" ? "none" : "ask_user"),
        { status },
      );
    },
  );
  options.server.registerTool(
    "figure_library_github_auth_instructions",
    {
      title: "Show official GitHub CLI authentication instructions",
      description: "Return a terminal command for the user to run. This tool never launches a browser or login process.",
      inputSchema: EmptyInput.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (): Promise<CallToolResult> => {
      const instructions = service.authInstructions();
      return response(envelope("ok", "github_auth_instructions", "Run the displayed official gh command yourself; SFL did not start it."), { instructions }, [instructions.command]);
    },
  );
  options.server.registerTool(
    "figure_library_plan_publication_pr",
    {
      title: "Plan a staged central publication pull request",
      description: "Read-only Archive or Catalog PR Plan. Archive uses one sanitized submission; Catalog requires a manually merged Archive PR and re-verifies its fixed merge commit and ZIP.",
      inputSchema: PlanInput.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (input): Promise<CallToolResult> => {
      try {
        const plan = await service.plan(input);
        return response(envelope("needs_user_confirmation", "github_publication_pr_plan_ready", "No GitHub state was changed. Review the account, repository, base, branch, commit, files, and digests before Apply.", "apply_confirmed_plan"), { plan });
      } catch (error) {
        return toolFailure("GitHub publication PR Plan was not created", error);
      }
    },
  );
  options.server.registerTool(
    "figure_library_apply_publication_pr",
    {
      title: "Apply a reviewed staged central publication pull request",
      description: "Re-check the gh account, permissions, source, merge gate, base, and file identities; then create a branch/commit/PR through Git Data API. Never merges the PR.",
      inputSchema: ApplyInput.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (input): Promise<CallToolResult> => {
      try {
        const applied = await service.apply(input.planDigest, input.operationId);
        return response(
          envelope(applied.outcome, applied.outcome === "applied" ? "github_publication_pr_created" : "github_publication_pr_replayed", applied.outcome === "applied" ? "The pull request was created but not merged. Review and merge it manually in GitHub." : "The operationId replayed the existing pull request; no duplicate PR was created."),
          { receipt: applied.receipt },
          [applied.receipt.pullRequestUrl, "The MCP tool did not merge this pull request."],
        );
      } catch (error) {
        return toolFailure("GitHub publication PR Apply was not completed", error);
      }
    },
  );
  return service;
}
