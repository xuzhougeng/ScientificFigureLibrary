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
  ensureLibraryRootMarker,
  planGlobalLibraryBinding,
  readLibraryRootMarker,
} from "../src/library-runtime.ts";

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

const LIBRARY_A = "11111111-1111-4111-8111-111111111111";
const LIBRARY_B = "22222222-2222-4222-8222-222222222222";

function locatorV2(libraryDirectory: string, libraryId: string, configRevision = 7) {
  return `${JSON.stringify({
    schema: "figure-library.locator.v2",
    configRevision,
    libraryId,
    libraryDirectory,
    updatedAt: "2026-08-21T00:00:00.000Z",
  }, null, 2)}\n`;
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

test("binding plans classify every broken locator without weakening runtime resolution", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-runtime-broken-locators-"));
  try {
    const locatorPath = path.join(root, "config", "locator.json");
    const selectedLibrary = path.join(root, "selected-library");
    await ensureLibraryRootMarker(selectedLibrary, LIBRARY_A);
    await fs.mkdir(path.dirname(locatorPath), { recursive: true });
    const runtime = new LibraryRuntime({ locatorPath, env: {}, homedir: path.join(root, "home") });

    const cases: Array<{
      status: string;
      write: () => Promise<void>;
      revision: number | null;
    }> = [
      {
        status: "missing",
        write: async () => {
          await fs.rm(locatorPath, { force: true });
        },
        revision: null,
      },
      {
        status: "malformed_json",
        write: async () => {
          await fs.writeFile(locatorPath, "{not-json\n");
        },
        revision: null,
      },
      {
        status: "unsupported_or_v1_schema",
        write: async () => {
          await fs.writeFile(
            locatorPath,
            `${JSON.stringify({
              schema: "figure-library.locator.v1",
              configRevision: 4,
              libraryId: LIBRARY_A,
              libraryDirectory: selectedLibrary,
              updatedAt: "2026-08-21T00:00:00.000Z",
            })}\n`,
          );
        },
        revision: 4,
      },
      {
        status: "dangling_target",
        write: async () => {
          await fs.writeFile(
            locatorPath,
            locatorV2(path.join(root, "deleted-library"), LIBRARY_A, 5),
          );
        },
        revision: 5,
      },
      {
        status: "target_missing_root_marker",
        write: async () => {
          const unmarked = path.join(root, "unmarked-library");
          await fs.mkdir(unmarked, { recursive: true });
          await fs.writeFile(locatorPath, locatorV2(unmarked, LIBRARY_A, 6));
        },
        revision: 6,
      },
      {
        status: "library_id_mismatch",
        write: async () => {
          const mismatched = path.join(root, "mismatched-library");
          await ensureLibraryRootMarker(mismatched, LIBRARY_B);
          await fs.writeFile(locatorPath, locatorV2(mismatched, LIBRARY_A, 7));
        },
        revision: 7,
      },
      {
        status: "valid_v2",
        write: async () => {
          await fs.writeFile(locatorPath, locatorV2(selectedLibrary, LIBRARY_A, 8));
        },
        revision: 8,
      },
    ];

    for (const fixture of cases) {
      await fixture.write();
      const before = await fs.readFile(locatorPath).catch(() => undefined);
      const plan = await planGlobalLibraryBinding({
        locatorPath,
        libraryDirectory: selectedLibrary,
      });
      assert.equal(plan.expectedLocatorStatus, fixture.status);
      assert.equal(plan.expectedConfigRevision, fixture.revision);
      assert.equal(plan.configRevision, (fixture.revision ?? 0) + 1);
      assert.equal(
        plan.expectedLocatorRawDigest,
        before ? createHash("sha256").update(before).digest("hex") : null,
      );
      assert.equal(plan.expectedTargetMarkerDigest, (await readLibraryRootMarker(selectedLibrary))?.digest);
      assert.deepEqual(plan.expectedTargetInventory, []);
      const after = await fs.readFile(locatorPath).catch(() => undefined);
      assert.deepEqual(after, before, `planning changed the ${fixture.status} locator`);

      if (fixture.status === "missing") {
        const snapshot = await runtime.current();
        assert.equal(snapshot.directorySource, "legacy-default");
      } else if (fixture.status === "valid_v2") {
        const snapshot = await runtime.current();
        assert.equal(snapshot.root, path.resolve(selectedLibrary));
      } else {
        await assert.rejects(runtime.current());
      }
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("broken locator recovery Apply revalidates raw bytes and replays safely", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-runtime-locator-recovery-"));
  try {
    const locatorPath = path.join(root, "config", "locator.json");
    const libraryDirectory = path.join(root, "selected-library");
    await fs.mkdir(path.dirname(locatorPath), { recursive: true });
    await ensureLibraryRootMarker(libraryDirectory, LIBRARY_A);
    await fs.writeFile(locatorPath, "{broken\n");
    const stalePlan = await planGlobalLibraryBinding({ locatorPath, libraryDirectory });
    await fs.writeFile(locatorPath, "{changed\n");
    await assert.rejects(
      applyGlobalLibraryBinding(stalePlan, "stale-broken-locator"),
      /stale global library binding plan: locator changed after planning/u,
    );
    assert.equal(await fs.readFile(locatorPath, "utf8"), "{changed\n");

    const plan = await planGlobalLibraryBinding({ locatorPath, libraryDirectory });
    const applied = await applyGlobalLibraryBinding(plan, "recover-broken-locator");
    assert.equal(applied.idempotentReplay, false);
    const locator = JSON.parse(await fs.readFile(locatorPath, "utf8")) as Record<string, unknown>;
    assert.equal(locator.schema, "figure-library.locator.v2");
    assert.equal(locator.libraryId, LIBRARY_A);
    assert.equal(locator.libraryDirectory, path.resolve(libraryDirectory));
    assert.equal(locator.configRevision, 1);
    const replayed = await applyGlobalLibraryBinding(plan, "recover-broken-locator");
    assert.equal(replayed.idempotentReplay, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("broken locator recovery Apply rejects changed locator targets and selected Library state", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-runtime-locator-recovery-stale-"));
  try {
    const locatorPath = path.join(root, "config", "locator.json");
    const danglingTarget = path.join(root, "old-deleted-library");
    const selectedLibrary = path.join(root, "selected-library");
    await fs.mkdir(path.dirname(locatorPath), { recursive: true });
    await ensureLibraryRootMarker(selectedLibrary, LIBRARY_A);
    await fs.writeFile(locatorPath, locatorV2(danglingTarget, LIBRARY_B, 3));
    const targetStatePlan = await planGlobalLibraryBinding({
      locatorPath,
      libraryDirectory: selectedLibrary,
    });
    assert.equal(targetStatePlan.expectedLocatorStatus, "dangling_target");
    await ensureLibraryRootMarker(danglingTarget, LIBRARY_B);
    await assert.rejects(
      applyGlobalLibraryBinding(targetStatePlan, "old-locator-target-changed"),
      /stale global library binding plan: locator changed after planning/u,
    );

    await fs.rm(locatorPath, { force: true });
    const inventoryPlan = await planGlobalLibraryBinding({
      locatorPath,
      libraryDirectory: selectedLibrary,
    });
    const added = path.join(selectedLibrary, "store", "unexpected.json");
    await fs.writeFile(added, "{}\n");
    await assert.rejects(
      applyGlobalLibraryBinding(inventoryPlan, "selected-inventory-changed"),
      /stale global library binding plan: target contents changed/u,
    );
    await fs.rm(added);

    const uncreatedTarget = path.join(root, "uncreated-target");
    const markerPlan = await planGlobalLibraryBinding({
      locatorPath,
      libraryDirectory: uncreatedTarget,
    });
    await ensureLibraryRootMarker(uncreatedTarget, LIBRARY_B);
    await assert.rejects(
      applyGlobalLibraryBinding(markerPlan, "selected-marker-changed"),
      /stale global library binding plan: target root marker changed/u,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("binding recovery honors FIGURE_LIBRARY_DIR at plan time", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-runtime-recovery-override-"));
  try {
    const locatorPath = path.join(root, "config", "locator.json");
    const override = path.join(root, "override-library");
    const other = path.join(root, "other-library");
    await fs.mkdir(path.dirname(locatorPath), { recursive: true });
    await fs.writeFile(locatorPath, "{broken\n");
    await assert.rejects(
      planGlobalLibraryBinding({
        locatorPath,
        libraryDirectory: other,
        environmentOverrideRoot: override,
      }),
      /FIGURE_LIBRARY_DIR environment override/u,
    );
    assert.equal(await fs.readFile(locatorPath, "utf8"), "{broken\n");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
