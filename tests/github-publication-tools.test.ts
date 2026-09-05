import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { canonicalJson } from "../src/canonical-json.ts";
import {
  CENTRAL_ARCHIVE_REPOSITORY,
  CENTRAL_CATALOG_REPOSITORY,
  CENTRAL_PUBLIC_PROVIDER_ID,
  // personal repo is reported by auth status
  GitHubPublicationService,
  registerGitHubPublicationTools,
  type GhCommandResult,
  type GhRunner,
} from "../src/github-publication-tools.ts";
import { PERSONAL_MODULE_REPOSITORY } from "../src/module-catalog.ts";

const BASE_COMMIT = "a".repeat(40);
const BASE_TREE = "b".repeat(40);
const CREATED_TREE = "c".repeat(40);
const CREATED_COMMIT = "d".repeat(40);
const MERGE_COMMIT = "e".repeat(40);
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
function sha256(value: Uint8Array | string) {
  return createHash("sha256").update(value).digest("hex");
}

function gitBlobSha(value: Uint8Array) {
  return createHash("sha1").update(`blob ${value.byteLength}\0`).update(value).digest("hex");
}

function bytes(value: unknown) {
  return Buffer.from(`${canonicalJson(value)}\n`, "utf8");
}

function contentDigest(value: unknown) {
  return sha256(canonicalJson(value));
}

function assertArchivePolicyZipMetadata(value: Uint8Array) {
  const archive = Buffer.from(value);
  const eocd = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd >= 0 && eocd + 22 === archive.byteLength, "Archive ZIP must end at its EOCD record");
  const entries = archive.readUInt16LE(eocd + 10);
  const centralOffset = archive.readUInt32LE(eocd + 16);
  assert.ok(entries > 0);
  let central = centralOffset;
  let expectedLocalOffset = 0;
  const names: string[] = [];
  for (let index = 0; index < entries; index += 1) {
    assert.equal(archive.readUInt32LE(central), 0x02014b50);
    const nameLength = archive.readUInt16LE(central + 28);
    const extraLength = archive.readUInt16LE(central + 30);
    const commentLength = archive.readUInt16LE(central + 32);
    const compressedBytes = archive.readUInt32LE(central + 20);
    const localOffset = archive.readUInt32LE(central + 42);
    const name = archive.subarray(central + 46, central + 46 + nameLength);
    names.push(name.toString("utf8"));
    assert.equal(archive.readUInt16LE(central + 4), 20, "version made by must match fflate DOS v2.0");
    assert.equal(archive.readUInt16LE(central + 6), 20, "version needed must be ZIP v2.0");
    assert.equal(archive.readUInt16LE(central + 8), 0, "ASCII seed paths must have no ZIP flags");
    assert.equal(archive.readUInt16LE(central + 10), 8, "Archive entries must use DEFLATE");
    assert.equal(archive.readUInt16LE(central + 12), 0x4000, "central DOS time must be 08:00:00");
    assert.equal(archive.readUInt16LE(central + 14), 0x0021, "central DOS date must be 1980-01-01");
    assert.equal(extraLength, 0);
    assert.equal(commentLength, 0);
    assert.equal(archive.readUInt16LE(central + 34), 0);
    assert.equal(archive.readUInt16LE(central + 36), 0);
    assert.equal(archive.readUInt32LE(central + 38), 0);
    assert.equal(localOffset, expectedLocalOffset, "local ZIP records must be contiguous and canonically ordered");

    assert.equal(archive.readUInt32LE(localOffset), 0x04034b50);
    assert.equal(archive.readUInt16LE(localOffset + 4), 20);
    assert.equal(archive.readUInt16LE(localOffset + 6), 0);
    assert.equal(archive.readUInt16LE(localOffset + 8), 8);
    assert.equal(archive.readUInt16LE(localOffset + 10), 0x4000, "local DOS time must be 08:00:00");
    assert.equal(archive.readUInt16LE(localOffset + 12), 0x0021, "local DOS date must be 1980-01-01");
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    assert.equal(localNameLength, nameLength);
    assert.equal(localExtraLength, 0);
    assert.deepEqual(archive.subarray(localOffset + 30, localOffset + 30 + localNameLength), name);
    expectedLocalOffset = localOffset + 30 + localNameLength + localExtraLength + compressedBytes;
    central += 46 + nameLength + extraLength + commentLength;
  }
  assert.equal(expectedLocalOffset, centralOffset);
  assert.equal(central, eocd);
  assert.deepEqual(names, [...names].sort(), "Archive entries must use canonical UTF-16 order");
}

async function writeSubmission(
  root: string,
  templateId = "clean-room-bars",
  releaseVersion = "1.0.0",
) {
  const directory = path.join(root, "submission");
  const assets = new Map<string, Buffer>([
    ["payload/code/render.R", Buffer.from("args <- commandArgs(trailingOnly = TRUE)\n# clean room renderer\n", "utf8")],
    ["payload/data/data.csv", Buffer.from("group,value\nCluster A,1\nCluster B,2\n", "utf8")],
    ["payload/preview/preview.png", PNG],
    ["payload/docs/README.md", Buffer.from("# Synthetic public example\n", "utf8")],
  ]);
  let declaredContentDigest = "1".repeat(64);
  const publicMetadata = {
    title: "Clean-room bars",
    description: "A neutral synthetic bar chart.",
    application: "General enrichment-like summaries",
    dataProfile: "Synthetic long table",
    plotFamily: "bar",
    language: "R",
    tags: ["bar", "synthetic"],
    provenance: [{ type: "note", value: "Clean-room public example." }],
  };
  const submission = {
    schema: "figure-library.publication-submission.v1",
    providerId: "io.github.jarxunlai.scientific-figure-community",
    templateId,
    releaseVersion,
    contentDigest: declaredContentDigest,
    parentLocalRelease: {
      relationship: "sanitized-export-from-local-published",
      explicitlySelectedAssetsOnly: true,
      privateLifecycleIdentifiersIncluded: false,
    },
    publicMetadata,
    assets: [...assets.entries()].map(([filePath, content]) => ({
      path: filePath,
      role: filePath.includes("/code/") ? "code" : filePath.includes("/data/") ? "synthetic_data" : filePath.includes("/preview/") ? "generated_preview" : "documentation",
      include: true,
      source: filePath.includes("/data/") ? "synthetic" : filePath.includes("/preview/") ? "generated" : "clean_room",
      license: filePath.includes("/code/") ? "MIT" : "CC-BY-4.0",
      bytes: content.byteLength,
      sha256: sha256(content),
      ...(filePath.includes("/preview/") ? { generatedFrom: ["payload/code/render.R", "payload/data/data.csv"] } : {}),
    })),
    rightsAttestation: {
      publisher: "jarxunlai",
      codeRightsConfirmed: true,
      syntheticDataConfirmed: true,
      generatedPreviewConfirmed: true,
      noThirdPartyMediaConfirmed: true,
      immutableReleaseAcknowledged: true,
    },
    excludedPrivateState: ["library.json", "operations", "receipts"],
    createdAt: "2026-08-21T00:00:00.000Z",
  };
  const template = {
    schema: "figure-library.public-template-archive.v1",
    providerId: "io.github.jarxunlai.scientific-figure-community",
    templateId,
    releaseVersion,
    contentDigest: declaredContentDigest,
    metadata: {
      ...publicMetadata,
      upstreamStatus: "published",
      publisherVerified: false,
      curationStatus: "unreviewed",
      renderValidation: "publisher_attested",
      localReviewStatus: "not_reviewed",
      plotExecutionByRecipient: "not_run",
    },
    licenses: { code: "MIT", syntheticData: "CC-BY-4.0", preview: "CC-BY-4.0", documentation: "CC-BY-4.0" },
    render: {
      entrypoint: "payload/code/render.R",
      previewPath: "payload/preview/preview.png",
      sourceCode: ["payload/code/render.R"],
      sourceData: ["payload/data/data.csv"],
      previewBytes: PNG.byteLength,
      previewSha256: sha256(PNG),
      mediaType: "image/png",
      width: 1,
      height: 1,
      canonicalRgbaSha256: "2".repeat(64),
    },
    codeExecutedBySflClient: false,
  };
  const licenses = {
    schema: "figure-library.publication-licenses.v1",
    code: "MIT",
    syntheticData: "CC-BY-4.0",
    preview: "CC-BY-4.0",
    documentation: "CC-BY-4.0",
  };
  const renderReceipt = {
    schema: "figure-library.render-receipt.v1",
    entrypoint: "payload/code/render.R",
    inputPaths: ["payload/data/data.csv"],
    codePaths: ["payload/code/render.R"],
    previewPath: "payload/preview/preview.png",
    previewBytes: PNG.byteLength,
    previewSha256: sha256(PNG),
    mediaType: "image/png",
    width: 1,
    height: 1,
    canonicalRgbaSha256: "2".repeat(64),
    sourceExecution: "publisher_attested",
    codeExecutedBySflClient: false,
  };
  declaredContentDigest = contentDigest({
    schema: "figure-library.public-template-content-digest.v1",
    providerId: submission.providerId,
    templateId,
    releaseVersion,
    metadata: publicMetadata,
    licenses: { code: "MIT", content: "CC-BY-4.0", documentation: "CC-BY-4.0" },
    assets: submission.assets.map((asset) => ({
      path: asset.path, bytes: asset.bytes, sha256: asset.sha256, role: asset.role, license: asset.license, source: asset.source,
    })),
    render: template.render,
  });
  submission.contentDigest = declaredContentDigest;
  template.contentDigest = declaredContentDigest;
  const files = new Map<string, Buffer>([
    ...assets,
    ["submission.json", bytes(submission)],
    ["licenses.json", bytes(licenses)],
    ["render-receipt.json", bytes(renderReceipt)],
    ["payload/template.json", bytes(template)],
  ]);
  const inventory = [...files.entries()]
    .map(([filePath, content]) => ({ path: filePath, bytes: content.byteLength, sha256: sha256(content) }))
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  files.set("inventory.jsonl", Buffer.from(`${inventory.map((item) => canonicalJson(item)).join("\n")}\n`, "utf8"));
  for (const [filePath, content] of files) {
    const target = path.join(directory, ...filePath.split("/"));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }
  return directory;
}

