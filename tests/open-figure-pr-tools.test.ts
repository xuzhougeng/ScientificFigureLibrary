import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { canonicalJson } from "../src/canonical-json.ts";
import { ensureLibraryRootMarker, resolveLibraryRuntimeSnapshot } from "../src/library-runtime.ts";
import type { CurrentLibraryContext } from "../src/library-binding-tools.ts";
import {
  OPEN_FIGURE_REPOSITORY,
  OpenFigurePublicationService,
  annotateSimilarMatchKind,
  registerOpenFigurePrTools,
  type SimilarSearchRequest,
  type SimilarSearchResult,
} from "../src/open-figure-pr-tools.ts";
import { FIGUREYA_PROVIDER_ID, LOCAL_LIBRARY_PROVIDER_ID, PERSONAL_MODULE_PROVIDER_ID, localPublishedExactSelector } from "../src/providers.ts";
import type { GhCommandResult, GhRunner } from "../src/github-publication-tools.ts";
import {
  VersionedTemplateLibrary,
  type VersionedTemplateCandidate,
} from "../src/versioned-library.ts";
import type { TemplateCandidate } from "../src/types.ts";

const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const BASE_COMMIT = "a".repeat(40);
const BASE_TREE = "b".repeat(40);
const SOURCE_TREE = "c".repeat(40);
const SOURCE_COMMIT = "d".repeat(40);
const ARCHIVE_TREE = "e".repeat(40);
const ARCHIVE_COMMIT = "f".repeat(40);

function sha256(value: Uint8Array | string) {
  return createHash("sha256").update(value).digest("hex");
}
function gitBlobSha(value: Uint8Array) {
  return createHash("sha1").update(`blob ${value.byteLength}\0`).update(value).digest("hex");
}

function candidate(): VersionedTemplateCandidate {
  return {
    title: "Clean room bars",
    description: "A portable bar example.",
    tags: ["bar"],
    visualProfile: "Compare synthetic groups.",
    dataProfile: "A synthetic group/value table.",
    packages: [],
    license: "MIT",
    assetKind: "plot_template",
    language: "R",
    plotFamily: "bar",
    codeStatus: "reviewed",
    executionStatus: "passed",
    validationState: {
      schema: "figure-library.validation-state.v1",
      plotExecution: { status: "passed", scope: "synthetic_data", evidenceAssetPaths: ["evidence/run.md"] },
      upstreamWorkflow: { status: "not_applicable" },
      scientificValidation: { status: "not_assessed" },
    },
    primaryPreview: "visuals/rendered/preview.png",
    canonicalImplementation: { assetPath: "code/render.R", selectedBy: "user" },
    runtime: {schema:"figure-library.runtime-closure.v1",entrypoint:"code/render.R",inputs:[{codePath:"data/data.csv",assetPath:"references/data.csv",required:true,role:"example_data"}],output:{previewPath:"visuals/rendered/preview.png",mediaType:"image/png"}},
    figureCodeLinks: [
      {
        visualAssetPath: "visuals/rendered/preview.png",
        codeAssetPaths: ["code/render.R"],
        relationship: "generated_output",
        confirmedBy: "user",
        evidence: "The user confirmed render.R generated this preview.",
      },
      {
        visualAssetPath: "visuals/source/private.png",
        codeAssetPaths: ["code/render.R"],
        relationship: "adapted_from_template",
        confirmedBy: "user",
        evidence: "The renderer is only generally inspired by the private source.",
      },
    ],
    assets: [
      {
        logicalPath: "code/render.R",
        role: "code",
        codeOrigin: "adapted",
        language: "R",
        mediaType: "text/x-r-source",
        rights: { license: "MIT", distribution: "public" },
        text: "dat <- read.csv('data/data.csv')\nplot(dat)\n",
      },
      {
        logicalPath: "references/data.csv",
        role: "reference",
        mediaType: "text/csv",
        rights: { license: "CC BY 4.0", distribution: "public" },
        text: "group,value\nA,1\nB,2\n",
      },
      {
        logicalPath: "evidence/run.md",
        role: "evidence",
        mediaType: "text/markdown",
        text: "Local-only execution note.\n",
      },
      {
        logicalPath: "visuals/rendered/preview.png",
        role: "visual",
        visualRole: "rendered_output",
        mediaType: "image/png",
        rights: { license: "CC BY 4.0", distribution: "public" },
        bytes: new Uint8Array(PNG_BYTES),
      },
      {
        logicalPath: "visuals/source/private.png",
        role: "visual",
        visualRole: "source_reference",
        mediaType: "image/png",
        bytes: new Uint8Array(PNG_BYTES),
      },
    ],
    primaryPreviewOverride: {
      confirmedBy: "user",
      reason: "Use the generated render as the public preview.",
    },
    visualGrouping: {
      visualAssetPaths: ["visuals/source/private.png", "visuals/rendered/preview.png"],
      confirmedBy: "user",
    },
  };
}

