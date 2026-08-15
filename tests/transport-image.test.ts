import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PNG } from "pngjs";
import { inspectImageHeader } from "../src/image-validation.ts";
import {
  ENCODER_POLICY_VERSION,
  budgetBucket,
  estimateDataUrlLength,
  prepareTransportImage,
  searchPerImageBudget,
  singlePreviewBudget,
} from "../src/transport-image.ts";

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

function patternedPng(width: number, height: number, alpha = false) {
  const png = new PNG({ width, height, colorType: alpha ? 6 : 2 });
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (png.width * y + x) << 2;
      png.data[index] = x % 256;
      png.data[index + 1] = y % 256;
      png.data[index + 2] = (x * 13 + y * 7) % 256;
      png.data[index + 3] = alpha && x < 8 ? 80 : 255;
    }
  }
  return new Uint8Array(PNG.sync.write(png));
}

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

test("budget helpers keep search smaller than exact preview", () => {
  assert.equal(budgetBucket(200_000), 196_608);
  assert.ok(searchPerImageBudget(12) <= 256 * 1024);
  assert.ok(searchPerImageBudget(1) <= 256 * 1024);
  assert.ok(singlePreviewBudget() > 847_000);
  assert.equal(ENCODER_POLICY_VERSION, "transport-image-v1");
});

test("inspectImageHeader reads PNG dimensions without treating a huge header as safe to decode", () => {
  const header = inspectImageHeader(ONE_PIXEL_PNG);
  assert.deepEqual(header, {
    mimeType: "image/png",
    width: 1,
    height: 1,
    pixelsSafe: true,
  });
  const bomb = Buffer.from(ONE_PIXEL_PNG);
  bomb.writeUInt32BE(80_000, 16);
  bomb.writeUInt32BE(80_000, 20);
  const unsafe = inspectImageHeader(bomb);
  assert.equal(unsafe?.width, 80_000);
  assert.equal(unsafe?.height, 80_000);
  assert.equal(unsafe?.pixelsSafe, false);
});

