import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createGalleryCache } from "../src/local/gallery-cache.ts";
import type { CatalogIndex } from "../src/catalog.ts";
import type { ModuleCatalogIndex } from "../src/module-catalog.ts";
import { FIGUREYA_PROVIDER_ID, PERSONAL_MODULE_PROVIDER_ID } from "../src/providers.ts";

test("background images return immediately, expose progress, isolate failures and replay without restarting", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-background-cache-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let release!: () => void;
  let entered!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  let reads = 0;
  const figureYa = { catalog: { modules: [{ moduleId: "ok", primaryPreview: "ok.png" }, { moduleId: "broken", primaryPreview: "broken.png" }] }, preview: async (id: string) => {
    reads++; entered(); await blocked;
    if (id === "broken") throw new Error("download failed");
    return { bytes: Buffer.from("fixture"), extension: ".png" };
  } } as unknown as CatalogIndex;
  const cache = createGalleryCache({ figureYa, modules: () => undefined, library: async () => ({ root, contextKey: "one", writesEnabled: true }) });
  const { plan } = await cache.plan({ providerId: FIGUREYA_PROVIDER_ID, mode: "images" });
  const input = { planDigest: plan.planDigest, confirmedBy: "user" };
  const initial = cache.start(input).task;
  assert.equal(initial.state, "running");
  assert.equal(initial.total, 2);
  await started;
  assert.equal(cache.tasks().tasks[0]!.currentItem, "ok/image");
  assert.equal(cache.start(input).task.id, initial.id);
  const duplicate = await cache.plan({ providerId: FIGUREYA_PROVIDER_ID, mode: "images" });
  assert.throws(() => cache.start({ ...input, planDigest: duplicate.plan.planDigest }), /已有缓存任务/u);
  const snapshot = cache.tasks(); snapshot.tasks[0]!.processed = 99;
  assert.equal(cache.tasks().tasks[0]!.processed, 0);
  release();
  await cache.apply(input);
  await new Promise(resolve => setImmediate(resolve));
  const completed = cache.tasks().tasks[0]!;
  assert.equal(completed.state, "completed");
  assert.equal(completed.processed, 2);
  assert.equal(completed.images, 1);
  assert.equal(completed.failures.length, 1);
  assert.equal(cache.start(input).task.state, "completed");
  assert.equal(reads, 2);
});

test("background stale plans report a terminal failure without downloading", async () => {
  let contextKey = "one";
  const figureYa = { catalog: { modules: [] } } as unknown as CatalogIndex;
  const cache = createGalleryCache({ figureYa, modules: () => undefined, library: async () => ({ root: os.tmpdir(), contextKey, writesEnabled: true }) });
  const { plan } = await cache.plan({ providerId: FIGUREYA_PROVIDER_ID, mode: "images" });
  contextKey = "two";
  cache.start({ planDigest: plan.planDigest, confirmedBy: "user" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cache.tasks().tasks[0]!.state, "failed");
  assert.match(cache.tasks().tasks[0]!.error!, /变化/u);
});

test("gallery cache status counts preview files per gallery", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-gallery-cache-status-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const imageDirectory = path.join(root, "indexes", "preview-cache", "v1");
  await fs.mkdir(imageDirectory, { recursive: true });
  const figureImage = "a".repeat(64);
  const moduleImage = "b".repeat(64);
  await fs.writeFile(path.join(imageDirectory, `${figureImage}.png`), "figure");
  await fs.writeFile(path.join(imageDirectory, `${moduleImage}.jpg`), "module");
  const figureYa = { catalog: { modules: [{ primaryPreview: "figure.png", previewSha256: figureImage }] } } as unknown as CatalogIndex;
  const modules = { catalog: { modules: [{ preview: { path: "preview.jpg", sha256: moduleImage }, thumbnail: { path: "thumbnail.png", sha256: "c".repeat(64) } }] } } as unknown as ModuleCatalogIndex;
  const cache = createGalleryCache({ figureYa, modules: () => modules, library: async () => ({ root, contextKey: "one", writesEnabled: true }) });
  const status = await cache.status();
  assert.equal((status.providers[FIGUREYA_PROVIDER_ID] as { imageFiles: number }).imageFiles, 1);
  assert.equal((status.providers[PERSONAL_MODULE_PROVIDER_ID] as { imageFiles: number }).imageFiles, 1);
  assert.equal(status.imageFiles, 2);
});