async function publishedContext() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-open-figure-pr-"));
  await ensureLibraryRootMarker(root);
  const snapshot = await resolveLibraryRuntimeSnapshot({ root });
  const versionedLibrary = new VersionedTemplateLibrary(snapshot);
  await versionedLibrary.applyCreateWorking(
    await versionedLibrary.planCreateWorking({
      templateId: "clean-room-bars",
      candidate: candidate(),
    }),
    "ofm-working",
  );
  await versionedLibrary.applyPublish(
    await versionedLibrary.planPublish({ templateId: "clean-room-bars" }),
    "ofm-publish",
  );
  const published = (await versionedLibrary.listPublishedCandidates())[0]!;
  const context: CurrentLibraryContext = { snapshot, versionedLibrary };
  const selector = localPublishedExactSelector({
    templateId: published.templateId,
    revisionId: published.revisionId,
    contentDigest: published.contentDigest,
    releaseId: published.releaseId,
  });
  return { root, context, selector };
}

class MockGhRunner implements GhRunner {
  login = "jarxunlai";
  calls: string[][] = [];
  writes: Array<{ endpoint: string; body: Record<string, unknown> }> = [];
  moduleExists = false;
  openPullFiles: string[] = [];
  blobs = new Map<string, Uint8Array>();
  createdPulls = 0;
  overrides = new Map<string, GhCommandResult>();

