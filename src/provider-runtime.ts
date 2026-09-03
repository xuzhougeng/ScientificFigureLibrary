import fs from "node:fs/promises";
import path from "node:path";
import { canonicalJson } from "./canonical-json.ts";
import {
  DefaultProviderRegistry,
  FigureYaProviderAdapter,
  LocalPublishedProviderAdapter,
  ModuleCatalogProviderAdapter,
  UnavailableProviderAdapter,
  type MutableProviderRegistry,
  type ProviderAdapter,
} from "./provider-registry.ts";
import { ProviderSourceManager } from "./provider-sources.ts";
import {
  COMMUNITY_PROVIDER_ID,
  PUBLIC_PREVIEW_MANIFEST_SCHEMA,
  PublicCatalogProviderAdapter,
  createPublicCatalogSnapshot,
  loadBundledCommunitySnapshot,
  parsePublicProviderCatalog,
} from "./public-catalog-provider.ts";
import {
  DEFAULT_PERSONAL_MODULE_ASSETS_DIR,
  ModuleCatalogIndex,
  PERSONAL_MODULE_REPOSITORY,
} from "./module-catalog.ts";
import { PERSONAL_MODULE_PROVIDER_ID } from "./providers.ts";

function safeProviderError(error: unknown) {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/[\r\n\t]+/gu, " ").slice(0, 500) || "verified snapshot is unavailable";
}

async function personalAdapter(
  manager: ProviderSourceManager,
  source: Awaited<ReturnType<ProviderSourceManager["listSources"]>>["sources"][number],
): Promise<ProviderAdapter> {
  try {
    const loaded = await manager.loadLastKnownGood(source.providerId);
    const catalog = parsePublicProviderCatalog(loaded.catalogBytes);
    const previewManifestBytes = Buffer.from(
      canonicalJson({
        schema: PUBLIC_PREVIEW_MANIFEST_SCHEMA,
        providerId: catalog.provider.providerId,
        entries: catalog.entries.map((entry) => ({
          templateId: entry.templateId,
          releaseVersion: entry.releaseVersion,
          ...entry.preview,
        })),
      }),
      "utf8",
    );
    const snapshot = await createPublicCatalogSnapshot({
      catalogBytes: loaded.catalogBytes,
      previewManifestBytes,
      loadPreview: async (relativePath) =>
        new Uint8Array(
          await fs.readFile(
            path.join(loaded.snapshotDirectory, "previews", ...relativePath.split("/")),
          ),
        ),
      expectedCatalogSha256: source.activeSnapshot.catalogSha256,
      revision: source.activeSnapshot.manifestSha256,
      trust: "signed-snapshot",
      sourceReference: `${source.manifestUrl}#sha256=${source.activeSnapshot.manifestSha256}`,
    });
    return new PublicCatalogProviderAdapter({
      snapshot,
      defaultSearchOrder: 100,
      bundled: false,
      enabled: source.enabled,
      includeInDefaultSearch: source.includeInDefaultSearch,
    });
  } catch (error) {
    return new UnavailableProviderAdapter({
      providerId: source.providerId,
      sourceLabel: source.providerId,
      enabled: source.enabled,
      includeInDefaultSearch: source.includeInDefaultSearch,
      errorCode: "provider_snapshot_corrupt",
      safeMessage: safeProviderError(error),
    });
  }
}

export interface RuntimeProviderController {
  registry: MutableProviderRegistry;
  manager: ProviderSourceManager;
  moduleCatalogs: ReadonlyMap<string, ModuleCatalogIndex>;
  refreshPersonalProviders(): Promise<void>;
}

export async function createRuntimeProviderController(options: {
  manager?: ProviderSourceManager;
  communityRoot?: string;
  personalModuleRoot?: string;
} = {}): Promise<RuntimeProviderController> {
  const manager = options.manager ?? new ProviderSourceManager();
  const communitySnapshot = await loadBundledCommunitySnapshot(options.communityRoot);
  let personalModuleAdapter: ProviderAdapter;
  const moduleCatalogs = new Map<string, ModuleCatalogIndex>();
  try {
    const personalModuleIndex = await ModuleCatalogIndex.load(
      options.personalModuleRoot ??
        process.env.PERSONAL_MODULE_ASSETS_DIR?.trim() ??
        DEFAULT_PERSONAL_MODULE_ASSETS_DIR,
      {
        expectedProviderId: PERSONAL_MODULE_PROVIDER_ID,
        expectedRepository: PERSONAL_MODULE_REPOSITORY,
        // A missing or corrupt individual preview must degrade only that
        // module's card/status. The Catalog and selector identities remain
        // usable, and exact preview still fails closed on access.
        validatePreviews: false,
      },
    );
    personalModuleAdapter = new ModuleCatalogProviderAdapter({ catalog: personalModuleIndex });
    moduleCatalogs.set(PERSONAL_MODULE_PROVIDER_ID, personalModuleIndex);
  } catch (error) {
    personalModuleAdapter = new UnavailableProviderAdapter({
      providerId: PERSONAL_MODULE_PROVIDER_ID,
      sourceLabel: "Open Figure Modules",
      defaultSearchOrder: 30,
      bundled: true,
      enabled: true,
      includeInDefaultSearch: true,
      kind: "module-catalog",
      safeMessage: safeProviderError(error),
    });
  }
  const registry = new DefaultProviderRegistry([
    new LocalPublishedProviderAdapter(),
    new PublicCatalogProviderAdapter({
      snapshot: communitySnapshot,
      defaultSearchOrder: 10,
      bundled: true,
      enabled: true,
      includeInDefaultSearch: false,
      frozen: true,
    }),
    new FigureYaProviderAdapter(),
    personalModuleAdapter,
  ]);
  let personalProviderIds = new Set<string>();

  const refreshPersonalProviders = async () => {
    const listed = await manager.listSources();
    const adapters = await Promise.all(
      [...listed.sources]
        .sort((left, right) => left.providerId.localeCompare(right.providerId, "en"))
        .map((source) => personalAdapter(manager, source)),
    );
    registry.replaceProviders(personalProviderIds, adapters);
    personalProviderIds = new Set(adapters.map((adapter) => adapter.descriptor.providerId));
    if (!registry.list().some((descriptor) => descriptor.providerId === COMMUNITY_PROVIDER_ID)) {
      throw new Error("runtime Provider registry lost the bundled Community Provider");
    }
  };

  await refreshPersonalProviders();
  return { registry, manager, moduleCatalogs, refreshPersonalProviders };
}
