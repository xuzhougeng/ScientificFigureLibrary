import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createGalleryCache } from "../src/local/gallery-cache.ts";
import type { CatalogIndex } from "../src/catalog.ts";
import type { ModuleCatalogIndex } from "../src/module-catalog.ts";
import { FIGUREYA_PROVIDER_ID, PERSONAL_MODULE_PROVIDER_ID } from "../src/providers.ts";

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
  await cache.apply({ planDigest: plan.planDigest, confirmedBy: "user" });
  assert.deepEqual(roles, ["primary", "thumbnail"]);
  const stale = await cache.plan({ providerId: PERSONAL_MODULE_PROVIDER_ID, mode: "code" });
  Object.assign(index, { catalogSha256: "two" });
  await assert.rejects(cache.apply({ planDigest: stale.plan.planDigest, confirmedBy: "user" }), /变化/u);
  await assert.rejects(cache.plan({ providerId: "untrusted", mode: "code" }));
});