  #ok(value: unknown): GhCommandResult {
    return { exitCode: 0, stdout: typeof value === "string" ? value : JSON.stringify(value), stderr: "" };
  }
  #notFound(): GhCommandResult {
    return { exitCode: 1, stdout: "", stderr: "gh: HTTP 404: Not Found" };
  }

  async run(args: readonly string[], options: { stdin?: string } = {}): Promise<GhCommandResult> {
    this.calls.push([...args]);
    if (args[0] === "auth") {
      return this.#ok({ hosts: { "github.com": [{ state: "success", active: true, host: "github.com", login: this.login, tokenSource: "oauth_token" }] } });
    }
    const endpoint = String(args[1]);
    if (endpoint === "user") return this.#ok(`${this.login}\n`);
    const override = this.overrides.get(endpoint);
    if (override) return override;
    const method = args.includes("--method") ? args[args.indexOf("--method") + 1] : "GET";
    const body = options.stdin ? JSON.parse(options.stdin) as Record<string, unknown> : {};
    if (method === "POST") this.writes.push({ endpoint, body });

    if (endpoint === `repos/${OPEN_FIGURE_REPOSITORY}`) {
      return this.#ok({
        full_name: OPEN_FIGURE_REPOSITORY,
        default_branch: "main",
        archived: false,
        disabled: false,
        fork: false,
        permissions: { pull: true, push: true, admin: true },
      });
    }
    if (endpoint === `repos/${OPEN_FIGURE_REPOSITORY}/git/ref/heads/main`) return this.#ok({ object: { sha: BASE_COMMIT } });
    if (endpoint === `repos/${OPEN_FIGURE_REPOSITORY}/git/commits/${BASE_COMMIT}`) return this.#ok({ tree: { sha: BASE_TREE }, parents: [] });
    if (endpoint.startsWith(`repos/${OPEN_FIGURE_REPOSITORY}/contents/modules/clean-room-bars`)) {
      return this.moduleExists ? this.#ok({ type: "dir", sha: "1".repeat(40), size: 0 }) : this.#notFound();
    }
    if (endpoint.startsWith(`repos/${OPEN_FIGURE_REPOSITORY}/contents/catalog/archive-manifest.json`)) return this.#notFound();
    if (endpoint.startsWith(`repos/${OPEN_FIGURE_REPOSITORY}/pulls?state=open`)) {
      return this.#ok(this.openPullFiles.length ? [{ number: 9, html_url: `https://github.com/${OPEN_FIGURE_REPOSITORY}/pull/9` }] : []);
    }
    if (endpoint.startsWith(`repos/${OPEN_FIGURE_REPOSITORY}/pulls/9/files`)) {
      const page = Number(new URL("https://api.github.com/" + endpoint).searchParams.get("page") ?? "1");
      return this.#ok(this.openPullFiles.slice((page - 1) * 100, page * 100).map((filename) => ({ filename, status: "added" })));
    }
    if (endpoint.startsWith(`repos/${OPEN_FIGURE_REPOSITORY}/git/ref/heads/`)) return this.#notFound();
    if (endpoint.endsWith("/git/blobs") && method === "POST") {
      const bytes = new Uint8Array(Buffer.from(String(body.content), "base64"));
      const sha = gitBlobSha(bytes);
      this.blobs.set(sha, bytes);
      return this.#ok({ sha, encoding: "base64" });
    }
    if (endpoint.endsWith("/git/trees") && method === "POST") {
      return this.#ok({ sha: this.writes.filter((item) => item.endpoint.endsWith("/git/trees")).length === 1 ? SOURCE_TREE : ARCHIVE_TREE });
    }
    if (endpoint.endsWith("/git/commits") && method === "POST") {
      const parents = Array.isArray(body.parents) ? body.parents : [];
      return this.#ok({ sha: parents[0] === BASE_COMMIT ? SOURCE_COMMIT : ARCHIVE_COMMIT });
    }
    if (endpoint.endsWith("/git/refs") && method === "POST") return this.#ok({ ref: body.ref, object: { sha: ARCHIVE_COMMIT } });
    if (endpoint === `repos/${OPEN_FIGURE_REPOSITORY}/pulls` && method === "POST") {
      this.createdPulls += 1;
      return this.#ok({ number: 42, html_url: `https://github.com/${OPEN_FIGURE_REPOSITORY}/pull/42` });
    }
    if (endpoint.startsWith(`repos/${OPEN_FIGURE_REPOSITORY}/pulls?state=all`)) return this.#ok([]);
    return this.#notFound();
  }
}

function emptySearch(): SimilarSearchResult {
  return { candidates: [], queryDigest: sha256("empty"), resultSetId: "empty-result" };
}

function similarCandidate(): TemplateCandidate {
  return {
    templateId: "FigureYa1survivalCurve_update",
    providerId: FIGUREYA_PROVIDER_ID,
    exactSelector: {
      schema: "figure-library.provider-selector.v1",
      providerId: FIGUREYA_PROVIDER_ID,
      kind: "figureya-module.v1",
      identity: { moduleId: "FigureYa1survivalCurve_update", sourceCommit: "f".repeat(40), mode: "template" },
    },
    sourceLabel: "FigureYa",
    title: "survival curve",
    retrievalScore: 80,
    matchedTerms: ["bar"],
    reasons: ["catalog metadata match"],
    warnings: [],
    excerpt: "survival",
    description: "survival",
    application: "",
    dataProfile: "",
    inputFiles: [],
    codeFiles: [],
    packages: [],
    materializable: true,
    previewAvailable: false,
    assetKind: "plot_template",
    language: "R",
    plotFamily: "bar",
    reviewStatus: "not_reviewed",
    codeStatus: "provided",
    executionStatus: "not_run",
    license: "unknown",
    management: { templateId: "FigureYa1survivalCurve_update", canArchive: false, canUpdate: false },
  };
}

test("identity matchKind uses title and preview hash, not plotFamily alone", () => {
  const similar = annotateSimilarMatchKind({
    candidate: similarCandidate(),
    build: {
      moduleId: "clean-room-bars",
      title: "Clean room bars",
      titleEn: "Clean room bars",
      titleEnDerived: false,
      description: "",
      application: "",
      dataProfile: "",
      plotFamily: "bar",
      language: "R",
      tags: [],
      packages: [],
      canonicalCode: "code/organized.R",
      canonicalCodeSha256: "1".repeat(64),
      previewSha256: "2".repeat(64),
      files: [],
      excludedLogicalPaths: [],
      searchQuery: "Clean room bars",
    },
  });
  assert.equal(similar, "similar");
});

