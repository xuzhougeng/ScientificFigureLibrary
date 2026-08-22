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
) {
  return registry.catalogRevision(providerIds, createProviderContext(context, index));
}

export async function loadProviderPreview(options: {
  context: CurrentLibraryContext;
  index: CatalogIndex;
  providerId: string;
  exactSelector: ExactTemplateSelector;
  registry?: ProviderRegistry;
}): Promise<LoadedProviderPreview> {
  const { context, index, providerId, exactSelector } = options;
  const registry = options.registry ?? createDefaultProviderRegistry();
  assertExactTemplateSelector(exactSelector);
  if (exactSelector.providerId !== providerId) {
    throw new Error("providerId does not match exactSelector.providerId");
  }

  const providerContext = createProviderContext(context, index);
  const adapter = registry.get(providerId);
  const resolved = await adapter.resolve(providerContext, exactSelector, "preview");
  return adapter.loadPreview(providerContext, resolved);
}