async function writeFrozenSeedSubmission(root: string, templateId = "seed-clean-room-bars") {
  const directory = path.join(root, "frozen-seed");
  let declaredContentDigest = "3".repeat(64);
  const code = Buffer.from("args <- commandArgs(trailingOnly = TRUE)\n# clean-room R renderer\n", "utf8");
  const data = Buffer.from("group,value\nCluster A,1\nCluster B,2\n", "utf8");
  const docs = Buffer.from("# Frozen clean-room seed\n", "utf8");
  const template = {
    schema: "figure-library.public-template-archive.v1",
    providerId: "io.github.jarxunlai.scientific-figure-community",
    templateId,
    releaseVersion: "1.0.0",
    contentDigest: declaredContentDigest,
    metadata: {
      title: "Seed clean-room bars",
      summary: "A neutral clean-room bar template generated from synthetic data.",
      keywords: ["bar chart", "synthetic"],
      upstreamStatus: "published",
      publisherVerified: true,
      curationStatus: "unreviewed",
      renderValidation: "publisher_attested",
      localReviewStatus: "not_reviewed",
      plotExecutionByRecipient: "not_run",
      provenance: "Clean-room authored code, neutral synthetic data, and code-generated preview.",
      contentDigestAlgorithm: "sha256(canonical JSON list of code, data, preview, and documentation identities)",
    },
    licenses: { code: "MIT", syntheticData: "CC-BY-4.0", preview: "CC-BY-4.0", documentation: "CC-BY-4.0" },
    render: {
      entrypoint: "payload/code/render.R",
      inputDirectory: "payload/data",
      outputMediaType: "image/png",
      width: 1,
      height: 1,
      canonicalRgbaSha256: "4".repeat(64),
      clientExecutionRequired: false,
    },
    codeExecutedBySflClient: false,
  };
  const payloads = new Map<string, Buffer>([
    ["payload/code/render.R", code],
    ["payload/data/data.csv", data],
    ["payload/preview/preview.png", PNG],
    ["payload/docs/README.md", docs],
  ]);
  const seedRows = [...payloads.entries()].map(([filePath, content]) => ({ path: filePath, bytes: content.byteLength, sha256: sha256(content) }))
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  declaredContentDigest = sha256(JSON.stringify(seedRows));
  template.contentDigest = declaredContentDigest;
  payloads.set("payload/template.json", bytes(template));
  const role = (filePath: string) => filePath === "payload/template.json" ? "metadata"
    : filePath.includes("/code/") ? "render_code"
      : filePath.includes("/data/") ? "synthetic_data"
        : filePath.includes("/preview/") ? "generated_preview" : "documentation";
  const source = (filePath: string) => filePath === "payload/template.json" || filePath.includes("/docs/") ? "authored"
    : filePath.includes("/code/") ? "clean_room"
      : filePath.includes("/data/") ? "synthetic" : "generated";
  const submission = {
    schema: "figure-library.publication-submission.v1",
    providerId: "io.github.jarxunlai.scientific-figure-community",
    templateId,
    releaseVersion: "1.0.0",
    contentDigest: declaredContentDigest,
    parentLocalRelease: { relationship: "design-and-exclusion-audit-only", bytesCopied: false, metadataCopied: false, privateAssetsIncluded: false },
    assets: [...payloads.entries()].map(([filePath, content]) => ({
      path: filePath,
      role: role(filePath),
      include: true,
      source: source(filePath),
      license: filePath.includes("/code/") ? "MIT" : "CC-BY-4.0",
      bytes: content.byteLength,
      sha256: sha256(content),
    })),
    rightsAttestation: {
      codeLicense: "MIT",
      contentLicense: "CC-BY-4.0",
      cleanRoomAuthored: true,
      syntheticDataOnly: true,
      previewGeneratedByIncludedCodeAndData: true,
      thirdPartyMediaIncluded: false,
      screenshotsIncluded: false,
      paperOrPdfContentIncluded: false,
      patientOrExperimentalDataIncluded: false,
    },
    excludedPrivateState: ["local-library-identity", "absolute-machine-paths", "source-reference-media"],
    createdAt: "2026-08-21T00:00:00Z",
  };
  const licenses = {
    schema: "figure-library.publication-licenses.v1",
    code: "MIT",
    syntheticData: "CC-BY-4.0",
    preview: "CC-BY-4.0",
    documentation: "CC-BY-4.0",
    assetLicenses: Object.fromEntries([...payloads.keys()].map((filePath) => [filePath, filePath.includes("/code/") ? "MIT" : "CC-BY-4.0"])),
  };
  const renderReceipt = {
    schema: "figure-library.render-receipt.v1",
    entrypoint: "payload/code/render.R",
    inputFiles: [{ path: "payload/data/data.csv", bytes: data.byteLength, sha256: sha256(data) }],
    code: { path: "payload/code/render.R", bytes: code.byteLength, sha256: sha256(code), license: "MIT" },
    output: { path: "payload/preview/preview.png", license: "CC-BY-4.0" },
    publisherRuntime: { engine: "R", version: "4.4.3" },
    reviewedCiRuntime: { engine: "R", version: "4.4.3", networkRequired: false },
    randomSeed: null,
    previewBytes: PNG.byteLength,
    previewSha256: sha256(PNG),
    width: 1,
    height: 1,
    mediaType: "image/png",
    canonicalRgbaSha256: "4".repeat(64),
    generatedFromSubmittedCodeAndSyntheticData: true,
  };
  const files = new Map<string, Buffer>([
    ...payloads,
    ["submission.json", bytes(submission)],
    ["licenses.json", bytes(licenses)],
    ["render-receipt.json", bytes(renderReceipt)],
  ]);
  const inventory = [...files.entries()]
    .map(([filePath, content]) => ({ path: filePath, bytes: content.byteLength, sha256: sha256(content) }))
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  files.set("inventory.jsonl", Buffer.from(`${inventory.map((item) => canonicalJson(item)).join("\n")}\n`, "utf8"));
  for (const [filePath, content] of files) {
    const target = path.join(directory, ...filePath.split("/"));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }
  return directory;
}

async function rebuildInventory(directory: string) {
  const rows: Array<{ path: string; bytes: number; sha256: string }> = [];
  const walk = async (current: string, relativeDirectory = ""): Promise<void> => {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(absolute, relative);
      else if (entry.isFile() && relative !== "inventory.jsonl") {
        const content = await fs.readFile(absolute);
        rows.push({ path: relative, bytes: content.byteLength, sha256: sha256(content) });
      }
    }
  };
  await walk(directory);
  rows.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  await fs.writeFile(path.join(directory, "inventory.jsonl"), `${rows.map((item) => canonicalJson(item)).join("\n")}\n`, "utf8");
}

