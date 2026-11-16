import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  OFFICIAL_OPEN_FIGURE_MANIFEST_URL,
  OFFICIAL_OPEN_FIGURE_ON_DEMAND_MANIFEST_URL,
  officialOpenFigurePaths,
} from "../src/open-figure-official-channel.ts";
import { OfficialOpenFigureSourceManager } from "../src/open-figure-official-source.ts";
import { SecureProviderSourceFetcher, type RawHttpsResponse } from "../src/provider-source-fetch.ts";
// @ts-expect-error -- scripts/*.mjs have no emitted declarations.
const personalModules = await import("../scripts/personal-modules-lib.mjs");
// @ts-expect-error -- scripts/*.mjs have no emitted declarations.
const publisher = await import("../scripts/publish-open-figure-feed.mjs");

const execFile = promisify(execFileCallback);
const MODULE_ID = "ggsankeyfier-layout-color-combo";
const PAYLOAD_COMMIT = "b".repeat(40);
const RAW = "https://raw.githubusercontent.com/jarxunlai/ScientificFigureLibrary-personal";
const PREVIEW_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
// A different image for the thumbnail, so the two archives differ in content and size.
const THUMBNAIL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const git = (cwd: string, ...args: string[]) => execFile("git", args, { cwd, windowsHide: true, encoding: "utf8" });

async function fixtureRepository(root: string) {
  const module = path.join(root, "modules", MODULE_ID);
  await fs.mkdir(path.join(module, "code"), { recursive: true });
  await fs.mkdir(path.join(module, "data"), { recursive: true });
  await fs.writeFile(path.join(module, "README.md"), "# Public module\n");
  await fs.writeFile(path.join(module, "description.md"), "A clean synthetic Sankey example.\n");
  await fs.writeFile(path.join(module, "code", "organized.R"), "plot(1:3)\n");
  await fs.writeFile(path.join(module, "data", "input.csv"), "x,y\n1,2\n");
  await fs.writeFile(path.join(module, "preview.png"), PREVIEW_PNG);
  await fs.writeFile(path.join(module, "thumbnail.png"), THUMBNAIL_PNG);
  const metadata = {
    schema: "figure-library.personal-module.v1",
    moduleId: MODULE_ID,
    title: "ggsankeyfier 桑基图",
    titleEn: "ggsankeyfier Sankey",
    description: "A clean synthetic Sankey example.",
    application: "Sankey plot layout and color.",
    dataProfile: "Synthetic CSV flow table.",
    plotFamily: "sankey",
    language: "R",
    tags: ["ggsankeyfier", "sankey"],
    packages: ["ggplot2", "ggsankeyfier"],
    codeFiles: ["code/organized.R"],
    inputFiles: ["data/input.csv"],
    canonicalCode: "code/organized.R",
    requiredFiles: ["README.md", "code/organized.R", "data/input.csv", "description.md", "module.yml", "preview.png"],
    files: ["README.md", "code/organized.R", "data/input.csv", "description.md", "module.yml", "preview.png", "thumbnail.png"],
    preview: { path: "preview.png", bytes: PREVIEW_PNG.byteLength, sha256: sha256(PREVIEW_PNG), mediaType: "image/png" },
    thumbnail: { path: "thumbnail.png", bytes: THUMBNAIL_PNG.byteLength, sha256: sha256(THUMBNAIL_PNG), mediaType: "image/png" },
    licenses: { code: "MIT", content: "CC BY 4.0", documentation: "CC BY 4.0" },
    publisher: { reviewStatus: "approved", executionStatus: "passed", executionScope: "synthetic_data" },
  };
  await fs.writeFile(path.join(module, "module.yml"), `${JSON.stringify(metadata, null, 2)}\n`);
  await git(root, "init", "-q");
  await git(root, "config", "user.email", "fixture@example.invalid");
  await git(root, "config", "user.name", "SFL fixture");
  await git(root, "add", "modules");
  await git(root, "commit", "-qm", "source module");
  const sourceCommit = (await git(root, "rev-parse", "HEAD")).stdout.trim();
  const archive = personalModules.archiveBytes(await personalModules.resolvedModule(module));
  await fs.mkdir(path.join(root, "archives"), { recursive: true });
  await fs.mkdir(path.join(root, "catalog"), { recursive: true });
  await fs.writeFile(path.join(root, "archives", `${MODULE_ID}.zip`), archive.bytes);
  await fs.writeFile(path.join(root, "catalog", "archive-manifest.json"), `${JSON.stringify({
    schema: "figure-library.personal-archive-manifest.v1",
    providerId: "io.github.jarxunlai.personal-figures",
    repository: "jarxunlai/ScientificFigureLibrary-personal",
    generatedAt: "2000-01-01T00:00:00.000Z",
    entries: [{
      moduleId: MODULE_ID,
      file: `archives/${MODULE_ID}.zip`,
      bytes: archive.bytes.byteLength,
      sha256: archive.sha256,
      files: archive.files,
      sourceCommit,
    }],
  }, null, 2)}\n`);
  await git(root, "add", "archives", "catalog");
  await git(root, "commit", "-qm", "archive");
}

