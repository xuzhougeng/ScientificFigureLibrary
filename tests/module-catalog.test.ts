import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ModuleCatalogIndex,
  parseModuleCatalog,
  parseModulePreviewManifest,
  parseModuleSourcePackManifest,
} from "../src/module-catalog.ts";
import { PERSONAL_MODULE_PROVIDER_ID } from "../src/providers.ts";
import type { ModuleCatalog, ModuleCatalogEntry } from "../src/types.ts";

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const digest = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");

function entry(): ModuleCatalogEntry {
  const code = Buffer.from("plot(1:3)\n");
  const data = Buffer.from("x,y\n1,2\n");
  return {
    moduleId: "personal-catalog-fixture",
    title: "个人目录测试",
    titleEn: "Personal Catalog Fixture",
    description: "A cleaned scientific figure module.",
    application: "Catalog validation.",
    dataProfile: "Synthetic CSV.",
    plotFamily: "scatter",
    language: "R",
    tags: ["fixture", "scatter"],
    packages: ["ggplot2"],
    codeFiles: ["code/plot.R"],
    inputFiles: ["data/input.csv"],
    canonicalCode: "code/plot.R",
    requiredFiles: ["code/plot.R", "data/input.csv"],
    files: [
      { path: "code/plot.R", bytes: code.byteLength, sha256: digest(code) },
      { path: "data/input.csv", bytes: data.byteLength, sha256: digest(data) },
    ],
    source: {
      repository: "jarxunlai/ScientificFigureLibrary-personal",
      commit: "1".repeat(40),
      path: "modules/personal-catalog-fixture",
    },
    archive: {
      repository: "jarxunlai/ScientificFigureLibrary-personal",
      commit: "2".repeat(40),
      path: "archives/personal-catalog-fixture.zip",
      bytes: 100,
      sha256: "3".repeat(64),
    },
    preview: {
      path: "previews/personal-catalog-fixture/preview.png",
      bytes: ONE_PIXEL_PNG.byteLength,
      sha256: digest(ONE_PIXEL_PNG),
      mediaType: "image/png",
    },
    thumbnail: {
      path: "thumbs/personal-catalog-fixture.png",
      bytes: ONE_PIXEL_PNG.byteLength,
      sha256: digest(ONE_PIXEL_PNG),
      mediaType: "image/png",
    },
    licenses: { code: "MIT", content: "CC BY 4.0", documentation: "CC BY 4.0" },
    publisher: {
      reviewStatus: "approved",
      executionStatus: "passed",
      executionScope: "synthetic_data",
    },
  };
}

function catalog(module = entry()): ModuleCatalog {
  return {
    schema: "figure-library.module-catalog.v1",
    generatedAt: "2000-01-01T00:00:00.000Z",
    provider: {
      providerId: PERSONAL_MODULE_PROVIDER_ID,
      displayName: "Open Figure Modules",
      repository: "jarxunlai/ScientificFigureLibrary-personal",
    },
    modules: [module],
  };
}

function previewManifest(module = entry()) {
  return {
    schema: "figure-library.module-preview-manifest.v1",
    providerId: PERSONAL_MODULE_PROVIDER_ID,
    entries: [
      { moduleId: module.moduleId, role: "primary", ...module.preview },
      { moduleId: module.moduleId, role: "thumbnail", ...module.thumbnail },
    ],
  };
}

function sourcePackManifest(module = entry()) {
  return {
    schema: "figure-library.module-source-pack.v1",
    providerId: PERSONAL_MODULE_PROVIDER_ID,
    repository: module.source.repository,
    entries: [
      {
        moduleId: module.moduleId,
        sourceRepository: module.source.repository,
        sourceCommit: module.source.commit,
        archiveRepository: module.archive.repository,
        archiveCommit: module.archive.commit,
        file: module.archive.path,
        bytes: module.archive.bytes,
        sha256: module.archive.sha256,
      },
    ],
  };
}

test("module Catalog validates exact provider/repository, files, previews, and Source Pack identities", () => {
  const value = catalog();
  assert.deepEqual(
    parseModuleCatalog(value, {
      expectedProviderId: PERSONAL_MODULE_PROVIDER_ID,
      expectedRepository: "jarxunlai/ScientificFigureLibrary-personal",
    }),
    value,
  );
  assert.deepEqual(parseModulePreviewManifest(previewManifest(), value), previewManifest());
  assert.deepEqual(parseModuleSourcePackManifest(sourcePackManifest(), value), sourcePackManifest());
  assert.deepEqual(
    parseModuleSourcePackManifest(
      { ...sourcePackManifest(), entries: [] },
      value,
    ).entries,
    [],
  );
});