test("Open Figure PR Plan fails closed when the module path already exists", async () => {
  const published = await publishedContext();
  const runner = new MockGhRunner();
  runner.moduleExists = true;
  const service = new OpenFigurePublicationService({
    currentLibraries: async () => published.context,
    searchSimilar: async () => emptySearch(),
    lookupSearchSession: () => undefined,
    ghRunner: runner,
    receiptDirectory: path.join(published.root, "receipts"),
  });
  try {
    await assert.rejects(() => service.plan(published.selector), /already contains modules\/clean-room-bars/u);
    assert.equal(runner.createdPulls, 0);
  } finally {
    await fs.rm(published.root, { recursive: true, force: true });
  }
});

test("Open Figure PR Apply requires similar-review confirmation when hits exist", async () => {
  const published = await publishedContext();
  const runner = new MockGhRunner();
  const digest = sha256("similar-query");
  const service = new OpenFigurePublicationService({
    currentLibraries: async () => published.context,
    searchSimilar: async () => ({ candidates: [similarCandidate()], queryDigest: digest, resultSetId: "result-1" }),
    lookupSearchSession: (resultSetId) => resultSetId === "result-1"
      ? { presented: true, queryDigest: digest, providerIds: [FIGUREYA_PROVIDER_ID, PERSONAL_MODULE_PROVIDER_ID] }
      : undefined,
    ghRunner: runner,
    receiptDirectory: path.join(published.root, "receipts"),
  });
  try {
    const plan = await service.plan(published.selector);
    assert.equal(plan.similarReviewRequired, true);
    assert.equal(plan.similarCandidates[0]?.matchKind, "similar");
    await assert.rejects(
      () => service.apply({ planDigest: plan.planDigest, operationId: "op-1" }),
      /reviewed in the SFL window/u,
    );
    assert.equal(runner.createdPulls, 0);
    const applied = await service.apply({
      planDigest: plan.planDigest,
      operationId: "op-1",
      similarReviewConfirmed: true,
      expectedResultSetId: "result-1",
    });
    assert.equal(applied.outcome, "applied");
    assert.equal(applied.receipt.pullRequestUrl, `https://github.com/${OPEN_FIGURE_REPOSITORY}/pull/42`);
    assert.equal(runner.createdPulls, 1);
    assert.ok(runner.writes.every((item) => !item.endpoint.includes("/merge")));
    assert.ok(!plan.excludedLogicalPaths.includes("code/render.R"));
    assert.ok(plan.excludedLogicalPaths.includes("visuals/source/private.png"));
  } finally {
    await fs.rm(published.root, { recursive: true, force: true });
  }
});

test("Open Figure PR Apply can proceed without similar review when search is empty", async () => {
  const published = await publishedContext();
  const runner = new MockGhRunner();
  const service = new OpenFigurePublicationService({
    currentLibraries: async () => published.context,
    searchSimilar: async (request: SimilarSearchRequest) => {
      assert.ok(!request.providerIds.includes(LOCAL_LIBRARY_PROVIDER_ID));
      return emptySearch();
    },
    lookupSearchSession: () => undefined,
    ghRunner: runner,
    receiptDirectory: path.join(published.root, "receipts"),
  });
  try {
    const plan = await service.plan(published.selector);
    assert.equal(plan.similarReviewRequired, false);
    const applied = await service.apply({ planDigest: plan.planDigest, operationId: "op-empty" });
    assert.equal(applied.receipt.sourceCommit, SOURCE_COMMIT);
    assert.equal(applied.receipt.archiveCommit, ARCHIVE_COMMIT);
    assert.equal(runner.createdPulls, 1);
  } finally {
    await fs.rm(published.root, { recursive: true, force: true });
  }
});