/** The fields of publisher results these tests read. */
interface FeedPayload {
  unchanged: boolean;
  sequence: number;
  bundledFrozen?: boolean;
  bundled: { frozen: boolean; bytes: Uint8Array; reason: string };
  thumbnailsBytes: Uint8Array;
}

async function quietly<T>(run: () => Promise<T>) {
  const log = console.log;
  const warn = console.warn;
  console.log = () => {};
  console.warn = () => {};
  try {
    return await run();
  } finally {
    console.log = log;
    console.warn = warn;
  }
}

/** Serves a publisher output directory the way raw.githubusercontent.com serves the feed branch. */
function feedFetcher(feedRoot: string, hits: string[] = []) {
  const notFound: RawHttpsResponse = { statusCode: 404, headers: { "content-type": "text/plain", "content-length": "3" }, body: Buffer.from("404") };
  return new SecureProviderSourceFetcher({
    lookup: async () => [{ address: "1.1.1.1", family: 4 }],
    request: async (url) => {
      hits.push(url.href);
      const prefix = [`${RAW}/open-figure-feed/`, `${RAW}/${PAYLOAD_COMMIT}/`].find((value) => url.href.startsWith(value));
      if (!prefix) return notFound;
      try {
        const body = await fs.readFile(path.join(feedRoot, ...url.href.slice(prefix.length).split("/")));
        const type = url.pathname.endsWith(".json") ? "text/plain; charset=utf-8" : url.pathname.endsWith(".png") ? "image/png" : "application/octet-stream";
        return { statusCode: 200, headers: { "content-type": type, "content-length": String(body.byteLength) }, body };
      } catch {
        return notFound;
      }
    },
  });
}

async function publish(repository: string, output: string, seed: string, feedRoot?: string): Promise<FeedPayload> {
  const prepared = await quietly<FeedPayload>(() => publisher.main([
    "--mode", "publish-prepare",
    "--repository", repository,
    "--output", output,
    "--generated-at", "2026-11-16T00:00:00.000Z",
    ...(feedRoot ? ["--feed-root", feedRoot] : []),
  ]));
  if (prepared.unchanged) return prepared;
  process.env.SFL_OPEN_FIGURE_ED25519_PRIVATE_KEY_BASE64 = seed;
  try {
    await quietly(() => publisher.main(["--mode", "sign", "--output", output, "--payload-commit", PAYLOAD_COMMIT]));
  } finally {
    delete process.env.SFL_OPEN_FIGURE_ED25519_PRIVATE_KEY_BASE64;
  }
  return prepared;
}

