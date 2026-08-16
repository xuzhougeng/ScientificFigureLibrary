import { createHash } from "node:crypto";
import path from "node:path";
import type { CatalogIndex } from "./catalog.ts";
import { canonicalJson } from "./canonical-json.ts";
import type { CurrentLibraryContext } from "./library-binding-tools.ts";
import {
  FIGUREYA_PROVIDER_ID,
  LOCAL_LIBRARY_PROVIDER_ID,
  assertExactTemplateSelector,
  assertLocalPublishedExactSelector,
  exactSelectorDigest,
} from "./providers.ts";
import type { ExactTemplateSelector } from "./types.ts";

const DISPLAY_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

export interface LoadedProviderPreview {
  providerId: string;
  exactSelector: ExactTemplateSelector;
  exactSelectorDigest: string;
  templateId: string;
  bytes: Uint8Array;
  byteLength: number;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  extension: string;
  sha256: string;
}

export function sha256(value: Uint8Array | string) {
  return createHash("sha256").update(value).digest("hex");
}

export function libraryBindingDigest(context: CurrentLibraryContext) {
  return sha256(
    canonicalJson({
      schema: "figure-library.preview-library-binding.v1",
      root: path.resolve(context.snapshot.root),
      contextKey: context.snapshot.contextKey,
      libraryId: context.snapshot.libraryId ?? null,
      configRevision: context.snapshot.configRevision,
      markerDigest: context.snapshot.markerDigest ?? null,
    }),
  );
}

export async function searchCatalogRevision(
  context: CurrentLibraryContext,
  index: CatalogIndex,
  providerIds: string[],
) {
  const local = providerIds.includes(LOCAL_LIBRARY_PROVIDER_ID)
    ? (await context.versionedLibrary.listPublishedCandidates())
        .map((item) => ({
          templateId: item.templateId,
          revisionId: item.revisionId,
          contentDigest: item.contentDigest,
          releaseId: item.releaseId,
        }))
        .sort((left, right) => left.templateId.localeCompare(right.templateId))
    : [];
  return sha256(
    canonicalJson({
      schema: "figure-library.search-catalog-revision.v1",
      providers: [...providerIds].sort(),
      libraryBinding: libraryBindingDigest(context),
      local,
      figureYa: providerIds.includes(FIGUREYA_PROVIDER_ID)
        ? index.catalog
        : null,
    }),
  );
}

export async function loadProviderPreview(options: {
  context: CurrentLibraryContext;
  index: CatalogIndex;
  providerId: string;
  exactSelector: ExactTemplateSelector;
}): Promise<LoadedProviderPreview> {
  const { context, index, providerId, exactSelector } = options;
  assertExactTemplateSelector(exactSelector);
  if (exactSelector.providerId !== providerId) {
    throw new Error("providerId does not match exactSelector.providerId");
  }

  let loaded:
    | { bytes: Uint8Array; mimeType: string; extension: string; templateId: string }
    | undefined;
  if (providerId === LOCAL_LIBRARY_PROVIDER_ID) {
    assertLocalPublishedExactSelector(exactSelector);
    const { templateId, revisionId, contentDigest, releaseId } = exactSelector.identity;
    const release = await context.versionedLibrary.getRelease(templateId, releaseId);
    if (
      !release ||
      release.revisionId !== revisionId ||
      release.contentDigest !== contentDigest
    ) {
      throw new Error("preview_stale: Local Published release changed");
    }
    const preview = await context.versionedLibrary.getPreview(templateId, {
      revisionId,
      contentDigest,
    });
    if (preview) loaded = { ...preview, templateId };
  } else if (providerId === FIGUREYA_PROVIDER_ID) {
    const moduleId = exactSelector.identity.moduleId;
    if (
      typeof moduleId !== "string" ||
      exactSelector.identity.sourceCommit !== index.catalog.figureya.commit
    ) {
      throw new Error("preview_stale: FigureYa selector changed");
    }
    const preview = await index.preview(exactSelector);
    if (preview) loaded = { ...preview, templateId: moduleId };
  } else {
    throw new Error(`unsupported preview provider: ${providerId}`);
  }

  if (!loaded) throw new Error("preview_unavailable: no preview is available");
  if (!DISPLAY_MIME_TYPES.has(loaded.mimeType)) {
    throw new Error(`preview_unavailable: unsupported preview MIME ${loaded.mimeType}`);
  }
  const digest = sha256(loaded.bytes);
  return {
    providerId,
    exactSelector,
    exactSelectorDigest: exactSelectorDigest(exactSelector),
    templateId: loaded.templateId,
    bytes: loaded.bytes,
    byteLength: loaded.bytes.byteLength,
    mimeType: loaded.mimeType as LoadedProviderPreview["mimeType"],
    extension: loaded.extension,
    sha256: digest,
  };
}
