import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { zipSync } from "fflate";
import { PNG } from "pngjs";
import { OFFICIAL_OPEN_FIGURE_MANIFEST_URL } from "../src/open-figure-official-channel.ts";
import { fetchVerifiedOfficialOpenFigureSnapshot, type VerifiedOfficialOpenFigureSnapshot } from "../src/open-figure-feed.ts";
import { LEGACY_PREVIEW_MAX_EDGE } from "../src/preview-reduction.ts";
import {
  MAX_PREVIEW_ARCHIVE_BYTES,
  SecureProviderSourceFetcher,
  ed25519PublicKeyIdentity,
  type RawHttpsResponse,
} from "../src/provider-source-fetch.ts";
import { decodeRaster } from "../src/transport-image.ts";
// Production maintainer scripts are intentionally plain JavaScript modules.
// @ts-expect-error -- scripts/*.mjs have no emitted declarations.
const personalModules = await import("../scripts/personal-modules-lib.mjs");
// @ts-expect-error -- scripts/*.mjs have no emitted declarations.
const publisher = await import("../scripts/publish-open-figure-feed.mjs");
const { archivePersonalModules, resolveGitCommit, stableJson } = personalModules;
const { FEED_PAYLOAD_LIMITS, assertFeedPayloadLimits, buildOpenFigureFeedPayload, buildSourceManifest, main, signManifest } = publisher;

const execFile = promisify(execFileCallback);
const MODULE_ID = "fixture-large-preview";
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function git(cwd: string, args: string[]) {
  await execFile("git", args, { cwd, windowsHide: true });
}

/** A figure-like image: flat regions with fine per-pixel detail, larger than the legacy preview limit. */
function largePreview(width = 2400, height = 1600) {
  const image = new PNG({ width, height });
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const shade = ((x * 31 + y * 17) % 29) - 14;
      const color = x < width / 2 ? [228 + shade, 26, 28] : [55, 126, 184 + shade];
      image.data.set([...color, 255], (y * width + x) * 4);
    }
  }
  return PNG.sync.write(image);
}

function smallThumbnail() {
  const image = new PNG({ width: 48, height: 32 });
  for (let index = 0; index < image.data.length; index += 4) image.data.set([40, 90, 160, 255], index);
  return PNG.sync.write(image);
}

/** A content repository with one validated, archived module whose preview is 2400×1600. */
async function fixtureRepository() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-feed-publish-"));
  const module = path.join(root, "modules", MODULE_ID);
  await fs.mkdir(path.join(module, "code"), { recursive: true });
  await fs.mkdir(path.join(module, "data"), { recursive: true });
  const preview = largePreview();
  const thumbnail = smallThumbnail();
  await fs.writeFile(path.join(module, "README.md"), "# Public module\n");
  await fs.writeFile(path.join(module, "description.md"), "A synthetic two-colour figure.\n");
  await fs.writeFile(path.join(module, "code", "organized.R"), "plot(1:3)\n");
  await fs.writeFile(path.join(module, "data", "input.csv"), "x,y\n1,2\n");
  await fs.writeFile(path.join(module, "preview.png"), preview);
  await fs.writeFile(path.join(module, "thumbnail.png"), thumbnail);
  const manifest = {
    schema: "figure-library.personal-module.v1",
    moduleId: MODULE_ID,
    title: "大尺寸预览图夹具",
    titleEn: "Large preview fixture",
    description: "A synthetic two-colour figure.",
    application: "Exercises the reduced preview of the legacy feed.",
    dataProfile: "Synthetic CSV.",
    plotFamily: "bar",
    language: "R",
    tags: ["fixture"],
    packages: ["ggplot2"],
    codeFiles: ["code/organized.R"],
    inputFiles: ["data/input.csv"],
    canonicalCode: "code/organized.R",
    requiredFiles: ["README.md", "code/organized.R", "data/input.csv", "description.md", "module.yml", "preview.png"],
    files: ["README.md", "code/organized.R", "data/input.csv", "description.md", "module.yml", "preview.png", "thumbnail.png"],
    preview: { path: "preview.png", bytes: preview.byteLength, sha256: sha256(preview), mediaType: "image/png" },
    thumbnail: { path: "thumbnail.png", bytes: thumbnail.byteLength, sha256: sha256(thumbnail), mediaType: "image/png" },
    licenses: { code: "MIT", content: "CC BY 4.0", documentation: "CC BY 4.0" },
    publisher: { reviewStatus: "approved", executionStatus: "passed", executionScope: "synthetic_data" },
  };
  await fs.writeFile(path.join(module, "module.yml"), `${JSON.stringify(manifest, null, 2)}\n`);
  await git(root, ["init", "-q"]);
  await git(root, ["config", "user.email", "fixture@example.invalid"]);
  await git(root, ["config", "user.name", "SFL fixture"]);
  await git(root, ["add", "modules"]);
  await git(root, ["commit", "-qm", "source module"]);
  const sourceCommit = await resolveGitCommit(root);
  await archivePersonalModules({ repositoryRoot: root, sourceCommit, write: true });
  await git(root, ["add", "archives", "catalog/archive-manifest.json"]);
  await git(root, ["commit", "-qm", "archive module"]);
  return { root, preview, thumbnail };
}

