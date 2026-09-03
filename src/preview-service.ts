import type { CatalogIndex } from "./catalog.ts";
import type { CurrentLibraryContext } from "./library-binding-tools.ts";
import {
  createDefaultProviderRegistry,
  createProviderContext,
  providerLibraryBindingDigest,
  providerSha256,
  type LoadedProviderPreview,
  type ProviderRegistry,
} from "./provider-registry.ts";
import type { ModuleCatalogIndex } from "./module-catalog.ts";
import { assertExactTemplateSelector } from "./providers.ts";
import type { ExactTemplateSelector } from "./types.ts";

export type { LoadedProviderPreview } from "./provider-registry.ts";
export const sha256 = providerSha256;
export const libraryBindingDigest = providerLibraryBindingDigest;

export async function searchCatalogRevision(
  context: CurrentLibraryContext,
  index: CatalogIndex,
  providerIds: string[],
  registry: ProviderRegistry = createDefaultProviderRegistry(),
  moduleCatalogs?: ReadonlyMap<string, ModuleCatalogIndex>,
) {
  return registry.catalogRevision(
    providerIds,
    createProviderContext(context, index, moduleCatalogs ? { moduleCatalogs } : {}),
  );
}

export async function loadProviderPreview(options: {
  context: CurrentLibraryContext;
  index: CatalogIndex;
  providerId: string;
  exactSelector: ExactTemplateSelector;
  registry?: ProviderRegistry;
  moduleCatalogs?: ReadonlyMap<string, ModuleCatalogIndex>;
  purpose?: "primary" | "search";
}): Promise<LoadedProviderPreview> {
  const { context, index, providerId, exactSelector } = options;
  const registry = options.registry ?? createDefaultProviderRegistry();
  assertExactTemplateSelector(exactSelector);
  if (exactSelector.providerId !== providerId) {
    throw new Error("providerId does not match exactSelector.providerId");
  }

  const providerContext = createProviderContext(
    context,
    index,
    options.moduleCatalogs ? { moduleCatalogs: options.moduleCatalogs } : {},
  );
  const adapter = registry.get(providerId);
  const resolved = await adapter.resolve(providerContext, exactSelector, "preview");
  if (options.purpose === "search" && adapter.loadSearchPreview) {
    return adapter.loadSearchPreview(providerContext, resolved);
  }
  return adapter.loadPreview(providerContext, resolved);
}