async function replaceDeclaredAsset(directory: string, assetPath: string, content: Buffer) {
  await fs.writeFile(path.join(directory, ...assetPath.split("/")), content);
  const submissionPath = path.join(directory, "submission.json");
  const submission = JSON.parse(await fs.readFile(submissionPath, "utf8")) as Record<string, any>;
  const asset = (submission.assets as Array<Record<string, unknown>>).find((item) => item.path === assetPath);
  assert.ok(asset);
  asset.bytes = content.byteLength;
  asset.sha256 = sha256(content);
  await fs.writeFile(submissionPath, `${canonicalJson(submission)}\n`, "utf8");
  await rebuildInventory(directory);
}

interface RegisteredFile {
  repository: string;
  ref: string;
  path: string;
  bytes: Uint8Array;
}

class MockGhRunner implements GhRunner {
  login = "jarxunlai";
  authState = "success";
  tokenSource = "GH_TOKEN";
  merged = true;
  validationSuccess = true;
  centralWrite = true;
  forkReady = false;
  writes: Array<{ endpoint: string; body: Record<string, unknown> }> = [];
  calls: string[][] = [];
  uploadedBlobs: Uint8Array[] = [];
  files = new Map<string, Uint8Array>();
  blobs = new Map<string, Uint8Array>();
  nextPullNumber = 101;
  archivePullNumber = 17;
  archiveTemplateId = "clean-room-bars";
  archiveReleaseVersion = "1.0.0";
  archiveAuthor = "jarxunlai";
  archiveHeadRepository = CENTRAL_ARCHIVE_REPOSITORY as string;
  archiveHeadRef = "sfl/archive/clean-room-bars/1.0.0/archive-digest";
  archiveHeadSha = CREATED_COMMIT;
  archiveBaseRepository = CENTRAL_ARCHIVE_REPOSITORY as string;
  archiveBaseRef = "main";
  archiveBaseSha = BASE_COMMIT;
  validationEvent = "pull_request_target";
  validationWorkflowMetadataId: unknown = 339_177_621;
  validationWorkflowMetadataName = "validate-archive-pr";
  validationWorkflowMetadataPath = ".github/workflows/validate-archive-pr.yml";
  validationWorkflowMetadataState = "active";
  validationWorkflowId: unknown = undefined;
  validationWorkflowPath = ".github/workflows/validate-archive-pr.yml";
  validationRunName: string | null | undefined = undefined;
  validationRepository = CENTRAL_ARCHIVE_REPOSITORY as string;
  validationHeadRepository: string | null = null;
  validationHeadBranch: string | null = null;
  validationHeadSha: string | null = null;
  validationPullRequests: unknown[] | null | undefined = [];
  validationDisplayTitle: string | null | undefined = undefined;
  archiveMergeParents: string[] | null = null;
  baseCommit = BASE_COMMIT;
  baseTree = BASE_TREE;
  existingRefCommit: string | null = null;
  existingCommitParents: string[] = [BASE_COMMIT];
  existingCommitPlanDigest = "";
  existingPrState: "none" | "open" | "closed_unmerged" = "none";
  receiptPrState: "open" | "merged" | "closed_unmerged" = "open";
  receiptPrHeadRepository: string | null = null;
  receiptPrBranch: string | null = null;
  receiptPrCommit: string | null = null;
  createdPulls = new Map<number, { targetRepository: string; headRepository: string; branch: string; commit: string }>();

  registerFile(value: RegisteredFile) {
    const key = `${value.repository}@${value.ref}:${value.path}`;
    this.files.set(key, value.bytes);
    this.blobs.set(gitBlobSha(value.bytes), value.bytes);
  }