test("gallery cache plans are read-only, isolate image failures, and replay concurrent Apply", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-gallery-cache-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let reads = 0;
  let contextKey = "one";
  const figureYa = { catalog: { modules: [{ moduleId: "ok", primaryPreview: "ok.png", archiveAvailable: false }, { moduleId: "broken", primaryPreview: "broken.png", archiveAvailable: false }] }, preview: async (id: string) => {
    reads++; if (id === "broken") throw new Error("pinned hash mismatch");
    return { bytes: Buffer.from("verified image fixture"), extension: ".png" };
  } } as unknown as CatalogIndex;
  const cache = createGalleryCache({ figureYa, modules: () => undefined, library: async () => ({ root, contextKey, writesEnabled: true }) });
  const { plan } = await cache.plan({ providerId: FIGUREYA_PROVIDER_ID, mode: "images" });
  assert.equal(plan.archives, 0);
  assert.equal(reads, 0);
  assert.deepEqual(await fs.readdir(root), []);
  await assert.rejects(cache.apply({ planDigest: plan.planDigest }), /user/u);
  const [first, replay] = await Promise.all([cache.apply({ planDigest: plan.planDigest, confirmedBy: "user" }), cache.apply({ planDigest: plan.planDigest, confirmedBy: "user" })]);
  assert.deepEqual(first, replay);
  assert.equal(reads, 2);
  assert.equal((first as { images: number }).images, 1);
  assert.equal((first as { failures: unknown[] }).failures.length, 1);
  assert.equal((await fs.readdir(plan.imageDirectory)).length, 1);
  const stale = await cache.plan({ providerId: FIGUREYA_PROVIDER_ID, mode: "update" });
  contextKey = "two";
  await assert.rejects(cache.apply({ planDigest: stale.plan.planDigest, confirmedBy: "user" }), /变化/u);
  assert.equal(reads, 2);
});

test("Open Figure caches both preview roles and rejects a changed catalog or unavailable provider", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-open-cache-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const roles: string[] = [];
  const index = { catalogSha256: "one", catalog: { modules: [{ moduleId: "fixture" }] }, preview: async (_module: unknown, role: string) => { roles.push(role); return { bytes: Buffer.from(role), extension: ".png" }; } } as unknown as ModuleCatalogIndex;
  const cache = createGalleryCache({ figureYa: {} as CatalogIndex, modules: () => index, library: async () => ({ root, contextKey: "one", writesEnabled: true }) });
  const { plan } = await cache.plan({ providerId: PERSONAL_MODULE_PROVIDER_ID, mode: "images" });
  assert.equal(plan.images, 2);
  assert.equal(cache.start({ planDigest: plan.planDigest, confirmedBy: "user" }).task.total, 2);
  await cache.apply({ planDigest: plan.planDigest, confirmedBy: "user" });
  assert.deepEqual(roles, ["primary", "thumbnail"]);
  assert.equal(cache.tasks().tasks[0]!.processed, 2);
  const stale = await cache.plan({ providerId: PERSONAL_MODULE_PROVIDER_ID, mode: "code" });
  Object.assign(index, { catalogSha256: "two" });
  await assert.rejects(cache.apply({ planDigest: stale.plan.planDigest, confirmedBy: "user" }), /变化/u);
  await assert.rejects(cache.plan({ providerId: "untrusted", mode: "code" }));
});