test("module Catalog rejects stale, unsafe, duplicate, private, and non-public identities", () => {
  const base = entry();
  assert.throws(
    () => parseModuleCatalog(catalog({ ...base, requiredFiles: ["code/plot.R", "code/plot.R"] })),
    /duplicates/u,
  );
  assert.throws(
    () => parseModuleCatalog(catalog({ ...base, requiredFiles: ["code/plot.R", "missing.csv"] })),
    /undeclared/u,
  );
  assert.throws(
    () => parseModuleCatalog(catalog({ ...base, files: [{ ...base.files[0]!, path: "CON" }, base.files[1]!] })),
    /portable/u,
  );
  assert.throws(
    () => parseModuleCatalog(catalog({ ...base, description: "Read E:/private/patient.csv" })),
    /machine-local/u,
  );
  assert.throws(
    () => parseModuleCatalog(catalog({ ...base, licenses: { ...base.licenses, content: "unknown" } })),
    /public redistribution/u,
  );
  assert.throws(
    () => parseModuleCatalog(catalog({ ...base, licenses: { ...base.licenses, content: "unknown rights" } })),
    /public redistribution/u,
  );
  assert.throws(
    () => parseModuleCatalog({ ...catalog(), provider: { ...catalog().provider, providerId: "org.figureya.module" } }, { expectedProviderId: PERSONAL_MODULE_PROVIDER_ID }),
    /providerId/u,
  );
  assert.throws(
    () => parseModuleSourcePackManifest({ ...sourcePackManifest(), entries: [{ ...sourcePackManifest().entries[0]!, archiveCommit: "f".repeat(40) }] }, catalog()),
    /does not match/u,
  );
  const jpeg = entry();
  jpeg.preview = {
    ...jpeg.preview,
    path: `previews/${jpeg.moduleId}/preview.jpeg`,
    mediaType: "image/jpeg",
  };
  jpeg.thumbnail = {
    ...jpeg.thumbnail,
    path: `thumbs/${jpeg.moduleId}.jpeg`,
    mediaType: "image/jpeg",
  };
  assert.doesNotThrow(() => parseModuleCatalog(catalog(jpeg)));
});

test("ModuleCatalogIndex loads a healthy empty snapshot and rejects preview tampering", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-module-catalog-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const module = entry();
  await fs.mkdir(path.join(root, "previews", module.moduleId), { recursive: true });
  await fs.mkdir(path.join(root, "thumbs"), { recursive: true });
  await fs.writeFile(path.join(root, "module-catalog.json"), `${JSON.stringify(catalog(module))}\n`);
  await fs.writeFile(path.join(root, "module-preview.manifest.json"), `${JSON.stringify(previewManifest(module))}\n`);
  await fs.writeFile(path.join(root, "module-source-pack.manifest.json"), `${JSON.stringify(sourcePackManifest(module))}\n`);
  await fs.writeFile(path.join(root, "PERSONAL_MODULES_LICENSE.txt"), "Personal module fixture\n");
  await fs.writeFile(path.join(root, ...module.preview.path.split("/")), ONE_PIXEL_PNG);
  await fs.writeFile(path.join(root, ...module.thumbnail.path.split("/")), ONE_PIXEL_PNG);
  const loaded = await ModuleCatalogIndex.load(root, {
    expectedProviderId: PERSONAL_MODULE_PROVIDER_ID,
    validatePreviews: true,
  });
  assert.equal(loaded.catalog.modules.length, 1);
  assert.equal((await loaded.searchAll({ query: "personal catalog scatter" }))[0]?.providerId, PERSONAL_MODULE_PROVIDER_ID);
  await fs.writeFile(path.join(root, ...module.thumbnail.path.split("/")), Buffer.from("tampered"));
  await assert.rejects(
    ModuleCatalogIndex.load(root, { expectedProviderId: PERSONAL_MODULE_PROVIDER_ID, validatePreviews: true }),
    /differs from its pinned identity/u,
  );

  const emptyRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-module-empty-"));
  t.after(() => fs.rm(emptyRoot, { recursive: true, force: true }));
  const empty = await ModuleCatalogIndex.load(emptyRoot, {
    expectedProviderId: PERSONAL_MODULE_PROVIDER_ID,
  });
  assert.equal(empty.catalog.modules.length, 0);

  const missingRoot = path.join(root, "missing-snapshot");
  const missing = await ModuleCatalogIndex.load(missingRoot, {
    expectedProviderId: PERSONAL_MODULE_PROVIDER_ID,
  });
  assert.equal(missing.catalog.modules.length, 0);

  const partialRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-module-partial-"));
  t.after(() => fs.rm(partialRoot, { recursive: true, force: true }));
  await fs.writeFile(path.join(partialRoot, "module-preview.manifest.json"), "{}\n");
  await assert.rejects(
    ModuleCatalogIndex.load(partialRoot, { expectedProviderId: PERSONAL_MODULE_PROVIDER_ID }),
    /ENOENT|module-catalog/u,
  );

  const extraRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-module-extra-"));
  t.after(() => fs.rm(extraRoot, { recursive: true, force: true }));
  await fs.cp(root, extraRoot, { recursive: true });
  await fs.writeFile(path.join(extraRoot, "unexpected.json"), "{}\n");
  await assert.rejects(
    ModuleCatalogIndex.load(extraRoot, { expectedProviderId: PERSONAL_MODULE_PROVIDER_ID }),
    /undeclared file/u,
  );
});

test("OFM v1 retains Markdown and optional scientificQuestion; legacy catalog needs no migration", () => {
  const module = { ...entry(), description: "**背景**\n\n第二段", application: "### 场景\n\n- 比较处理组", dataProfile: "sample × group", scientificQuestion: "处理组组成是否不同？" };
  const parsed = parseModuleCatalog(catalog(module));
  assert.equal(parsed.modules[0]?.description, module.description);
  assert.equal(parsed.modules[0]?.application, module.application);
  assert.equal(parsed.modules[0]?.dataProfile, module.dataProfile);
  assert.equal(parsed.modules[0]?.scientificQuestion, module.scientificQuestion);
  assert.equal(parseModuleCatalog(catalog()).modules[0]?.scientificQuestion, undefined);
});