test("Open Figure PR tools register on an MCP server", async () => {
  const published = await publishedContext();
  const runner = new MockGhRunner();
  const server = new McpServer({ name: "open-figure-test", version: "0.6.2" });
  registerOpenFigurePrTools({
    server,
    currentLibraries: async () => published.context,
    searchSimilar: async () => emptySearch(),
    lookupSearchSession: () => undefined,
    ghRunner: runner,
    receiptDirectory: path.join(published.root, "receipts"),
  });
  const client = new Client({ name: "open-figure-test", version: "0.6.2" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, [
      "figure_library_apply_open_figure_module_pr",
      "figure_library_plan_open_figure_module_pr",
    ]);
  } finally {
    await client.close();
    await fs.rm(published.root, { recursive: true, force: true });
  }
});

test("Open Figure Apply rejects unpresented, mismatched, stale and wrong-provider result sets without writes", async () => {
  const published = await publishedContext();
  const runner = new MockGhRunner();
  const digest = sha256("gated-search");
  let session: { presented: boolean; queryDigest: string; providerIds: string[] } | undefined;
  let invocation = 0;
  const service = new OpenFigurePublicationService({
    currentLibraries: async () => published.context,
    searchSimilar: async () => ({ candidates: [similarCandidate()], queryDigest: digest, resultSetId: ++invocation === 1 ? "planned-results" : "revalidation-results" }),
    lookupSearchSession: () => session,
    ghRunner: runner, receiptDirectory: path.join(published.root, "receipts"),
  });
  try {
    const plan = await service.plan(published.selector);
    assert.equal(plan.similarSearch.resultSetId, "planned-results");
    const apply = (expectedResultSetId = "planned-results") => service.apply({ planDigest: plan.planDigest, operationId: "gated-operation", similarReviewConfirmed: true, expectedResultSetId });
    await assert.rejects(apply("another-result"), /does not match/u);
    await assert.rejects(apply(), /not a current/u);
    session = { presented: false, queryDigest: digest, providerIds: [FIGUREYA_PROVIDER_ID, PERSONAL_MODULE_PROVIDER_ID] };
    await assert.rejects(apply(), /have not been returned/u);
    session = { ...session, presented: true, queryDigest: "f".repeat(64) };
    await assert.rejects(apply(), /does not match/u);
    session = { ...session, queryDigest: digest, providerIds: [LOCAL_LIBRARY_PROVIDER_ID] };
    await assert.rejects(apply(), /providers do not match/u);
    assert.equal(runner.writes.length, 0);
    session.providerIds = [FIGUREYA_PROVIDER_ID, PERSONAL_MODULE_PROVIDER_ID];
    const result = await apply();
    assert.equal(result.outcome, "applied");
    assert.equal(runner.writes.filter((w) => w.endpoint.endsWith("/git/commits")).length, 2);
    assert.ok(runner.writes.filter((w) => w.endpoint.endsWith("/git/commits")).every((w) => String(w.body.message).includes(plan.planDigest)));
    assert.equal(runner.writes.some((w) => w.endpoint.includes("/merge")), false);
  } finally { await fs.rm(published.root, { recursive: true, force: true }); }
});

test("Open Figure path conflicts on later PR file pages fail before any mutation", async () => {
  const published = await publishedContext();
  const runner = new MockGhRunner();
  runner.openPullFiles = [...Array.from({ length: 100 }, (_, i) => "docs/file-" + i + ".md"), "modules/clean-room-bars/module.yml"];
  const service = new OpenFigurePublicationService({ currentLibraries: async () => published.context, searchSimilar: async () => emptySearch(), lookupSearchSession: () => undefined, ghRunner: runner, receiptDirectory: path.join(published.root, "receipts") });
  try {
    await assert.rejects(service.plan(published.selector), /open Open Figure Modules PR already contains/u);
    assert.ok(runner.calls.some((call) => call[1]?.endsWith("files?per_page=100&page=2")));
    assert.equal(runner.writes.length, 0);
  } finally { await fs.rm(published.root, { recursive: true, force: true }); }
});

