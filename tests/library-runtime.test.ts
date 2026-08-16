import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  LibraryRuntime,
  applyGlobalLibraryBinding,
  defaultLibraryLocatorPath,
  planGlobalLibraryBinding,
  readLibraryRootMarker,
} from "../src/library-runtime.ts";

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

test("library.json and the machine locator establish one portable user Library", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-runtime-v1-"));
  try {
    const locatorPath = path.join(root, "machine-config", "locator.json");
    const libraryDirectory = path.join(root, "portable-library");
    const runtime = new LibraryRuntime({
      locatorPath,
      env: {},
      homedir: path.join(root, "home"),
    });
    const before = await runtime.current();
    assert.equal(before.directorySource, "legacy-default");
    assert.equal(before.writesEnabled, false);

    const plan = await planGlobalLibraryBinding({ libraryDirectory, locatorPath });
    const applied = await applyGlobalLibraryBinding(plan, "bind-portable-library");
    assert.equal(applied.idempotentReplay, false);
    assert.equal((await applyGlobalLibraryBinding(plan, "bind-portable-library")).idempotentReplay, true);

    const marker = await readLibraryRootMarker(libraryDirectory);
    assert.equal(marker?.value.schema, "figure-library.root.v1");
    assert.equal(marker?.value.libraryId, applied.libraryId);
    assert.deepEqual(marker?.value.storageFormat, {
      major: 1,
      minor: 0,
      layout: "figure-library.store-layout.v1",
      pathPolicy: "portable-relative-posix",
      canonicalJson: "RFC8785",
      digestAlgorithm: "sha256",
    });
    assert.deepEqual(marker?.value.requiredCapabilities, []);
    assert.deepEqual(marker?.value.extensions, {});
    for (const relative of [
      "store/templates",
      "store/operations/intents",
      "store/operations/receipts",
      "store/imports",
      "store/migrations/flat-v1",
      "store/exports",
      "store/quarantine",
      "indexes",
      "locks",
    ]) {
      assert.equal((await fs.stat(path.join(libraryDirectory, ...relative.split("/")))).isDirectory(), true);
    }
    const snapshot = await runtime.refresh();
    assert.equal(snapshot.directorySource, "locator");
    assert.equal(snapshot.root, path.resolve(libraryDirectory));
    assert.equal(snapshot.libraryId, applied.libraryId);
    assert.equal(snapshot.writesEnabled, true);

    const locator = JSON.parse(await fs.readFile(locatorPath, "utf8")) as {
      schema: string;
      libraryDirectory: string;
    };
    assert.equal(locator.schema, "figure-library.locator.v2");
    assert.equal(locator.libraryDirectory, path.resolve(libraryDirectory));
    assert.equal(
      JSON.stringify(marker?.value).includes(path.resolve(libraryDirectory)),
      false,
      "portable library.json must not persist its machine path",
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("copy_legacy stages immutable flat input and does not silently adopt it", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-runtime-legacy-"));
  try {
    const legacy = path.join(root, "legacy");
    const template = path.join(legacy, "templates", "flat-one");
    await fs.mkdir(path.join(template, "code"), { recursive: true });
    const code = "plot(1)\n";
    await fs.writeFile(path.join(template, "code", "plot.R"), code);
    await fs.writeFile(
      path.join(template, "template.json"),
      `${JSON.stringify({
        schema: "figure-library.template.v1",
        templateId: "flat-one",
        sourceId: "user",
        title: "Flat one",
        description: "Explicit migration input",
        tags: [],
        visualProfile: "reference",
        dataProfile: "none",
        packages: [],
        license: "unspecified",
        importedAt: "2026-08-10T00:00:00.000Z",
        reviewStatus: "draft",
        codeStatus: "reviewed",
        code: [{ file: "code/plot.R", bytes: Buffer.byteLength(code), sha256: sha256(code) }],
      }, null, 2)}\n`,
    );
    const libraryDirectory = path.join(root, "library");
    const locatorPath = path.join(root, "config", "locator.json");
    const plan = await planGlobalLibraryBinding({
      libraryDirectory,
      locatorPath,
      migrationMode: "copy_legacy",
      legacySourceDirectory: legacy,
    });
    assert.equal(plan.migration.mode, "copy_legacy");
    const result = await applyGlobalLibraryBinding(plan, "stage-flat-input");
    const staged = path.join(
      libraryDirectory,
      "store",
      "migrations",
      "flat-v1",
      plan.bindingId,
      "source",
      "templates",
      "flat-one",
    );
    assert.equal(await fs.readFile(path.join(staged, "code", "plot.R"), "utf8"), code);
    assert.equal(await fs.readFile(path.join(template, "code", "plot.R"), "utf8"), code);
    assert.equal(await fs.stat(path.join(libraryDirectory, "store", "templates")).then(() => true), true);
    assert.deepEqual(await fs.readdir(path.join(libraryDirectory, "store", "templates")), []);
    const receipt = JSON.parse(await fs.readFile(result.migrationReceiptFile!, "utf8")) as {
      stagedRelativeDirectory: string;
      sourceDirectory?: string;
      targetDirectory?: string;
      sourcePreserved: boolean;
    };
    assert.equal(
      receipt.stagedRelativeDirectory,
      `store/migrations/flat-v1/${plan.bindingId}/source`,
    );
    assert.equal(receipt.sourcePreserved, true);
    assert.equal(receipt.sourceDirectory, undefined);
    assert.equal(receipt.targetDirectory, undefined);
    assert.equal((await applyGlobalLibraryBinding(plan, "stage-flat-input")).idempotentReplay, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("locator paths stay machine-local on Windows and Linux", () => {
  assert.equal(
    defaultLibraryLocatorPath({
      platform: "win32",
      env: { APPDATA: "E:\\Users\\Researcher\\AppData\\Roaming" },
      homedir: "E:\\Users\\Researcher",
    }),
    "E:\\Users\\Researcher\\AppData\\Roaming\\ScientificFigureLibrary\\locator.json",
  );
  assert.equal(
    defaultLibraryLocatorPath({
      platform: "linux",
      env: { XDG_CONFIG_HOME: "/home/researcher/.config-test" },
      homedir: "/home/researcher",
    }),
    "/home/researcher/.config-test/scientific-figure-library/locator.json",
  );
});