function response(body: Uint8Array, contentType: string): RawHttpsResponse {
  return { statusCode: 200, headers: { "content-type": contentType, "content-length": String(body.byteLength) }, body };
}

const GENERATED_AT = "2026-11-12T00:00:00.000Z";
const fixture = await fixtureRepository();
test.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
const payload = await buildOpenFigureFeedPayload({ repositoryRoot: fixture.root, generatedAt: GENERATED_AT });

test("the legacy feed lists a reduced JPEG preview while the archive keeps the original", () => {
  const [module] = payload.catalog.modules;
  assert.equal(payload.catalog.modules.length, 1);
  assert.equal(module.preview.path, `previews/${MODULE_ID}/preview.jpg`);
  assert.equal(module.preview.mediaType, "image/jpeg");
  assert.ok(module.preview.bytes < fixture.preview.byteLength, `${module.preview.bytes} < ${fixture.preview.byteLength}`);
  // Everything that identifies the downloadable module is untouched.
  assert.deepEqual(
    module.files.find((file: { path: string }) => file.path === "preview.png"),
    { path: "preview.png", bytes: fixture.preview.byteLength, sha256: sha256(fixture.preview) },
  );
  assert.deepEqual(module.thumbnail, {
    path: `thumbs/${MODULE_ID}.png`,
    bytes: fixture.thumbnail.byteLength,
    sha256: sha256(fixture.thumbnail),
    mediaType: "image/png",
  });
  assert.equal(payload.sequence, 1);
  assert.equal(payload.size.previewFiles, 2);
  assert.equal(payload.size.previewsBytes, payload.previewsBytes.byteLength);
  assert.equal(payload.size.previewsLimitBytes, MAX_PREVIEW_ARCHIVE_BYTES);
});

test("building the feed twice yields identical catalog and ZIP bytes, so an unchanged repository keeps its sequence", async () => {
  const again = await buildOpenFigureFeedPayload({ repositoryRoot: fixture.root, generatedAt: GENERATED_AT });
  assert.equal(again.catalogSha256, payload.catalogSha256);
  assert.equal(again.previewsSha256, payload.previewsSha256);
  const republished = await buildOpenFigureFeedPayload({
    repositoryRoot: fixture.root,
    generatedAt: GENERATED_AT,
    previousCatalog: payload.catalog,
    previousCatalogBytes: payload.catalogBytes,
    previousZipBytes: payload.previewsBytes,
    previousTombstones: [],
    previousSequence: 5,
  });
  assert.equal(republished.unchanged, true);
  assert.equal(republished.sequence, 5);
});

test("a released client accepts the signed reduced feed end to end", async () => {
  const seed = randomBytes(32).toString("base64");
  const payloadCommit = "b".repeat(40);
  const manifest = buildSourceManifest({
    sequence: payload.sequence,
    generatedAt: GENERATED_AT,
    catalogBytes: payload.catalogBytes,
    previewsBytes: payload.previewsBytes,
    payloadCommit,
    tombstones: payload.diff.tombstones,
  });
  const manifestBytes = Buffer.from(stableJson(manifest), "utf8");
  const signed = signManifest(manifestBytes, seed);
  const routes = new Map<string, RawHttpsResponse>([
    [OFFICIAL_OPEN_FIGURE_MANIFEST_URL, response(manifestBytes, "text/plain")],
    [OFFICIAL_OPEN_FIGURE_MANIFEST_URL.replace(/source-manifest\.json$/u, "source-manifest.sig.json"), response(signed.sidecarBytes, "text/plain")],
    [manifest.catalog.url, response(payload.catalogBytes, "text/plain")],
    [manifest.previews.url, response(payload.previewsBytes, "application/octet-stream")],
  ]);
  const fetcher = new SecureProviderSourceFetcher({
    lookup: async () => [{ address: "1.1.1.1", family: 4 }],
    request: async (url) => {
      const found = routes.get(url.href);
      if (!found) throw new Error(`missing fixture route: ${url.href}`);
      return found;
    },
  });
  const snapshot = (await fetchVerifiedOfficialOpenFigureSnapshot({
    fetcher,
    manifestUrl: OFFICIAL_OPEN_FIGURE_MANIFEST_URL,
    trustedKeys: [ed25519PublicKeyIdentity(signed.publicKeyBase64)],
  })) as VerifiedOfficialOpenFigureSnapshot;
  assert.equal(snapshot.manifest.sequence, 1);
  assert.equal(snapshot.catalog.modules[0]!.preview.mediaType, "image/jpeg");
  const preview = snapshot.previewFiles.find((file) => file.path === `previews/${MODULE_ID}/preview.jpg`)!;
  const raster = decodeRaster(preview.data, "image/jpeg");
  assert.equal(Math.max(raster.width, raster.height), LEGACY_PREVIEW_MAX_EDGE);
  assert.deepEqual([raster.width, raster.height], [1200, 800]);
  assert.ok(snapshot.snapshotFiles.has(`previews/${MODULE_ID}/preview.jpg`));
  assert.ok(snapshot.snapshotFiles.has(`thumbs/${MODULE_ID}.png`));
});