test("unreadable or malformed existing archive manifests cannot erase inventory", async () => {
  const published = await publishedContext();
  const endpoint = "repos/" + OPEN_FIGURE_REPOSITORY + "/contents/catalog/archive-manifest.json?ref=" + BASE_COMMIT;
  try {
    for (const failure of ["network", "json", "schema", "blob-missing"]) {
      const runner = new MockGhRunner();
      if (failure === "network") runner.overrides.set(endpoint, { exitCode: 1, stdout: "", stderr: "gh: HTTP 503 Service Unavailable" });
      else {
        const bytes = Buffer.from(failure === "json" ? "{broken json" : "{}");
        const blob = gitBlobSha(bytes);
        runner.overrides.set(endpoint, { exitCode: 0, stdout: JSON.stringify({ type: "file", sha: blob }), stderr: "" });
        if (failure !== "blob-missing") runner.overrides.set("repos/" + OPEN_FIGURE_REPOSITORY + "/git/blobs/" + blob, { exitCode: 0, stdout: JSON.stringify({ encoding: "base64", content: bytes.toString("base64") }), stderr: "" });
      }
      const service = new OpenFigurePublicationService({ currentLibraries: async () => published.context, searchSimilar: async () => emptySearch(), lookupSearchSession: () => undefined, ghRunner: runner, receiptDirectory: path.join(published.root, failure) });
      await assert.rejects(service.plan(published.selector), /github_unreachable|invalid JSON|identity is invalid|not_found/u);
      assert.equal(runner.writes.length, 0);
    }
  } finally { await fs.rm(published.root, { recursive: true, force: true }); }
});

test("a valid base archive manifest is preserved and the new entry points to Commit A", async () => {
  const published = await publishedContext();
  const runner = new MockGhRunner();
  const old = { moduleId: "existing-module", file: "archives/existing-module.zip", bytes: 100, sha256: "1".repeat(64), files: ["module.yml"], sourceCommit: "2".repeat(40) };
  const bytes = Buffer.from(JSON.stringify({ schema: "figure-library.personal-archive-manifest.v1", providerId: PERSONAL_MODULE_PROVIDER_ID, repository: OPEN_FIGURE_REPOSITORY, generatedAt: "2000-01-01T00:00:00.000Z", entries: [old] }));
  const blob = gitBlobSha(bytes);
  runner.overrides.set("repos/" + OPEN_FIGURE_REPOSITORY + "/contents/catalog/archive-manifest.json?ref=" + BASE_COMMIT, { exitCode: 0, stdout: JSON.stringify({ type: "file", sha: blob }), stderr: "" });
  runner.overrides.set("repos/" + OPEN_FIGURE_REPOSITORY + "/git/blobs/" + blob, { exitCode: 0, stdout: JSON.stringify({ encoding: "base64", content: bytes.toString("base64") }), stderr: "" });
  const service = new OpenFigurePublicationService({ currentLibraries: async () => published.context, searchSimilar: async () => emptySearch(), lookupSearchSession: () => undefined, ghRunner: runner, receiptDirectory: path.join(published.root, "receipts") });
  try {
    const plan = await service.plan(published.selector);
    await service.apply({ planDigest: plan.planDigest, operationId: "preserve" });
    const manifestBytes = [...runner.blobs.values()].find((value) => Buffer.from(value).toString("utf8").includes('"schema": "figure-library.personal-archive-manifest.v1"'))!;
    assert.ok(manifestBytes);
    const manifest = JSON.parse(Buffer.from(manifestBytes).toString("utf8"));
    assert.deepEqual(manifest.entries.find((entry: { moduleId: string }) => entry.moduleId === old.moduleId), old);
    assert.equal(manifest.entries.find((entry: { moduleId: string }) => entry.moduleId === "clean-room-bars").sourceCommit, SOURCE_COMMIT);
  } finally { await fs.rm(published.root, { recursive: true, force: true }); }
});

