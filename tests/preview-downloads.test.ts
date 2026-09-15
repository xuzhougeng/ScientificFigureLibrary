import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { PreviewDownloadStore, PREVIEW_DOWNLOAD_MANIFEST, type PreviewDownloadFile } from "../src/preview-downloads.ts";
import { CatalogIndex } from "../src/catalog.ts";
import { ModuleCatalogIndex } from "../src/module-catalog.ts";

const root = path.resolve(import.meta.dirname, "..");
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const file: PreviewDownloadFile = { path: "previews/test.png", bytes: png.length, sha256: hash(png), mediaType: "image/png" };
const manifest = (files = [file]) => ({ schema: "figure-library.preview-downloads.v1", providerId: "test", repository: "example/gallery", commit: "a".repeat(40), prefix: "assets", files });
const reply = (url: string, bytes: Uint8Array) => ({ url, bytes, mediaType: "image/png", accessUrls: [url] });
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-preview-download-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, PREVIEW_DOWNLOAD_MANIFEST), JSON.stringify(manifest()));
  return { dir, cacheDirectory: path.join(dir, "cache") };
}

test("preview downloads fetch only on read, deduplicate, pin the URL, and reuse verified cache offline", async t => {
  const { dir, cacheDirectory } = await fixture(t);
  let requests = 0;
  const store = await PreviewDownloadStore.load(dir, "test", [file], { cacheDirectory, fetcher: { fetch: async (url, options) => {
    requests++;
    assert.equal(url, `https://raw.githubusercontent.com/example/gallery/${"a".repeat(40)}/assets/previews/test.png`);
    assert.equal(options.maxBytes, png.length);
    await new Promise(resolve => setTimeout(resolve, 20));
    return reply(url, png);
  } } });
  assert.ok(store);
  assert.ok(store.has(file.path));
  assert.equal(requests, 0);
  const images = await Promise.all([store.read(file.path), store.read(file.path), store.read(file.path)]);
  assert.equal(requests, 1);
  images.forEach(bytes => assert.deepEqual(bytes, png));
  const offline = await PreviewDownloadStore.load(dir, "test", [file], { cacheDirectory, fetcher: { fetch: async () => { throw new Error("offline cache must not use network"); } } });
  assert.deepEqual(await offline!.read(file.path, false), png);
  assert.deepEqual(await offline!.read(file.path), png);
  await fs.rm(cacheDirectory, { recursive: true });
  await assert.rejects(offline!.read(file.path, false), /no longer cached/u);
});

test("preview cache status and batch fill report missing files then reuse the verified cache", async t => {
  const { dir, cacheDirectory } = await fixture(t);
  let requests = 0;
  const store = (await PreviewDownloadStore.load(dir, "test", [file], { cacheDirectory, fetcher: { fetch: async url => {
    requests++;
    return reply(url, png);
  } } }))!;
  assert.deepEqual(await store.status(), { total: 1, cached: 0, missing: 1, bytesTotal: png.length, bytesCached: 0 });
  const filled = await store.cacheMissing(1);
  assert.equal(filled.filled, 1);
  assert.equal(filled.failed, 0);
  assert.equal(filled.cached, 1);
  assert.equal(filled.missing, 0);
  assert.equal(requests, 1);
  const again = await store.cacheMissing();
  assert.equal(again.filled, 0);
  assert.equal(again.cached, 1);
  assert.equal(requests, 1);
});

test("bad downloads never populate cache and corrupted cache requires a fresh preview", async t => {
  const { dir, cacheDirectory } = await fixture(t);
  let bytes: Uint8Array = Buffer.alloc(png.length);
  let requests = 0;
  const store = (await PreviewDownloadStore.load(dir, "test", [file], { cacheDirectory, fetcher: { fetch: async url => { requests++; return reply(url, bytes); } } }))!;
  await assert.rejects(store.read(file.path), /pinned size or SHA-256/u);
  assert.deepEqual(await fs.readdir(cacheDirectory), []);
  bytes = png;
  await store.read(file.path);
  const cacheFile = path.join(cacheDirectory, file.sha256 + ".png");
  await fs.writeFile(cacheFile, "corrupt");
  await assert.rejects(store.read(file.path, false), /pinned size/u);
  assert.equal(requests, 2);
  assert.deepEqual(await store.read(file.path), png);
  assert.equal(requests, 3);
  assert.deepEqual(await fs.readFile(cacheFile), png);
});