test("small PNG and WebP pass through without recoding", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-transport-pass-"));
  try {
    const png = await prepareTransportImage({
      sourceBytes: ONE_PIXEL_PNG,
      sourceMime: "image/png",
      sourceSha256: sha256(ONE_PIXEL_PNG),
      purpose: "SearchCard",
      maxDataUrlBytes: 256 * 1024,
      libraryRoot: root,
    });
    assert.equal(png.ok, true);
    if (!png.ok) return;
    assert.equal(png.passthrough, true);
    assert.equal(png.transportMime, "image/png");
    assert.equal(png.transportSha256, sha256(ONE_PIXEL_PNG));

    const webp = await fs.readFile(
      path.resolve(import.meta.dirname, "..", "assets", "thumbs", "FigureYa59volcanoV2.webp"),
    );
    const webpResult = await prepareTransportImage({
      sourceBytes: webp,
      sourceMime: "image/webp",
      sourceSha256: sha256(webp),
      purpose: "SearchCard",
      maxDataUrlBytes: 256 * 1024,
      libraryRoot: root,
    });
    assert.equal(webpResult.ok, true);
    if (!webpResult.ok) return;
    assert.equal(webpResult.passthrough, true);
    assert.equal(webpResult.transportMime, "image/webp");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("oversized opaque PNG is adapted under the search budget and cached deterministically", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-transport-adapt-"));
  try {
    const source = patternedPng(1400, 1100);
    assert.ok(estimateDataUrlLength(source.byteLength, "image/png") > 256 * 1024);
    const first = await prepareTransportImage({
      sourceBytes: source,
      sourceMime: "image/png",
      sourceSha256: sha256(source),
      purpose: "SearchCard",
      maxDataUrlBytes: 256 * 1024,
      libraryRoot: root,
    });
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.equal(first.passthrough, false);
    assert.ok(first.inlineBytes <= 256 * 1024);
    assert.ok(first.width <= 720);
    assert.ok(["image/png", "image/jpeg"].includes(first.transportMime));

    const second = await prepareTransportImage({
      sourceBytes: source,
      sourceMime: "image/png",
      sourceSha256: sha256(source),
      purpose: "SearchCard",
      maxDataUrlBytes: 256 * 1024,
      libraryRoot: root,
    });
    assert.equal(second.ok, true);
    if (!second.ok) return;
    assert.equal(second.cacheHit, true);
    assert.equal(second.transportSha256, first.transportSha256);

    const [left, right] = await Promise.all([
      prepareTransportImage({
        sourceBytes: source,
        sourceMime: "image/png",
        sourceSha256: sha256(source),
        purpose: "SearchCard",
        maxDataUrlBytes: 256 * 1024,
        libraryRoot: root,
      }),
      prepareTransportImage({
        sourceBytes: source,
        sourceMime: "image/png",
        sourceSha256: sha256(source),
        purpose: "SearchCard",
        maxDataUrlBytes: 256 * 1024,
        libraryRoot: root,
      }),
    ]);
    assert.equal(left.ok && right.ok, true);
    if (!left.ok || !right.ok) return;
    assert.equal(left.transportSha256, right.transportSha256);

    const cacheDir = path.join(root, "indexes", "transport-images", "v1");
    const files = await fs.readdir(cacheDir);
    const imageFile = files.find((name) => name.endsWith(".img"));
    assert.ok(imageFile);
    await fs.writeFile(path.join(cacheDir, imageFile), files[0] ?? "truncated");
    const rebuilt = await prepareTransportImage({
      sourceBytes: source,
      sourceMime: "image/png",
      sourceSha256: sha256(source),
      purpose: "SearchCard",
      maxDataUrlBytes: 256 * 1024,
      libraryRoot: root,
    });
    assert.equal(rebuilt.ok, true);
    if (!rebuilt.ok) return;
    assert.equal(rebuilt.cacheHit, false);
    assert.equal(rebuilt.transportSha256, first.transportSha256);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("transparent PNG stays PNG and exact preview can pass through a large source", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-transport-alpha-"));
  try {
    const transparent = patternedPng(900, 700, true);
    const search = await prepareTransportImage({
      sourceBytes: transparent,
      sourceMime: "image/png",
      sourceSha256: sha256(transparent),
      purpose: "SearchCard",
      maxDataUrlBytes: 256 * 1024,
      libraryRoot: root,
    });
    assert.equal(search.ok, true);
    if (!search.ok) return;
    assert.equal(search.transportMime, "image/png");

    const large = patternedPng(900, 700);
    const exactBudget = singlePreviewBudget();
    const exact = await prepareTransportImage({
      sourceBytes: large,
      sourceMime: "image/png",
      sourceSha256: sha256(large),
      purpose: "ExactPreview",
      maxDataUrlBytes: exactBudget,
      libraryRoot: root,
    });
    assert.equal(exact.ok, true);
    if (!exact.ok) return;
    assert.ok(exact.inlineBytes <= exactBudget);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("broken images and decode bombs fail closed", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-transport-fail-"));
  try {
    const broken = await prepareTransportImage({
      sourceBytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      sourceMime: "image/png",
      sourceSha256: sha256(new Uint8Array([1, 2, 3])),
      purpose: "SearchCard",
      maxDataUrlBytes: 256 * 1024,
      libraryRoot: root,
    });
    assert.equal(broken.ok, false);
    if (broken.ok) return;
    assert.equal(broken.reason, "unreadable");

    const bombBytes = Buffer.from(ONE_PIXEL_PNG);
    bombBytes.writeUInt32BE(90_000, 16);
    bombBytes.writeUInt32BE(90_000, 20);
    const bomb = await prepareTransportImage({
      sourceBytes: bombBytes,
      sourceMime: "image/png",
      sourceSha256: sha256(bombBytes),
      purpose: "ExactPreview",
      maxDataUrlBytes: singlePreviewBudget(),
      libraryRoot: root,
    });
    assert.equal(bomb.ok, false);
    if (bomb.ok) return;
    assert.equal(bomb.reason, "unsafe_pixels");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