  #ok(value: unknown): GhCommandResult {
    return { exitCode: 0, stdout: typeof value === "string" ? value : JSON.stringify(value), stderr: "" };
  }

  #notFound(): GhCommandResult {
    return { exitCode: 1, stdout: "", stderr: "gh: HTTP 404: Not Found" };
  }

  async run(args: readonly string[], options: { stdin?: string } = {}): Promise<GhCommandResult> {
    this.calls.push([...args]);
    if (args[0] === "auth") {
      return this.#ok({ hosts: { "github.com": [{ state: this.authState, active: true, host: "github.com", login: this.login, tokenSource: this.tokenSource, scopes: "repo" }] } });
    }
    const endpoint = String(args[1]);
    if (endpoint === "user") return this.#ok(`${this.login}\n`);
    const methodIndex = args.indexOf("--method");
    const method = methodIndex >= 0 ? args[methodIndex + 1] : "GET";
    const body = options.stdin ? JSON.parse(options.stdin) as Record<string, unknown> : {};
    if (method === "POST") this.writes.push({ endpoint, body });

    if (this.login !== "jarxunlai") {
      for (const target of [CENTRAL_ARCHIVE_REPOSITORY, CENTRAL_CATALOG_REPOSITORY, PERSONAL_MODULE_REPOSITORY]) {
        const repositoryName = target.split("/")[1]!;
        const fork = `${this.login}/${repositoryName}`;
        if (endpoint === `repos/${fork}`) {
          if (!this.forkReady) return this.#notFound();
          return this.#ok({
            full_name: fork,
            default_branch: "main",
            archived: false,
            disabled: false,
            fork: true,
            parent: { full_name: target },
            permissions: { pull: true, push: true, maintain: true, admin: true },
          });
        }
        if (endpoint === `repos/${target}/forks` && method === "POST") {
          this.forkReady = true;
          return this.#ok({ full_name: fork, fork: true, parent: { full_name: target } });
        }
      }
    }

    for (const repository of [CENTRAL_ARCHIVE_REPOSITORY, CENTRAL_CATALOG_REPOSITORY, PERSONAL_MODULE_REPOSITORY]) {
      if (endpoint === `repos/${repository}`) {
        return this.#ok({
          full_name: repository,
          default_branch: "main",
          archived: false,
          disabled: false,
          fork: false,
          permissions: {
            pull: true,
            push: this.login === "jarxunlai" && this.centralWrite,
            maintain: false,
            admin: this.login === "jarxunlai" && this.centralWrite,
          },
        });
      }
      if (endpoint === `repos/${repository}/git/ref/heads/main`) return this.#ok({ object: { sha: this.baseCommit } });
      if (endpoint === `repos/${repository}/git/commits/${this.baseCommit}`) return this.#ok({ tree: { sha: this.baseTree } });
    }
    if (endpoint === `repos/${CENTRAL_ARCHIVE_REPOSITORY}/git/commits/${MERGE_COMMIT}`) {
      const parents = this.archiveMergeParents ?? [this.archiveBaseSha, this.archiveHeadSha];
      return this.#ok({ parents: parents.map((sha) => ({ sha })) });
    }
    const contents = /^repos\/(.+?\/.+?)\/contents\/(.+)\?ref=(.+)$/u.exec(endpoint);
    if (contents) {
      const repository = contents[1]!;
      const filePath = contents[2]!.split("/").map(decodeURIComponent).join("/");
      const ref = decodeURIComponent(contents[3]!);
      const content = this.files.get(`${repository}@${ref}:${filePath}`);
      if (!content) return this.#notFound();
      return this.#ok({ type: "file", sha: gitBlobSha(content), size: content.byteLength });
    }
    const blobGet = /^repos\/(.+?\/.+?)\/git\/blobs\/([a-f0-9]{40})$/u.exec(endpoint);
    if (blobGet && method === "GET") {
      const content = this.blobs.get(blobGet[2]!);
      if (!content) return this.#notFound();
      return this.#ok({ sha: blobGet[2], encoding: "base64", content: Buffer.from(content).toString("base64") });
    }
    const blobPost = /^repos\/(.+?\/.+?)\/git\/blobs$/u.exec(endpoint);
    if (blobPost && method === "POST") {
      const content = Buffer.from(String(body.content), "base64");
      this.uploadedBlobs.push(content);
      this.blobs.set(gitBlobSha(content), content);
      return this.#ok({ sha: gitBlobSha(content) });
    }
    if (/\/git\/ref\/heads\/sfl\//u.test(endpoint)) {
      return this.existingRefCommit ? this.#ok({ object: { sha: this.existingRefCommit } }) : this.#notFound();
    }
    if (this.existingRefCommit && endpoint.endsWith(`/git/commits/${this.existingRefCommit}`)) {
      return this.#ok({
        message: `publication\n\nSFL-Plan-Digest: ${this.existingCommitPlanDigest}`,
        parents: this.existingCommitParents.map((sha) => ({ sha })),
        tree: { sha: CREATED_TREE },
      });
    }
    if (/\/git\/trees$/u.test(endpoint) && method === "POST") return this.#ok({ sha: CREATED_TREE });
    if (/\/git\/commits$/u.test(endpoint) && method === "POST") return this.#ok({ sha: CREATED_COMMIT });
    if (/\/git\/refs$/u.test(endpoint) && method === "POST") return this.#ok({ object: { sha: CREATED_COMMIT } });
    if (endpoint === `repos/${CENTRAL_ARCHIVE_REPOSITORY}/pulls/${this.archivePullNumber}`) {
      return this.#ok({
        number: this.archivePullNumber,
        merged: this.merged,
        merged_at: this.merged ? "2026-08-21T05:00:00.000Z" : null,
        merge_commit_sha: this.merged ? MERGE_COMMIT : null,
        html_url: `https://github.com/${CENTRAL_ARCHIVE_REPOSITORY}/pull/${this.archivePullNumber}`,
        changed_files: 1,
        base: { ref: this.archiveBaseRef, sha: this.archiveBaseSha, repo: { full_name: this.archiveBaseRepository } },
        head: { ref: this.archiveHeadRef, sha: this.archiveHeadSha, repo: { full_name: this.archiveHeadRepository } },
        user: { login: this.archiveAuthor },
      });
    }
    if (endpoint === `repos/${CENTRAL_ARCHIVE_REPOSITORY}/pulls/${this.archivePullNumber}/files?per_page=100`) {
      return this.#ok([{ status: "added", filename: `archives/${this.archiveTemplateId}/${this.archiveReleaseVersion}/${this.archiveTemplateId}-${this.archiveReleaseVersion}.zip` }]);
    }
    if (endpoint === `repos/${CENTRAL_ARCHIVE_REPOSITORY}/actions/workflows/validate-archive-pr.yml`) {
      return this.#ok({
        id: this.validationWorkflowMetadataId,
        name: this.validationWorkflowMetadataName,
        path: this.validationWorkflowMetadataPath,
        state: this.validationWorkflowMetadataState,
      });
    }
    const workflowRuns = new RegExp(
      `^repos/${CENTRAL_ARCHIVE_REPOSITORY}/actions/workflows/[^/]+/runs\\?`,
      "u",
    ).exec(endpoint);
    if (workflowRuns) {
      const matchingPage = Array.from({ length: 10 }, (_, index) => index + 1).find((page) => endpoint ===
        `repos/${CENTRAL_ARCHIVE_REPOSITORY}/actions/workflows/${String(this.validationWorkflowMetadataId)}/runs?event=pull_request_target&status=completed&head_sha=${this.archiveHeadSha}&per_page=100&page=${page}`);
      if (matchingPage === undefined) return this.#ok({ workflow_runs: [] });
      const displayTitle = this.validationDisplayTitle === undefined
        ? `sfl-archive-validation-v2 base=${this.archiveBaseSha} head=${this.archiveHeadSha}`
        : this.validationDisplayTitle;
      const runName = this.validationRunName === undefined ? displayTitle : this.validationRunName;
      return this.#ok({ workflow_runs: [{
        id: 99,
        status: "completed",
        conclusion: this.validationSuccess ? "success" : "failure",
        event: this.validationEvent,
        ...(runName === null ? {} : { name: runName }),
        workflow_id: this.validationWorkflowId ?? this.validationWorkflowMetadataId,
        path: this.validationWorkflowPath,
        ...(displayTitle === null ? {} : { display_title: displayTitle }),
        head_branch: this.validationHeadBranch ?? this.archiveHeadRef,
        head_sha: this.validationHeadSha ?? this.archiveHeadSha,
        repository: { full_name: this.validationRepository },
        head_repository: { full_name: this.validationHeadRepository ?? this.archiveHeadRepository },
        html_url: `https://github.com/${CENTRAL_ARCHIVE_REPOSITORY}/actions/runs/99`,
        ...(this.validationPullRequests === undefined ? {} : { pull_requests: this.validationPullRequests }),
      }] });
    }
    if (/\/pulls\?state=all/u.test(endpoint)) {
      if (this.existingPrState === "none") return this.#ok([]);
      return this.#ok([{
        number: 88,
        html_url: `https://github.com/${CENTRAL_ARCHIVE_REPOSITORY}/pull/88`,
        body: this.existingCommitPlanDigest,
        state: this.existingPrState === "open" ? "open" : "closed",
        merged: false,
        merged_at: null,
        head: { sha: this.existingRefCommit ?? CREATED_COMMIT },
      }]);
    }
    const pullGet = /^repos\/(.+?\/.+?)\/pulls\/(\d+)$/u.exec(endpoint);
    if (pullGet && method === "GET") {
      const number = Number(pullGet[2]);
      const created = this.createdPulls.get(number);
      if (!created || created.targetRepository !== pullGet[1]) return this.#notFound();
      const merged = this.receiptPrState === "merged";
      return this.#ok({
        number,
        html_url: `https://github.com/${created.targetRepository}/pull/${number}`,
        state: this.receiptPrState === "open" ? "open" : "closed",
        merged,
        merged_at: merged ? "2026-08-21T06:30:00.000Z" : null,
        base: { ref: "main", repo: { full_name: created.targetRepository } },
        head: {
          repo: { full_name: this.receiptPrHeadRepository ?? created.headRepository },
          ref: this.receiptPrBranch ?? created.branch,
          sha: this.receiptPrCommit ?? created.commit,
        },
      });
    }
    if (/\/pulls$/u.test(endpoint) && method === "POST") {
      const number = this.nextPullNumber++;
      const repository = endpoint.slice("repos/".length, -"/pulls".length);
      const [owner, branch] = String(body.head).split(":", 2);
      const repositoryName = repository.split("/")[1]!;
      this.createdPulls.set(number, {
        targetRepository: repository,
        headRepository: owner === repository.split("/")[0] ? repository : `${owner}/${repositoryName}`,
        branch: branch!,
        commit: this.existingRefCommit ?? CREATED_COMMIT,
      });
      return this.#ok({ number, html_url: `https://github.com/${repository}/pull/${number}` });
    }
    return this.#notFound();
  }
}

function registerEmptyCatalog(runner: MockGhRunner) {
  runner.registerFile({
    repository: CENTRAL_CATALOG_REPOSITORY,
    ref: BASE_COMMIT,
    path: "catalog/catalog.json",
    bytes: bytes({
      schema: "figure-library.public-provider-catalog.v1",
      provider: {
        providerId: "io.github.jarxunlai.scientific-figure-community",
        displayName: "Scientific Figure Library Community",
        catalogRepository: CENTRAL_CATALOG_REPOSITORY,
        archiveRepository: CENTRAL_ARCHIVE_REPOSITORY,
      },
      generatedAt: "2026-08-21T00:00:00.000Z",
      entries: [],
    }),
  });
  runner.registerFile({
    repository: CENTRAL_CATALOG_REPOSITORY,
    ref: BASE_COMMIT,
    path: "catalog/preview-manifest.json",
    bytes: bytes({ schema: "figure-library.public-preview-manifest.v1", providerId: "io.github.jarxunlai.scientific-figure-community", entries: [] }),
  });
}