test("a payload over any client limit is refused before anything can be signed", async () => {
  const catalogBytes = Buffer.from("{}");
  const zip = (files: Record<string, Uint8Array>) => new Uint8Array(zipSync(files, { level: 0 }));
  const small = zip({ "previews/a/preview.png": new Uint8Array(2048), "thumbs/a.png": new Uint8Array(1024) });
  assert.deepEqual(assertFeedPayloadLimits({ catalogBytes, previewsBytes: small }), {
    catalogBytes: 2,
    previewsBytes: small.byteLength,
    previewsLimitBytes: MAX_PREVIEW_ARCHIVE_BYTES,
    previewFiles: 2,
    previewExpandedBytes: 3072,
  });
  const limits = (override: Record<string, number>) => ({ ...FEED_PAYLOAD_LIMITS, ...override });
  assert.throws(() => assertFeedPayloadLimits({ catalogBytes, previewsBytes: small }, limits({ previewArchiveBytes: 1000 })), /preview ZIP is .* over the .* client limit.*Nothing was signed/u);
  assert.throws(() => assertFeedPayloadLimits({ catalogBytes, previewsBytes: small }, limits({ previewExpandedBytes: 3000 })), /expands to/u);
  assert.throws(() => assertFeedPayloadLimits({ catalogBytes, previewsBytes: small }, limits({ previewFiles: 1 })), /has 2 files/u);
  assert.throws(() => assertFeedPayloadLimits({ catalogBytes, previewsBytes: small }, limits({ previewFileBytes: 2000 })), /a preview file is/u);
  assert.throws(() => assertFeedPayloadLimits({ catalogBytes, previewsBytes: small }, limits({ catalogBytes: 1 })), /catalog is/u);
  // The default limits are the ones released clients enforce.
  assert.equal(FEED_PAYLOAD_LIMITS.previewArchiveBytes, 64 * 1024 * 1024);
  await assert.rejects(
    buildOpenFigureFeedPayload({ repositoryRoot: fixture.root, generatedAt: GENERATED_AT, limits: limits({ previewArchiveBytes: 1024 }) }),
    /exceeds what released clients accept/u,
  );
});

test("sign mode re-checks the exact bytes on disk and writes no manifest for an oversized ZIP", async (t) => {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-feed-sign-"));
  t.after(() => fs.rm(output, { recursive: true, force: true }));
  const snapshot = path.join(output, "snapshots", "7");
  await fs.mkdir(snapshot, { recursive: true });
  await fs.writeFile(path.join(snapshot, "module-catalog.json"), "{}");
  // One stored (uncompressed) entry just over the 64 MiB archive limit.
  await fs.writeFile(
    path.join(snapshot, "module-previews.zip"),
    zipSync({ "previews/a/preview.png": new Uint8Array(MAX_PREVIEW_ARCHIVE_BYTES + 1024) }, { level: 0 }),
  );
  await fs.writeFile(path.join(output, "payload.json"), JSON.stringify({ sequence: 7, generatedAt: GENERATED_AT, tombstones: [], authorizedNextKeys: [] }));
  const previous = process.env.SFL_OPEN_FIGURE_ED25519_PRIVATE_KEY_BASE64;
  process.env.SFL_OPEN_FIGURE_ED25519_PRIVATE_KEY_BASE64 = randomBytes(32).toString("base64");
  t.after(() => {
    if (previous === undefined) delete process.env.SFL_OPEN_FIGURE_ED25519_PRIVATE_KEY_BASE64;
    else process.env.SFL_OPEN_FIGURE_ED25519_PRIVATE_KEY_BASE64 = previous;
  });
  await assert.rejects(
    main(["--mode", "sign", "--output", output, "--payload-commit", "c".repeat(40)]),
    /preview ZIP is .* over the 64\.00 MiB client limit/u,
  );
  await assert.rejects(fs.stat(path.join(output, "current", "source-manifest.json")), { code: "ENOENT" });
});
