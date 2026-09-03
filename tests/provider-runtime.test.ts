import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ensureLibraryRootMarker } from "../src/library-runtime.ts";
import {
  DefaultProviderRegistry,
  UnavailableProviderAdapter,
} from "../src/provider-registry.ts";
import { createRuntimeProviderController } from "../src/provider-runtime.ts";
import { ProviderSourceManager, type ProviderSourcePaths } from "../src/provider-sources.ts";
import { COMMUNITY_PROVIDER_ID } from "../src/public-catalog-provider.ts";
import {
  FIGUREYA_PROVIDER_ID,
  LOCAL_LIBRARY_PROVIDER_ID,
  PERSONAL_MODULE_PROVIDER_ID,
} from "../src/providers.ts";
import { createServer } from "../src/server.ts";

function record(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

async function emptyManager(root: string) {
  const configRoot = path.join(root, "config");
  const paths: ProviderSourcePaths = {
    configRoot,
    registryFile: path.join(configRoot, "provider-sources.json"),
    dataRoot: path.join(root, "data"),
  };
  return new ProviderSourceManager({ paths });
}

test("runtime defaults omit frozen Community and order Local, FigureYa, then bundled personal modules", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-provider-runtime-order-"));
  try {
    const controller = await createRuntimeProviderController({ manager: await emptyManager(root) });
    assert.deepEqual(controller.registry.defaultProviderIds(), [
      LOCAL_LIBRARY_PROVIDER_ID,
      FIGUREYA_PROVIDER_ID,
      PERSONAL_MODULE_PROVIDER_ID,
    ]);
    assert.deepEqual(
      controller.registry.list().map((descriptor) => descriptor.providerId),
      [
        LOCAL_LIBRARY_PROVIDER_ID,
        COMMUNITY_PROVIDER_ID,
        FIGUREYA_PROVIDER_ID,
        PERSONAL_MODULE_PROVIDER_ID,
      ],
    );
    const community = controller.registry.get(COMMUNITY_PROVIDER_ID).descriptor;
    assert.equal(community.enabled, true);
    assert.equal(community.includeInDefaultSearch, false);
    assert.equal(community.frozen, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a corrupt opted-in personal Provider degrades default search but fails explicit-only search", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-provider-runtime-corrupt-"));
  const libraryRoot = path.join(root, "library");
  const prior = process.env.FIGURE_LIBRARY_DIR;
  try {
    await ensureLibraryRootMarker(libraryRoot);
    process.env.FIGURE_LIBRARY_DIR = libraryRoot;
    const controller = await createRuntimeProviderController({ manager: await emptyManager(root) });
    const providerId = "io.example.corrupt-figures";
    controller.registry.replaceProviders([], [
      new UnavailableProviderAdapter({
        providerId,
        sourceLabel: "Corrupt fixture",
        enabled: true,
        includeInDefaultSearch: true,
        safeMessage: "verified snapshot inventory mismatch",
      }),
    ]);
    const server = await createServer({ registry: controller.registry });
    const client = new Client({ name: "provider-runtime-test", version: "0.6.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const defaultSearch = await client.callTool({
        name: "figure_library_search",
        arguments: { query: "no exact match expected qzjxkv" },
      });
      const defaultStructured = record(defaultSearch.structuredContent);
      const sources = defaultStructured.sources as Array<Record<string, unknown>>;
      const failed = sources.find((source) => source.providerId === providerId);
      assert.equal(failed?.health, "corrupt");
      assert.equal(failed?.errorCode, "provider_snapshot_corrupt");
      assert.equal(record(defaultStructured.envelope).outcome, "ok");

      const explicitSearch = await client.callTool({
        name: "figure_library_search",
        arguments: { query: "qzjxkv", providerIds: [providerId] },
      });
      const explicitEnvelope = record(record(explicitSearch.structuredContent).envelope);
      assert.equal(explicitEnvelope.outcome, "failed");
      assert.match(String(explicitEnvelope.summary), /provider_snapshot_corrupt/u);
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    if (prior === undefined) delete process.env.FIGURE_LIBRARY_DIR;
    else process.env.FIGURE_LIBRARY_DIR = prior;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("configured-but-disabled personal Providers remain addressable but stay out of defaults", () => {
  const adapter = new UnavailableProviderAdapter({
    providerId: "io.example.disabled-figures",
    sourceLabel: "Disabled fixture",
    enabled: false,
    includeInDefaultSearch: true,
    safeMessage: "disabled fixture",
  });
  const registry = new DefaultProviderRegistry([adapter]);
  assert.deepEqual(registry.defaultProviderIds(), []);
  assert.equal(registry.get(adapter.descriptor.providerId), adapter);
});

test("a corrupt bundled personal module snapshot is skipped in aggregate search and fails explicit search", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-personal-snapshot-corrupt-"));
  const libraryRoot = path.join(root, "library");
  const snapshotRoot = path.join(root, "personal-modules");
  const prior = process.env.FIGURE_LIBRARY_DIR;
  try {
    await ensureLibraryRootMarker(libraryRoot);
    await fs.mkdir(snapshotRoot, { recursive: true });
    await fs.writeFile(path.join(snapshotRoot, "module-catalog.json"), "{ not valid JSON\n");
    process.env.FIGURE_LIBRARY_DIR = libraryRoot;
    const manager = await emptyManager(root);
    const controller = await createRuntimeProviderController({
      manager,
      personalModuleRoot: snapshotRoot,
    });
    const descriptor = controller.registry.list().find(
      (item) => item.providerId === PERSONAL_MODULE_PROVIDER_ID,
    );
    assert.ok(descriptor);
    assert.equal(descriptor.kind, "module-catalog");
    assert.equal(descriptor.includeInDefaultSearch, true);
    assert.ok(controller.registry.defaultProviderIds().includes(PERSONAL_MODULE_PROVIDER_ID));

    const server = await createServer({
      registry: controller.registry,
      providerSourceManager: manager,
    });
    const client = new Client({ name: "personal-corrupt-snapshot-test", version: "0.6.1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const aggregate = await client.callTool({
        name: "figure_library_search",
        arguments: { query: "corrupt personal module fixture" },
      });
      const aggregateStructured = record(aggregate.structuredContent);
      const aggregateSource = (aggregateStructured.sources as Array<Record<string, unknown>>).find(
        (item) => item.providerId === PERSONAL_MODULE_PROVIDER_ID,
      );
      assert.equal(aggregateSource?.health, "corrupt");
      assert.equal(aggregateSource?.errorCode, "provider_snapshot_corrupt");
      assert.equal(
        (aggregateStructured.candidates as Array<Record<string, unknown>>).some(
          (item) => item.providerId === PERSONAL_MODULE_PROVIDER_ID,
        ),
        false,
      );
      assert.equal(record(aggregateStructured.envelope).outcome, "ok");

      const explicit = await client.callTool({
        name: "figure_library_search",
        arguments: {
          query: "corrupt personal module fixture",
          providerIds: [PERSONAL_MODULE_PROVIDER_ID],
        },
      });
      const explicitEnvelope = record(record(explicit.structuredContent).envelope);
      assert.equal(explicitEnvelope.outcome, "failed");
      assert.match(String(explicitEnvelope.summary), /provider_snapshot_corrupt/u);

      const status = await client.callTool({
        name: "figure_library_source_status",
        arguments: {},
      });
      const statusProviders = record(record(status.structuredContent).providers);
      assert.equal(record(statusProviders.personalModules).health, "corrupt");
      const statusById = record(statusProviders.byId);
      assert.equal(record(statusById[PERSONAL_MODULE_PROVIDER_ID]).health, "corrupt");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    if (prior === undefined) delete process.env.FIGURE_LIBRARY_DIR;
    else process.env.FIGURE_LIBRARY_DIR = prior;
    await fs.rm(root, { recursive: true, force: true });
  }
});