test("identity requires exact normalized title or preview/code identity, never substring or cross-provider ID", async () => {
  const published = await publishedContext();
  try {
    const { buildOpenFigureModule } = await import("../src/open-figure-module.ts");
    const { ModuleCatalogIndex } = await import("../src/module-catalog.ts");
    const id = published.selector.identity;
    const content = await published.context.versionedLibrary.getContent(id.templateId, id.revisionId, id.contentDigest);
    const build = await buildOpenFigureModule({ library: published.context.versionedLibrary, content: content! });
    const similar = similarCandidate();
    assert.equal(annotateSimilarMatchKind({ candidate: { ...similar, title: "  CLEAN   ROOM bars " }, build }), "identity");
    assert.equal(annotateSimilarMatchKind({ candidate: { ...similar, title: "Clean room bars with error bars" }, build }), "similar");
    assert.equal(annotateSimilarMatchKind({ candidate: { ...similar, templateId: build.moduleId }, build }), "similar");
    assert.equal(annotateSimilarMatchKind({ candidate: { ...similar, previewSha256: build.previewSha256 }, build }), "identity");
    const openFigure = await ModuleCatalogIndex.load(path.resolve(import.meta.dirname, "../assets/personal-modules"));
    const module = openFigure.catalog.modules[0]!;
    const personal = { ...similar, providerId: PERSONAL_MODULE_PROVIDER_ID, templateId: module.moduleId, title: "unrelated fixture title", previewSha256: undefined };
    const code = module.files.find((f) => f.path === module.canonicalCode)!;
    assert.equal(annotateSimilarMatchKind({ candidate: personal, build: { ...build, canonicalCodeSha256: code.sha256 }, openFigure }), "identity");
    assert.equal(annotateSimilarMatchKind({ candidate: personal, build: { ...build, previewSha256: module.preview.sha256 }, openFigure }), "identity");
  } finally { await fs.rm(published.root, { recursive: true, force: true }); }
});

test("real MCP Plan -> exact cached search -> confirmed Apply binds the same six-candidate set", async () => {
  const published = await publishedContext();
  const runner = new MockGhRunner();
  const prior = process.env.FIGURE_LIBRARY_DIR;
  process.env.FIGURE_LIBRARY_DIR = published.root;
  const { createServer } = await import("../src/server.ts");
  const server = await createServer({ openFigurePr: { ghRunner: runner, receiptDirectory: path.join(published.root, "receipts") } });
  const client = new Client({ name: "ofm-review-integration", version: "0.6.3" });
  const [transport, serverTransport] = InMemoryTransport.createLinkedPair();
  const structured = (value: unknown) => (value as { structuredContent: Record<string, any> }).structuredContent;
  try {
    await server.connect(serverTransport); await client.connect(transport);
    const planned = structured(await client.callTool({ name: "figure_library_plan_open_figure_module_pr", arguments: { providerId: LOCAL_LIBRARY_PROVIDER_ID, exactSelector: published.selector } }));
    const plan = planned.plan;
    assert.ok(plan, JSON.stringify(planned));
    assert.equal(plan.similarReviewRequired, true);
    assert.equal(plan.similarSearch.limit, 6);
    assert.deepEqual(plan.similarSearch.providerIds, [FIGUREYA_PROVIDER_ID, PERSONAL_MODULE_PROVIDER_ID]);
    assert.ok(plan.similarCandidates.length <= 6);
    const apply = () => client.callTool({ name: "figure_library_apply_open_figure_module_pr", arguments: { planDigest: plan.planDigest, operationId: "mcp-reviewed", similarReviewConfirmed: true, expectedResultSetId: plan.similarSearch.resultSetId } });
    const before = structured(await apply());
    assert.notEqual(before.envelope.outcome, "applied");
    assert.equal(runner.writes.length, 0);
    const { queryDigest: _digest, ...searchArgs } = plan.similarSearch;
    const search = structured(await client.callTool({ name: "figure_library_search", arguments: searchArgs }));
    assert.equal(search.resultSetId, plan.similarSearch.resultSetId);
    assert.deepEqual(search.candidates.map((c: TemplateCandidate) => c.exactSelector), plan.similarCandidates.map((c: TemplateCandidate) => c.exactSelector));
    assert.deepEqual(search.candidates.map((c: TemplateCandidate) => c.matchKind), plan.similarCandidates.map((c: TemplateCandidate) => c.matchKind));
    assert.ok(search.candidates.every((c: TemplateCandidate) => c.providerId !== LOCAL_LIBRARY_PROVIDER_ID));
    const applied = structured(await apply());
    assert.equal(applied.envelope.outcome, "applied", JSON.stringify(applied));
    assert.equal(runner.createdPulls, 1);
    assert.equal(runner.writes.filter((w) => w.endpoint.endsWith("/git/commits")).length, 2);
    assert.equal(runner.writes.some((w) => w.endpoint.includes("/merge")), false);
  } finally {
    await client.close(); await server.close();
    if (prior === undefined) delete process.env.FIGURE_LIBRARY_DIR; else process.env.FIGURE_LIBRARY_DIR = prior;
    await fs.rm(published.root, { recursive: true, force: true });
  }
});
