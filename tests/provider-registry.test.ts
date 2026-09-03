import assert from "node:assert/strict";
import test from "node:test";
import {
  DefaultProviderRegistry,
  FigureYaProviderAdapter,
  LocalPublishedProviderAdapter,
  ModuleCatalogProviderAdapter,
  createDefaultProviderRegistry,
} from "../src/provider-registry.ts";
import {
  FIGUREYA_PROVIDER_ID,
  LOCAL_LIBRARY_PROVIDER_ID,
  PERSONAL_MODULE_PROVIDER_ID,
} from "../src/providers.ts";

test("default ProviderRegistry has the compatibility order and dynamic defaults", () => {
  const registry = createDefaultProviderRegistry();
  assert.deepEqual(
    registry.list().map(({ providerId }) => providerId),
    [LOCAL_LIBRARY_PROVIDER_ID, FIGUREYA_PROVIDER_ID, PERSONAL_MODULE_PROVIDER_ID],
  );
  assert.deepEqual(registry.defaultProviderIds(), [
    LOCAL_LIBRARY_PROVIDER_ID,
    FIGUREYA_PROVIDER_ID,
    PERSONAL_MODULE_PROVIDER_ID,
  ]);
  assert.ok(registry.get(LOCAL_LIBRARY_PROVIDER_ID) instanceof LocalPublishedProviderAdapter);
  assert.ok(registry.get(FIGUREYA_PROVIDER_ID) instanceof FigureYaProviderAdapter);
  assert.ok(registry.get(PERSONAL_MODULE_PROVIDER_ID) instanceof ModuleCatalogProviderAdapter);
});

test("ProviderRegistry fails closed for unknown and duplicate provider identifiers", () => {
  const registry = createDefaultProviderRegistry();
  assert.throws(
    () => registry.get("io.github.example.unknown"),
    /unsupported provider: io\.github\.example\.unknown/u,
  );
  assert.throws(
    () =>
      new DefaultProviderRegistry([
        new LocalPublishedProviderAdapter(),
        new LocalPublishedProviderAdapter(),
      ]),
    /duplicate providerId: org\.scientificfigurelibrary\.local/u,
  );
});