test("publisher output for the on-demand channel is what the client verifies and downloads", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-on-demand-feed-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repository = path.join(root, "personal");
  await fs.mkdir(repository);
  await fixtureRepository(repository);
  const output = path.join(root, "feed");
  const seed = randomBytes(32).toString("base64");
  const key = publisher.keyFromPrivateSeedBase64(seed);

  const prepared = await publish(repository, output, seed);
  assert.equal(prepared.sequence, 1);
  assert.equal(prepared.bundledFrozen, false);
  const snapshot = path.join(output, "snapshots", "1");
  const entries = (await fs.readdir(snapshot, { recursive: true })).map((entry) => entry.split(path.sep).join("/")).sort();
  assert.deepEqual(entries, [
    "module-catalog.json",
    "module-previews.zip",
    "module-thumbnails.zip",
    "previews",
    `previews/${MODULE_ID}`,
    `previews/${MODULE_ID}/preview.png`,
    "thumbs",
    `thumbs/${MODULE_ID}.png`,
  ]);
  for (const channel of ["current", "current-on-demand"]) {
    const manifest = JSON.parse(await fs.readFile(path.join(output, channel, "source-manifest.json"), "utf8"));
    assert.equal(manifest.sequence, 1);
    assert.match(manifest.previews.url, channel === "current" ? /module-previews\.zip$/u : /module-thumbnails\.zip$/u);
  }

  const hits: string[] = [];
  const fetcher = feedFetcher(output, hits);
  const manager = new OfficialOpenFigureSourceManager({
    paths: officialOpenFigurePaths({ configFile: path.join(root, "client", "cfg.json"), dataRoot: path.join(root, "client", "data") }),
    bundledRoot: path.join(root, "no-bundled-snapshot"),
    fetcher,
    jitterRatio: 0,
    env: { NODE_TEST_CONTEXT: "1" },
    bootstrapPublicKeyBase64: key.publicKeyBase64,
    previewDownloads: { fetcher, cacheDirectory: path.join(root, "client", "preview-cache") },
  });
  await manager.load();
  await manager.refresh({ ignoreTtl: true });
  assert.equal(manager.statusDetails().lastError, null);
  assert.equal(manager.statusDetails().previewDelivery, "on-demand");
  assert.equal(hits.includes(OFFICIAL_OPEN_FIGURE_ON_DEMAND_MANIFEST_URL), true);
  assert.equal(hits.includes(OFFICIAL_OPEN_FIGURE_MANIFEST_URL), false);
  const index = manager.currentIndex();
  const module = index.catalog.modules[0]!;
  assert.equal(module.moduleId, MODULE_ID);
  hits.length = 0;
  assert.equal(sha256((await index.loadPreview(module, "thumbnail")).bytes), sha256(THUMBNAIL_PNG));
  assert.deepEqual(hits, []);
  assert.equal(sha256((await index.loadPreview(module, "primary")).bytes), sha256(PREVIEW_PNG));
  assert.deepEqual(hits, [`${RAW}/${PAYLOAD_COMMIT}/snapshots/1/previews/${MODULE_ID}/preview.png`]);
  manager.dispose();

  const again = await publish(repository, path.join(root, "feed-again"), seed, output);
  assert.equal(again.unchanged, true, "an identical Catalog does not bump the sequence");
});

test("the bundled channel freezes when its archive exceeds the client limits; the on-demand channel continues", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-on-demand-freeze-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fixtureRepository(root);
  const normal = await quietly<FeedPayload>(() => publisher.buildOpenFigureFeedPayload({ repositoryRoot: root }));
  assert.equal(normal.bundled.frozen, false);
  const bundledBytes = normal.bundled.bytes.byteLength;
  assert.ok(normal.thumbnailsBytes.byteLength < bundledBytes);
  const frozen = await quietly<FeedPayload>(() => publisher.buildOpenFigureFeedPayload({
    repositoryRoot: root,
    clientLimits: { ...publisher.CLIENT_PAYLOAD_LIMITS, previewArchiveBytes: bundledBytes - 1 },
  }));
  assert.equal(frozen.bundled.frozen, true);
  assert.match(frozen.bundled.reason, /module-previews\.zip is/u);
  assert.equal(sha256(frozen.thumbnailsBytes), sha256(normal.thumbnailsBytes));
  await assert.rejects(
    quietly(() => publisher.buildOpenFigureFeedPayload({
      repositoryRoot: root,
      clientLimits: { ...publisher.CLIENT_PAYLOAD_LIMITS, previewArchiveBytes: normal.thumbnailsBytes.byteLength - 1 },
    })),
    /module-thumbnails\.zip is/u,
  );
});