test("GitHub auth tools expose only safe status/instructions and never invoke login or token commands", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-github-auth-"));
  const runner = new MockGhRunner();
  const service = new GitHubPublicationService({ ghRunner: runner, receiptDirectory: path.join(root, "receipts") });
  try {
    const status = await service.authStatus();
    assert.equal(status.status, "authenticated");
    assert.equal(status.login, "jarxunlai");
    assert.equal(status.credentialStorage, "managed_by_github_cli");
    assert.equal(status.secureStorageVerified, false, "GH_TOKEN cannot be claimed as verified OS-vault storage");
    assert.equal(status.tokenReadBySfl, false);
    const instructions = service.authInstructions();
    assert.match(instructions.command, /^gh auth login /u);
    assert.equal(instructions.launchedBySfl, false);
    assert.ok(runner.calls.every((args) => !args.join(" ").includes("auth token") && !args.includes("--show-token")));

    const missing: GhRunner = { async run() { return { exitCode: -1, stdout: "", stderr: "", errorCode: "ENOENT" }; } };
    const missingStatus = await new GitHubPublicationService({ ghRunner: missing, receiptDirectory: path.join(root, "missing") }).authStatus();
    assert.equal(missingStatus.status, "cli_missing");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("GitHub auth status distinguishes no login, invalid credentials, scope denial, and network failure without echoing stderr", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-github-auth-errors-"));
  const authJson = (state = "success") => JSON.stringify({
    hosts: { "github.com": [{ state, active: true, host: "github.com", login: "jarxunlai", tokenSource: "oauth_token" }] },
  });
  const cases: Array<[string, GhRunner, string]> = [
    ["not_authenticated", { async run(args) {
      return args[0] === "auth"
        ? { exitCode: 0, stdout: JSON.stringify({ hosts: { "github.com": [] } }), stderr: "" }
        : { exitCode: 1, stdout: "", stderr: "should not be called" };
    } }, "not_authenticated"],
    ["credential_invalid", { async run(args) {
      return args[0] === "auth"
        ? { exitCode: 0, stdout: authJson("failure"), stderr: "" }
        : { exitCode: 1, stdout: "", stderr: "should not be called" };
    } }, "credential_invalid"],
    ["insufficient_scope", { async run(args) {
      if (args[0] === "auth") return { exitCode: 0, stdout: authJson(), stderr: "" };
      if (args[1] === "user") return { exitCode: 0, stdout: "jarxunlai\n", stderr: "" };
      return { exitCode: 1, stdout: "", stderr: "HTTP 403: Resource not accessible by personal access token SECRET_MUST_NOT_ECHO" };
    } }, "insufficient_scope"],
    ["github_unreachable", { async run(args) {
      if (args[0] === "auth") return { exitCode: 0, stdout: authJson(), stderr: "" };
      if (args[1] === "user") return { exitCode: 0, stdout: "jarxunlai\n", stderr: "" };
      return { exitCode: 1, stdout: "", stderr: "network is unreachable SECRET_MUST_NOT_ECHO" };
    } }, "github_unreachable"],
  ];
  try {
    for (const [name, runner, expected] of cases) {
      const status = await new GitHubPublicationService({ ghRunner: runner, receiptDirectory: path.join(root, name) }).authStatus();
      assert.equal(status.status, expected);
      assert.doesNotMatch(JSON.stringify(status), /SECRET_MUST_NOT_ECHO/u);
      assert.equal(status.login, ["insufficient_scope", "github_unreachable"].includes(expected) ? "jarxunlai" : null);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Archive ZIP bytes and reviewed DOS metadata are identical across timezones", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-archive-timezones-"));
  const originalTimezone = process.env.TZ;
  const zones = ["UTC", "Asia/Shanghai", "America/Los_Angeles"] as const;
  const observedUtcEpochHours = new Set<number>();
  const archives: Buffer[] = [];
  try {
    const directory = await writeSubmission(root);
    for (const zone of zones) {
      process.env.TZ = zone;
      observedUtcEpochHours.add(new Date("1980-01-01T00:00:00.000Z").getHours());
      const label = zone.replace(/[^A-Za-z0-9]+/gu, "-").toLowerCase();
      const runner = new MockGhRunner();
      const service = new GitHubPublicationService({
        ghRunner: runner,
        receiptDirectory: path.join(root, `receipts-${label}`),
        now: () => new Date("2026-08-21T06:00:00.000Z"),
      });
      const plan = await service.plan({ action: "archive", submissionDirectory: directory });
      await service.apply(plan.planDigest, `archive-timezone-${label}`);
      const archiveZip = runner.uploadedBlobs.find((item) => sha256(item) === plan.files[0]!.sha256);
      assert.ok(archiveZip, `${zone}: Archive Apply must upload the planned ZIP bytes`);
      assertArchivePolicyZipMetadata(archiveZip);
      archives.push(Buffer.from(archiveZip));
    }
    assert.ok(observedUtcEpochHours.size > 1, "the regression must exercise distinct local-time projections of the same UTC instant");
    for (let index = 1; index < archives.length; index += 1) {
      assert.deepEqual(archives[index], archives[0], `${zones[index]} must emit the exact UTC reference ZIP bytes`);
    }
  } finally {
    if (originalTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = originalTimezone;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("frozen seed Catalog evidence is conservatively derived and never treats seed metadata as GitHub publisher verification", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-real-seed-catalog-"));
  const templateId = "seed-clean-room-bars";
  const directory = await writeFrozenSeedSubmission(root, templateId);
  const runner = new MockGhRunner();
  runner.archivePullNumber = 31;
  runner.archiveTemplateId = templateId;
  runner.archiveReleaseVersion = "1.0.0";
  runner.archiveAuthor = "jarxunlai";
  const service = new GitHubPublicationService({ ghRunner: runner, receiptDirectory: path.join(root, "receipts") });
  try {
    const archivePlan = await service.plan({ action: "archive", submissionDirectory: directory });
    await service.apply(archivePlan.planDigest, "frozen-seed-capture-archive");
    const archiveZip = runner.uploadedBlobs.find((item) => item.byteLength === archivePlan.files[0]!.bytes);
    assert.ok(archiveZip);
    const archivePath = `archives/${templateId}/1.0.0/${templateId}-1.0.0.zip`;
    runner.registerFile({ repository: CENTRAL_ARCHIVE_REPOSITORY, ref: MERGE_COMMIT, path: archivePath, bytes: archiveZip });
    registerEmptyCatalog(runner);
    const writesBeforeCatalogPlan = runner.writes.length;
    const catalogPlan = await service.plan({
      action: "catalog",
      archivePullRequestNumber: 31,
      expectedTemplateId: templateId,
      expectedReleaseVersion: "1.0.0",
    });
    assert.equal(catalogPlan.written, false);
    assert.equal(runner.writes.length, writesBeforeCatalogPlan, "Catalog Plan must not write GitHub");
    const entryPath = `catalog/entries/${templateId}/1.0.0.json`;
    const entryFile = catalogPlan.files.find((item) => item.path === entryPath);
    assert.ok(entryFile);
    await service.apply(catalogPlan.planDigest, "frozen-seed-catalog-apply");
    const entryBlob = runner.uploadedBlobs.find((item) => sha256(item) === entryFile.sha256);
    assert.ok(entryBlob);
    const entry = JSON.parse(Buffer.from(entryBlob).toString("utf8")) as Record<string, any>;
    assert.equal(entry.title, "Seed clean-room bars");
    assert.equal(entry.description, "A neutral clean-room bar template generated from synthetic data.");
    assert.equal(entry.search.application, entry.description);
    assert.equal(entry.search.dataProfile, "Synthetic data: data.csv");
    assert.equal(entry.search.plotFamily, "bar");
    assert.equal(entry.search.language, "R");
    assert.deepEqual(entry.search.tags, ["bar chart", "synthetic"]);
    assert.deepEqual(entry.search.codeFiles, ["payload/code/render.R"]);
    assert.deepEqual(entry.search.inputFiles, ["payload/data/data.csv"]);
    assert.equal(entry.status.publisherVerified, false, "seed metadata cannot stand in for a publisher/GitHub identity claim");
    assert.deepEqual(entry.status, {
      upstreamStatus: "published",
      publisherVerified: false,
      curationStatus: "curated",
      renderValidation: "ci_rendered",
      localReviewStatus: "not_reviewed",
      plotExecutionByRecipient: "not_run",
    });
    assert.deepEqual(entry.provenance, [{ type: "note", value: "Clean-room authored code, neutral synthetic data, and code-generated preview." }]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Archive Plan is deterministic/read-only; Apply uses Git Data API, never merge, and operationId replays", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-github-archive-"));
  const directory = await writeSubmission(root);
  const runner = new MockGhRunner();
  const service = new GitHubPublicationService({
    ghRunner: runner,
    receiptDirectory: path.join(root, "receipts"),
    now: () => new Date("2026-08-21T06:00:00.000Z"),
  });
  try {
    const first = await service.plan({ action: "archive", submissionDirectory: directory });
    const second = await service.plan({ action: "archive", submissionDirectory: directory });
    assert.equal(first.planDigest, second.planDigest);
    assert.equal(first.expectedGithubLogin, "jarxunlai");
    assert.equal(first.files.length, 1);
    assert.match(first.files[0]!.path, /^archives\/clean-room-bars\/1\.0\.0\//u);
    assert.equal(first.written, false);
    assert.equal(runner.writes.length, 0, "Plan must not mutate GitHub");

    const applied = await service.apply(first.planDigest, "archive-operation-1");
    assert.equal(applied.outcome, "applied");
    assert.ok(runner.writes.some((item) => item.endpoint.endsWith("/git/blobs")));
    assert.ok(runner.writes.some((item) => item.endpoint.endsWith("/git/trees")));
    assert.ok(runner.writes.some((item) => item.endpoint.endsWith("/git/commits")));
    assert.ok(runner.writes.some((item) => item.endpoint.endsWith("/git/refs")));
    assert.ok(runner.writes.some((item) => item.endpoint.endsWith("/pulls")));
    assert.ok(runner.writes.every((item) => !/merge/iu.test(item.endpoint)), "Apply must never call a merge endpoint");
    const writeCount = runner.writes.length;
    const replay = await service.apply(first.planDigest, "archive-operation-1");
    assert.equal(replay.outcome, "replayed");
    assert.equal(runner.writes.length, writeCount, "receipt replay must not create another branch or PR");
    assert.ok(runner.calls.some((args) => args[1] === `repos/${CENTRAL_ARCHIVE_REPOSITORY}/pulls/${applied.receipt.pullRequestNumber}`));
    runner.receiptPrState = "merged";
    const mergedReplay = await service.apply(first.planDigest, "archive-operation-1");
    assert.equal(mergedReplay.outcome, "replayed", "a merged receipt-bound PR remains a valid replay");
    assert.equal(runner.writes.length, writeCount, "merged receipt replay must remain read-only");
    await assert.rejects(() => service.apply("f".repeat(64), "archive-operation-1"), /different GitHub publication Plan/u);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

for (const releaseVersion of ["1.0.0+build.9", "1.0.0-rc.1+build"] as const) {
  test(`Archive Plan preserves strict SemVer build identity in repository paths: ${releaseVersion}`, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-github-semver-"));
    try {
      const directory = await writeSubmission(root, "clean-room-bars", releaseVersion);
      const runner = new MockGhRunner();
      const service = new GitHubPublicationService({
        ghRunner: runner,
        receiptDirectory: path.join(root, "receipts"),
      });

      const plan = await service.plan({ action: "archive", submissionDirectory: directory });

      assert.equal(plan.identity.releaseVersion, releaseVersion);
      assert.equal(
        plan.files[0]?.path,
        `archives/clean-room-bars/${releaseVersion}/clean-room-bars-${releaseVersion}.zip`,
      );
      assert.equal(runner.writes.length, 0);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
}

test("receipt replay revalidates login, PR state, and exact head identity without GitHub writes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-github-receipt-revalidation-"));
  const directory = await writeSubmission(root);
  const cases: Array<{
    name: string;
    mutate: (runner: MockGhRunner) => void;
    error: RegExp;
  }> = [
    { name: "closed-unmerged", mutate: (runner) => { runner.receiptPrState = "closed_unmerged"; }, error: /closed without merge/u },
    { name: "login-change", mutate: (runner) => { runner.login = "other-user"; }, error: /login changed/u },
    { name: "head-sha-drift", mutate: (runner) => { runner.receiptPrCommit = "f".repeat(40); }, error: /identity changed/u },
    { name: "head-branch-drift", mutate: (runner) => { runner.receiptPrBranch = "sfl/archive/drifted"; }, error: /identity changed/u },
    { name: "head-repository-drift", mutate: (runner) => { runner.receiptPrHeadRepository = "other-user/other-repository"; }, error: /identity changed/u },
  ];
  try {
    for (const item of cases) {
      const runner = new MockGhRunner();
      const service = new GitHubPublicationService({
        ghRunner: runner,
        receiptDirectory: path.join(root, `${item.name}-receipts`),
      });
      const plan = await service.plan({ action: "archive", submissionDirectory: directory });
      await service.apply(plan.planDigest, `receipt-${item.name}`);
      runner.writes.length = 0;
      item.mutate(runner);
      await assert.rejects(() => service.apply(plan.planDigest, `receipt-${item.name}`), item.error);
      assert.equal(runner.writes.length, 0, `${item.name} receipt revalidation must remain read-only`);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Catalog Plan refuses an unmerged Archive PR, then verifies merge ZIP/inventory and proposes only five allowed files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-github-catalog-"));
  const directory = await writeSubmission(root);
  const runner = new MockGhRunner();
  const receiptDirectory = path.join(root, "receipts");
  const service = new GitHubPublicationService({ ghRunner: runner, receiptDirectory });
  try {
    const archivePlan = await service.plan({ action: "archive", submissionDirectory: directory });
    await service.apply(archivePlan.planDigest, "capture-archive-zip");
    const archiveZip = runner.uploadedBlobs.find((item) => item.byteLength === archivePlan.files[0]!.bytes);
    assert.ok(archiveZip);
    const archivePath = "archives/clean-room-bars/1.0.0/clean-room-bars-1.0.0.zip";
    runner.registerFile({ repository: CENTRAL_ARCHIVE_REPOSITORY, ref: MERGE_COMMIT, path: archivePath, bytes: archiveZip });
    runner.registerFile({
      repository: CENTRAL_CATALOG_REPOSITORY,
      ref: BASE_COMMIT,
      path: "catalog/catalog.json",
      bytes: bytes({
        schema: "figure-library.public-provider-catalog.v1",
        provider: {
          providerId: "io.github.jarxunlai.scientific-figure-community",
          displayName: "Scientific Figure Library Community",
          catalogRepository: CENTRAL_CATALOG_REPOSITORY,
          archiveRepository: CENTRAL_ARCHIVE_REPOSITORY,
        },
        generatedAt: "2026-08-21T00:00:00.000Z",
        entries: [],
      }),
    });
    runner.registerFile({
      repository: CENTRAL_CATALOG_REPOSITORY,
      ref: BASE_COMMIT,
      path: "catalog/preview-manifest.json",
      bytes: bytes({ schema: "figure-library.public-preview-manifest.v1", providerId: "io.github.jarxunlai.scientific-figure-community", entries: [] }),
    });

    runner.merged = false;
    await assert.rejects(
      () => service.plan({ action: "catalog", archivePullRequestNumber: 17, expectedTemplateId: "clean-room-bars", expectedReleaseVersion: "1.0.0" }),
      /requires a merged/u,
    );
    runner.merged = true;
    runner.validationSuccess = false;
    await assert.rejects(
      () => service.plan({ action: "catalog", archivePullRequestNumber: 17, expectedTemplateId: "clean-room-bars", expectedReleaseVersion: "1.0.0" }),
      /no successful fixed-render CI run/u,
    );
    runner.validationSuccess = true;
    const writeCount = runner.writes.length;
    const catalogPlan = await service.plan({ action: "catalog", archivePullRequestNumber: 17, expectedTemplateId: "clean-room-bars", expectedReleaseVersion: "1.0.0" });
    assert.equal(runner.writes.length, writeCount, "Catalog Plan is read-only");
    assert.equal(catalogPlan.files.length, 5);
    assert.deepEqual(
      catalogPlan.files.map((item) => item.path),
      [
        "catalog/catalog.json",
        "catalog/entries/clean-room-bars/1.0.0.json",
        "catalog/preview-manifest.json",
        "reviews/clean-room-bars/1.0.0.md",
        "thumbs/clean-room-bars/1.0.0.png",
      ],
    );
    assert.equal(catalogPlan.archive?.commit, MERGE_COMMIT);
    assert.equal(catalogPlan.archive?.sha256, sha256(archiveZip));
    assert.ok(catalogPlan.files.every((item) => !item.path.startsWith(".github/") && !/workflow|policy/iu.test(item.path)));

    runner.registerFile({ repository: CENTRAL_ARCHIVE_REPOSITORY, ref: MERGE_COMMIT, path: archivePath, bytes: Buffer.from("tampered archive") });
    const beforeStaleApply = runner.writes.length;
    await assert.rejects(() => service.apply(catalogPlan.planDigest, "catalog-operation-stale"));
    assert.equal(runner.writes.length, beforeStaleApply, "archive bytes changing after Plan must fail before a GitHub write");

    runner.registerFile({ repository: CENTRAL_ARCHIVE_REPOSITORY, ref: MERGE_COMMIT, path: archivePath, bytes: archiveZip });
    const applied = await service.apply(catalogPlan.planDigest, "catalog-operation-1");
    assert.equal(applied.outcome, "applied");
    const catalogWrites = runner.writes.slice(beforeStaleApply);
    assert.equal(catalogWrites.filter((item) => item.endpoint.endsWith("/git/blobs")).length, 5);
    assert.ok(catalogWrites.some((item) => item.endpoint === `repos/${CENTRAL_CATALOG_REPOSITORY}/pulls`));
    assert.ok(catalogWrites.every((item) => !/merge/iu.test(item.endpoint)));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Catalog Plan accepts only current-policy Archive CI evidence for the exact PR, head, and merge-time base", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-archive-ci-evidence-"));
  const directory = await writeSubmission(root);
  const producerRunner = new MockGhRunner();
  const producerService = new GitHubPublicationService({
    ghRunner: producerRunner,
    receiptDirectory: path.join(root, "producer-receipts"),
  });
  try {
    const archivePlan = await producerService.plan({ action: "archive", submissionDirectory: directory });
    await producerService.apply(archivePlan.planDigest, "ci-evidence-archive-zip");
    const archiveZip = producerRunner.uploadedBlobs.find((item) => item.byteLength === archivePlan.files[0]!.bytes);
    assert.ok(archiveZip);
    const archivePath = "archives/clean-room-bars/1.0.0/clean-room-bars-1.0.0.zip";
    const cases: Array<{
      name: string;
      accepted: boolean;
      mutate(runner: MockGhRunner): void;
      error?: RegExp;
    }> = [
      { name: "post-merge custom run-name with empty pull_requests", accepted: true, mutate() {} },
      { name: "arbitrary raw run name", accepted: true, mutate(runner) { runner.validationRunName = "custom run label"; } },
      { name: "missing mutable pull_requests links", accepted: true, mutate(runner) { runner.validationPullRequests = undefined; } },
      { name: "missing run-name", accepted: false, mutate(runner) { runner.validationDisplayTitle = null; } },
      { name: "old unversioned run-name", accepted: false, mutate(runner) { runner.validationDisplayTitle = "validate Archive PR"; } },
      {
        name: "wrong run-name base",
        accepted: false,
        mutate(runner) { runner.validationDisplayTitle = `sfl-archive-validation-v2 base=${"e".repeat(40)} head=${runner.archiveHeadSha}`; },
      },
      {
        name: "wrong run-name head",
        accepted: false,
        mutate(runner) { runner.validationDisplayTitle = `sfl-archive-validation-v2 base=${runner.archiveBaseSha} head=${"e".repeat(40)}`; },
      },
      {
        name: "wrong run-name policy version",
        accepted: false,
        mutate(runner) { runner.validationDisplayTitle = `sfl-archive-validation-v1 base=${runner.archiveBaseSha} head=${runner.archiveHeadSha}`; },
      },
      { name: "wrong event", accepted: false, mutate(runner) { runner.validationEvent = "pull_request"; } },
      { name: "wrong workflow ID", accepted: false, mutate(runner) { runner.validationWorkflowId = 9_999; } },
      { name: "invalid workflow metadata ID", accepted: false, mutate(runner) { runner.validationWorkflowMetadataId = 0; }, error: /workflow metadata/u },
      { name: "wrong workflow metadata name", accepted: false, mutate(runner) { runner.validationWorkflowMetadataName = "lookalike-validator"; }, error: /workflow metadata/u },
      { name: "wrong workflow metadata path", accepted: false, mutate(runner) { runner.validationWorkflowMetadataPath = ".github/workflows/lookalike.yml"; }, error: /workflow metadata/u },
      { name: "mutable workflow availability state", accepted: true, mutate(runner) { runner.validationWorkflowMetadataState = "disabled_manually"; } },
      { name: "wrong run workflow path", accepted: false, mutate(runner) { runner.validationWorkflowPath = ".github/workflows/lookalike.yml"; } },
      { name: "wrong run head branch", accepted: false, mutate(runner) { runner.validationHeadBranch = "sfl/archive/lookalike"; } },
      { name: "wrong run repository", accepted: false, mutate(runner) { runner.validationRepository = "attacker/archive-fork"; } },
      { name: "wrong run head repository", accepted: false, mutate(runner) { runner.validationHeadRepository = "attacker/archive-fork"; } },
      { name: "wrong run head SHA", accepted: false, mutate(runner) { runner.validationHeadSha = "e".repeat(40); } },
      { name: "wrong PR base repository", accepted: false, mutate(runner) { runner.archiveBaseRepository = "attacker/archive-fork"; }, error: /requires a merged/u },
      { name: "wrong PR base ref", accepted: false, mutate(runner) { runner.archiveBaseRef = "legacy"; }, error: /requires a merged/u },
      { name: "wrong PR base parent", accepted: false, mutate(runner) { runner.archiveMergeParents = ["e".repeat(40), runner.archiveHeadSha]; }, error: /exact PR base and head parents/u },
      {
        name: "non-merge commit",
        accepted: false,
        mutate(runner) { runner.archiveMergeParents = [runner.archiveBaseSha]; },
        error: /requires a two-parent Archive merge commit/u,
      },
      {
        name: "merge commit does not incorporate PR head",
        accepted: false,
        mutate(runner) { runner.archiveMergeParents = [runner.archiveBaseSha, "e".repeat(40)]; },
        error: /requires a two-parent Archive merge commit/u,
      },
    ];

    for (const item of cases) {
      const runner = new MockGhRunner();
      runner.registerFile({ repository: CENTRAL_ARCHIVE_REPOSITORY, ref: MERGE_COMMIT, path: archivePath, bytes: archiveZip });
      registerEmptyCatalog(runner);
      item.mutate(runner);
      const service = new GitHubPublicationService({ ghRunner: runner, receiptDirectory: path.join(root, item.name) });
      const request = {
        action: "catalog" as const,
        archivePullRequestNumber: runner.archivePullNumber,
        expectedTemplateId: "clean-room-bars",
        expectedReleaseVersion: "1.0.0",
      };
      if (item.accepted) {
        const catalogPlan = await service.plan(request);
        assert.equal(catalogPlan.archive?.validationRun, `https://github.com/${CENTRAL_ARCHIVE_REPOSITORY}/actions/runs/99`);
        const expectedRunsEndpoint =
          `repos/${CENTRAL_ARCHIVE_REPOSITORY}/actions/workflows/${String(runner.validationWorkflowMetadataId)}/runs?event=pull_request_target&status=completed&head_sha=${runner.archiveHeadSha}&per_page=100&page=1`;
        const observedRunsEndpoints = runner.calls
          .map((args) => args[1])
          .filter((endpoint) => typeof endpoint === "string" && endpoint.includes("/actions/workflows/") && endpoint.includes("/runs?"));
        assert.deepEqual(observedRunsEndpoints, [expectedRunsEndpoint], `${item.name}: runs query must use numeric workflow ID and exact head_sha`);
      } else {
        await assert.rejects(() => service.plan(request), item.error ?? /no successful fixed-render CI run/u, item.name);
      }
      assert.equal(runner.writes.length, 0, `${item.name}: CI evidence observation must remain read-only`);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Apply fails closed before writes when the authenticated account changes after Plan", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-github-stale-"));
  const directory = await writeSubmission(root);
  const runner = new MockGhRunner();
  const service = new GitHubPublicationService({ ghRunner: runner, receiptDirectory: path.join(root, "receipts") });
  try {
    const plan = await service.plan({ action: "archive", submissionDirectory: directory });
    runner.login = "different-user";
    await assert.rejects(() => service.apply(plan.planDigest, "stale-account"));
    assert.equal(runner.writes.length, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Apply fails closed before writes when repository permission changes after Plan", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-github-permission-"));
  const directory = await writeSubmission(root);
  const runner = new MockGhRunner();
  const service = new GitHubPublicationService({ ghRunner: runner, receiptDirectory: path.join(root, "receipts") });
  try {
    const plan = await service.plan({ action: "archive", submissionDirectory: directory });
    assert.equal(plan.target.permission, "admin");
    runner.centralWrite = false;
    await assert.rejects(() => service.apply(plan.planDigest, "stale-permission"));
    assert.equal(runner.writes.length, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("non-maintainer Apply creates and uses only the user's central-repository fork", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-github-fork-"));
  const directory = await writeSubmission(root);
  const runner = new MockGhRunner();
  runner.login = "community-user";
  const service = new GitHubPublicationService({ ghRunner: runner, receiptDirectory: path.join(root, "receipts") });
  try {
    const plan = await service.plan({ action: "archive", submissionDirectory: directory });
    assert.equal(plan.head.repository, "community-user/ScientificFigureLibrary-community-archives");
    assert.equal(plan.head.forkWillBeCreated, true);
    assert.equal(plan.head.permission, "fork_creation_required");
    const applied = await service.apply(plan.planDigest, "fork-operation");
    assert.equal(applied.outcome, "applied");
    assert.ok(runner.writes.some((item) => item.endpoint === `repos/${CENTRAL_ARCHIVE_REPOSITORY}/forks`));
    assert.ok(runner.writes.some((item) => item.endpoint.startsWith("repos/community-user/ScientificFigureLibrary-community-archives/git/")));
    assert.ok(runner.writes.every((item) => !/merge/iu.test(item.endpoint)));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Archive Plan recomputes contentDigest and rejects asset mutation even when declarations and inventory are updated", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-github-content-digest-"));
  try {
    const directory = await writeSubmission(root);
    await replaceDeclaredAsset(directory, "payload/code/render.R", Buffer.from("# materially changed renderer\n", "utf8"));
    const service = new GitHubPublicationService({ ghRunner: new MockGhRunner(), receiptDirectory: path.join(root, "receipts") });
    await assert.rejects(() => service.plan({ action: "archive", submissionDirectory: directory }), /contentDigest does not match/u);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Archive Plan rejects strict-SemVer violations and scans complete text assets for absolute private paths", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-github-input-policy-"));
  try {
    const service = new GitHubPublicationService({ ghRunner: new MockGhRunner(), receiptDirectory: path.join(root, "receipts") });
    await assert.rejects(() => service.plan({
      action: "catalog", archivePullRequestNumber: 1, expectedTemplateId: "safe-id", expectedReleaseVersion: "1.0.0-01",
    }), /catalog Plan requires/u);
    const directory = await writeSubmission(root);
    await replaceDeclaredAsset(directory, "payload/code/render.R", Buffer.from("source('E:\\\\private\\\\render.R')\n", "utf8"));
    await assert.rejects(() => service.plan({ action: "archive", submissionDirectory: directory }), /absolute\/private machine path/u);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Catalog Plan rejects trailing and multi-disk ZIP records plus malformed base manifests", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-github-zip-policy-"));
  const directory = await writeSubmission(root);
  const runner = new MockGhRunner();
  const service = new GitHubPublicationService({ ghRunner: runner, receiptDirectory: path.join(root, "receipts") });
  try {
    const archivePlan = await service.plan({ action: "archive", submissionDirectory: directory });
    await service.apply(archivePlan.planDigest, "zip-policy-capture");
    const archiveZip = runner.uploadedBlobs.find((item) => item.byteLength === archivePlan.files[0]!.bytes)!;
    const archivePath = "archives/clean-room-bars/1.0.0/clean-room-bars-1.0.0.zip";
    registerEmptyCatalog(runner);
    runner.registerFile({ repository: CENTRAL_ARCHIVE_REPOSITORY, ref: MERGE_COMMIT, path: archivePath, bytes: Buffer.concat([archiveZip, Buffer.from([0])]) });
    await assert.rejects(() => service.plan({ action: "catalog", archivePullRequestNumber: 17, expectedTemplateId: "clean-room-bars", expectedReleaseVersion: "1.0.0" }), /trailing|end record/u);

    const multiDisk = Buffer.from(archiveZip);
    const eocd = multiDisk.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    assert.ok(eocd >= 0);
    multiDisk.writeUInt16LE(1, eocd + 4);
    runner.registerFile({ repository: CENTRAL_ARCHIVE_REPOSITORY, ref: MERGE_COMMIT, path: archivePath, bytes: multiDisk });
    await assert.rejects(() => service.plan({ action: "catalog", archivePullRequestNumber: 17, expectedTemplateId: "clean-room-bars", expectedReleaseVersion: "1.0.0" }), /multi-disk/u);

    runner.registerFile({ repository: CENTRAL_ARCHIVE_REPOSITORY, ref: MERGE_COMMIT, path: archivePath, bytes: archiveZip });
    runner.registerFile({
      repository: CENTRAL_CATALOG_REPOSITORY, ref: BASE_COMMIT, path: "catalog/catalog.json",
      bytes: bytes({ schema: "figure-library.public-provider-catalog.v1", provider: { providerId: CENTRAL_PUBLIC_PROVIDER_ID }, entries: [], extra: true }),
    });
    await assert.rejects(() => service.plan({ action: "catalog", archivePullRequestNumber: 17, expectedTemplateId: "clean-room-bars", expectedReleaseVersion: "1.0.0" }), /Catalog|catalog/u);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Apply rejects base races, non-single-parent recovery commits, closed-unmerged PR replay, and corrupt receipts", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-github-recovery-policy-"));
  try {
    const directory = await writeSubmission(root);

    const baseRunner = new MockGhRunner();
    const baseService = new GitHubPublicationService({ ghRunner: baseRunner, receiptDirectory: path.join(root, "base-receipts") });
    const basePlan = await baseService.plan({ action: "archive", submissionDirectory: directory });
    baseRunner.baseCommit = "f".repeat(40);
    await assert.rejects(() => baseService.apply(basePlan.planDigest, "base-race"), /changed after planning/u);
    assert.equal(baseRunner.writes.length, 0);

    const parentRunner = new MockGhRunner();
    const parentService = new GitHubPublicationService({ ghRunner: parentRunner, receiptDirectory: path.join(root, "parent-receipts") });
    const parentPlan = await parentService.plan({ action: "archive", submissionDirectory: directory });
    parentRunner.existingRefCommit = CREATED_COMMIT;
    parentRunner.existingCommitPlanDigest = parentPlan.planDigest;
    parentRunner.existingCommitParents = [BASE_COMMIT, "f".repeat(40)];
    await assert.rejects(() => parentService.apply(parentPlan.planDigest, "parent-race"), /wrong base parent/u);

    const closedRunner = new MockGhRunner();
    const closedService = new GitHubPublicationService({ ghRunner: closedRunner, receiptDirectory: path.join(root, "closed-receipts") });
    const closedPlan = await closedService.plan({ action: "archive", submissionDirectory: directory });
    closedRunner.existingCommitPlanDigest = closedPlan.planDigest;
    closedRunner.existingPrState = "closed_unmerged";
    await assert.rejects(() => closedService.apply(closedPlan.planDigest, "closed-pr"), /closed without merge/u);

    const receiptRunner = new MockGhRunner();
    const receiptDirectory = path.join(root, "strict-receipts");
    const receiptService = new GitHubPublicationService({ ghRunner: receiptRunner, receiptDirectory });
    const receiptPlan = await receiptService.plan({ action: "archive", submissionDirectory: directory });
    await receiptService.apply(receiptPlan.planDigest, "strict-receipt");
    const receiptPath = path.join(receiptDirectory, `${sha256("strict-receipt")}.json`);
    const receipt = JSON.parse(await fs.readFile(receiptPath, "utf8")) as Record<string, unknown>;
    receipt.unexpected = true;
    await fs.writeFile(receiptPath, `${canonicalJson(receipt)}\n`, "utf8");
    await assert.rejects(() => receiptService.apply(receiptPlan.planDigest, "strict-receipt"), /fixed v1 shape/u);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("MCP registration exposes exactly the four GitHub contracts without using a real gh process", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-github-mcp-"));
  const runner = new MockGhRunner();
  const server = new McpServer({ name: "github-publication-test", version: "0.6.0" });
  registerGitHubPublicationTools({ server, ghRunner: runner, receiptDirectory: path.join(root, "receipts") });
  const client = new Client({ name: "github-publication-client", version: "0.6.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const listed = await client.listTools();
    const names = listed.tools.map((item) => item.name).sort();
    assert.deepEqual(names, [
      "figure_library_apply_publication_pr",
      "figure_library_github_auth_instructions",
      "figure_library_github_auth_status",
      "figure_library_plan_publication_pr",
    ]);
    const instructions = await client.callTool({ name: "figure_library_github_auth_instructions", arguments: {} });
    const structured = instructions.structuredContent as Record<string, unknown>;
    const value = structured.instructions as Record<string, unknown>;
    assert.equal(value.launchedBySfl, false);
    assert.match(String(value.command), /^gh auth login/u);
    assert.equal(runner.calls.length, 0, "instructions must not invoke gh at all");
  } finally {
    await client.close();
    await server.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