test("preview descriptors cannot change identities, duplicate entries, or traverse paths", async t => {
  const { dir, cacheDirectory } = await fixture(t);
  for (const value of [
    { ...manifest(), providerId: "wrong" },
    manifest([{ ...file, sha256: "b".repeat(64) }]),
    manifest([file, file]),
    { ...manifest(), prefix: "../assets" },
    { ...manifest(), commit: "main" },
    manifest([{ ...file, path: "../test.png" }]),
  ]) {
    await fs.writeFile(path.join(dir, PREVIEW_DOWNLOAD_MANIFEST), JSON.stringify(value));
    await assert.rejects(PreviewDownloadStore.load(dir, "test", [file], { cacheDirectory }));
  }
});

test("matching digest alone cannot turn malformed bytes into a preview", async t => {
  const { dir, cacheDirectory } = await fixture(t);
  const bytes = Buffer.from("this is not an image");
  const invalid = { ...file, bytes: bytes.length, sha256: hash(bytes) };
  await fs.writeFile(path.join(dir, PREVIEW_DOWNLOAD_MANIFEST), JSON.stringify(manifest([invalid])));
  const store = (await PreviewDownloadStore.load(dir, "test", [invalid], { cacheDirectory, fetcher: { fetch: async url => reply(url, bytes) } }))!;
  await assert.rejects(store.read(file.path), /image|PNG|png/u);
  assert.deepEqual(await fs.readdir(cacheDirectory), []);
});

test("preview cache refuses symlink entries", { skip: process.platform === "win32" }, async t => {
  const { dir, cacheDirectory } = await fixture(t);
  await fs.mkdir(cacheDirectory);
  const target = path.join(dir, "outside.png");
  await fs.writeFile(target, png);
  await fs.symlink(target, path.join(cacheDirectory, file.sha256 + ".png"));
  const store = (await PreviewDownloadStore.load(dir, "test", [file], { cacheDirectory, fetcher: { fetch: async () => { throw new Error("must not fetch"); } } }))!;
  await assert.rejects(store.read(file.path), /not a regular file/u);
  assert.deepEqual(await fs.readFile(target), png);
});

test("lightweight FigureYa and module catalogs search without image I/O and fetch only selected roles", async t => {
  const { dir, cacheDirectory } = await fixture(t);
  // Use the same payload descriptors as the installer, without copying any gallery image.
  const script = path.join(root, "scripts/preview-download-manifest.mjs");
  const { previewDownloadManifests } = await import(pathToFileURL(script).href);
  const { manifests, excluded } = await previewDownloadManifests(root, "xuzhougeng/ScientificFigureLibrary", "a".repeat(40));
  assert.equal(excluded.size, 388);
  for (const relative of ["assets/catalog.json", "assets/figureya-preview.manifest.json", ...["module-catalog.json", "module-preview.manifest.json", "module-source-pack.manifest.json", "PERSONAL_MODULES_LICENSE.txt"].map(name => "assets/personal-modules/" + name)]) {
    await fs.mkdir(path.dirname(path.join(dir, relative)), { recursive: true });
    await fs.copyFile(path.join(root, relative), path.join(dir, relative));
  }
  for (const [relative, bytes] of manifests) await fs.writeFile(path.join(dir, relative), bytes);
  const requests: string[] = [];
  const fetcher = { fetch: async (url: string) => {
    const relative = decodeURIComponent(new URL(url).pathname.split("/").slice(4).join("/"));
    assert.ok(excluded.has(relative));
    requests.push(relative);
    return reply(url, await fs.readFile(path.join(root, relative)));
  } };
  const figureYa = await CatalogIndex.load(path.join(dir, "assets"), { cacheDirectory, fetcher });
  const modules = await ModuleCatalogIndex.load(path.join(dir, "assets/personal-modules"), { downloads: { cacheDirectory, fetcher } });
  const figures = await figureYa.searchAll({ query: "volcano" });
  const results = await modules.searchAll({ query: "heatmap" });
  assert.ok(figures.length > 0 && results.length > 0);
  assert.equal(requests.length, 0);
  assert.equal(figures[0]!.previewDelivery, "download");
  assert.equal(results[0]!.previewDelivery, "download");
  const module = modules.catalog.modules[0]!;
  await modules.preview(module, "thumbnail");
  assert.deepEqual(requests, ["assets/personal-modules/" + module.thumbnail.path]);
  await assert.rejects(modules.preview(module, "primary", false), /no longer cached/u);
  assert.equal(requests.length, 1);
  await modules.preview(module, "primary");
  assert.equal(requests[1], "assets/personal-modules/" + module.preview.path);
  await figureYa.preview(figures[0]!.exactSelector);
  assert.equal(requests.length, 3);
  const offline = await CatalogIndex.load(path.join(dir, "assets"), { cacheDirectory, fetcher: { fetch: async () => { throw new Error("offline"); } } });
  assert.ok(await offline.preview(figures[0]!.exactSelector, false));
  assert.equal(requests.length, 3);
});
