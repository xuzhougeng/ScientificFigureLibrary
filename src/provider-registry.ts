import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { CatalogIndex } from "./catalog.ts";
import { ModuleCatalogIndex } from "./module-catalog.ts";
import {
  buildSearchIntent,
  normalizeSearchText,
  scoreSearchableTemplate,
} from "./catalog.ts";
import { canonicalJson } from "./canonical-json.ts";
import type { CurrentLibraryContext } from "./library-binding-tools.ts";
import {
  inspectFigureYaSourcePack,
  materializeFigureYaTemplate,
} from "./materialize.ts";
import {
  inspectModuleSourcePack,
  materializeModuleTemplate,
  parseModuleTemplateLock,
} from "./module-materialize.ts";
import {
  FIGUREYA_PROVIDER_ID,
  LOCAL_LIBRARY_PROVIDER_ID,
  PERSONAL_MODULE_PROVIDER_ID,
  assertExactTemplateSelector,
  assertFigureYaExactSelector,
  assertFigureYaSelectorMatches,
  assertFigureYaSourceSelectorMatches,
  assertLocalPublishedExactSelector,
  assertModuleArchiveExactSelector,
  assertModuleArchiveSelectorMatches,
  exactSelectorDigest,
  localPublishedExactSelector,
} from "./providers.ts";
import type {
  ExactTemplateSelector,
  FigureYaExactSelector,
  FigureYaModule,
  ModuleArchiveExactSelector,
  ModuleCatalogEntry,
  SearchRequest,
  TemplateCandidate,
} from "./types.ts";
import {
  effectiveValidationState,
  legacyValidationStateFromExecutionStatus,
  type PublishedVersionedTemplateCandidate,
  type ReviewSnapshotV1,
  type TemplateContentV1,
  type TemplateReleaseV1,
} from "./versioned-library.ts";

export interface ProviderDescriptor {
  providerId: string;
  sourceLabel: string;
  kind: "local-published" | "figureya" | "module-catalog" | "public-catalog";
  defaultSearchOrder: number;
  bundled: boolean;
  enabled?: boolean;
  includeInDefaultSearch?: boolean;
  frozen?: boolean;
}

export interface ProviderContext {
  library: CurrentLibraryContext;
  catalog: CatalogIndex;
  moduleCatalogs?: ReadonlyMap<string, ModuleCatalogIndex>;
  sourcePackDir?: string;
  moduleSourcePackDir?: string;
  materialization?: {
    operationId: string;
    planDigest: string;
    sourcePackDir?: string;
  };
}

export interface ResolvedProviderTemplate {
  providerId: string;
  exactSelector: ExactTemplateSelector;
  templateId: string;
  value:
    | {
        kind: "local-published";
        content: TemplateContentV1;
        release: TemplateReleaseV1;
        review: ReviewSnapshotV1;
      }
    | { kind: "figureya"; module: FigureYaModule }
    | { kind: "module-catalog"; module: ModuleCatalogEntry; catalog: ModuleCatalogIndex }
    | {
      kind: "public-catalog";
        entry: unknown;
        catalogSha256: string;
      };
}

export interface ProviderDescription {
  code:
    | "local_published_described"
    | "figureya_module_described"
    | "module_catalog_described"
    | "public_template_described";
  summary: string;
  detail: Record<string, unknown>;
  lines: string[];
}

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

export interface VerifiedProviderPayload {
  providerId: string;
  exactSelector: ExactTemplateSelector;
  target: string;
  files: string[];
  materializationSource: string;
  archiveSha256?: string;
}

export interface ProviderMaterializedBinding {
  plannedSelector: ExactTemplateSelector;
  exactSelector: ExactTemplateSelector;
  target: string;
  operationId: string;
  planDigest: string;
  inventory: Array<{ file: string; bytes: number; sha256: string }>;
}

export interface ProviderStatus {
  providerId: string;
  sourceLabel: string;
  health: "ready" | "degraded" | "corrupt";
  details: Record<string, unknown>;
}

export interface ProviderAdapter {
  descriptor: ProviderDescriptor;
  assertSelector(
    selector: ExactTemplateSelector,
    purpose: "describe" | "preview" | "materialize" | "replay",
  ): void;
  revision(context: ProviderContext): Promise<unknown>;
  search(context: ProviderContext, request: SearchRequest): Promise<TemplateCandidate[]>;
  resolve(
    context: ProviderContext,
    selector: ExactTemplateSelector,
    purpose: "describe" | "preview" | "materialize" | "replay",
  ): Promise<ResolvedProviderTemplate>;
  describe(
    context: ProviderContext,
    resolved: ResolvedProviderTemplate,
  ): Promise<ProviderDescription>;
  loadPreview(
    context: ProviderContext,
    resolved: ResolvedProviderTemplate,
  ): Promise<LoadedProviderPreview>;
  /** Optional lower-cost preview used only for search cards. */
  loadSearchPreview?(
    context: ProviderContext,
    resolved: ResolvedProviderTemplate,
  ): Promise<LoadedProviderPreview>;
  stageMaterialization(
    context: ProviderContext,
    resolved: ResolvedProviderTemplate,
    stagingDirectory: string,
    allowNetwork: boolean,
  ): Promise<VerifiedProviderPayload>;
  verifyMaterialized(
    context: ProviderContext,
    binding: ProviderMaterializedBinding,
  ): Promise<void>;
  status(context: ProviderContext): Promise<ProviderStatus>;
}

export interface ProviderRegistry {
  list(): ProviderDescriptor[];
  get(providerId: string): ProviderAdapter;
  defaultProviderIds(): string[];
  catalogRevision(providerIds: string[], context: ProviderContext): Promise<string>;
  status(context: ProviderContext): Promise<ProviderStatus[]>;
}

export interface MutableProviderRegistry extends ProviderRegistry {
  replaceProviders(providerIdsToRemove: Iterable<string>, adapters: ProviderAdapter[]): void;
}

const DISPLAY_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

export function providerSha256(value: Uint8Array | string) {
  return createHash("sha256").update(value).digest("hex");
}

export function providerLibraryBindingDigest(context: CurrentLibraryContext) {
  return providerSha256(
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

function sameNativePath(left: string, right: string) {
  const normalize = (value: string) => {
    const resolved = path.resolve(value).normalize("NFC");
    return process.platform === "win32" ? resolved.toLocaleLowerCase("en-US") : resolved;
  };
  return normalize(left) === normalize(right);
}

function localIdentity(selector: ExactTemplateSelector) {
  assertLocalPublishedExactSelector(selector);
  return selector.identity;
}

async function releaseBoundReview(
  context: CurrentLibraryContext,
  release: TemplateReleaseV1,
) {
  const review = await context.versionedLibrary.getReview(release.templateId, release.reviewId);
  if (
    !review ||
    review.revisionId !== release.revisionId ||
    review.reviewDigest !== release.reviewDigest
  ) {
    throw new Error(
      `Published release does not match its immutable Review: ${release.templateId}/${release.releaseId}`,
    );
  }
  return review;
}

async function resolveLocalPublished(
  context: CurrentLibraryContext,
  selector: ExactTemplateSelector,
) {
  const identity = localIdentity(selector);
  const [content, release, history] = await Promise.all([
    context.versionedLibrary.getContent(
      identity.templateId,
      identity.revisionId,
      identity.contentDigest,
    ),
    context.versionedLibrary.getRelease(identity.templateId, identity.releaseId),
    context.versionedLibrary.history(identity.templateId),
  ]);
  if (
    !content ||
    !release ||
    release.revisionId !== identity.revisionId ||
    release.contentDigest !== identity.contentDigest ||
    !history.releases.some(
      (item) =>
        item.releaseId === identity.releaseId &&
        item.revisionId === identity.revisionId &&
        item.contentDigest === identity.contentDigest,
    )
  ) {
    throw new Error("stale or unreachable Local Published exact selector");
  }
  return { identity, content, release, review: await releaseBoundReview(context, release) };
}

function matchesLocalFilters(
  item: PublishedVersionedTemplateCandidate,
  request: SearchRequest,
) {
  if (request.assetKind && item.assetKind !== request.assetKind) return false;
  if (request.reviewStatus && request.reviewStatus !== "approved") return false;
  if (request.codeStatus && item.codeStatus !== request.codeStatus) return false;
  if (
    request.language &&
    normalizeSearchText(request.language) !== normalizeSearchText(item.language)
  ) {
    return false;
  }
  if (request.plotFamily) {
    const desired = buildSearchIntent({ query: request.plotFamily }).families;
    const actual = buildSearchIntent({ query: item.plotFamily }).families;
    if (
      desired.length
        ? !desired.some((value) => actual.includes(value))
        : !normalizeSearchText(item.plotFamily).includes(normalizeSearchText(request.plotFamily))
    ) {
      return false;
    }
  }
  return true;
}

export class LocalPublishedProviderAdapter implements ProviderAdapter {
  readonly descriptor: ProviderDescriptor = {
    providerId: LOCAL_LIBRARY_PROVIDER_ID,
    sourceLabel: "Local Published",
    kind: "local-published",
    defaultSearchOrder: 0,
    bundled: false,
  };

  assertSelector(
    selector: ExactTemplateSelector,
    _purpose?: "describe" | "preview" | "materialize" | "replay",
  ) {
    assertLocalPublishedExactSelector(selector);
  }

  async revision(context: ProviderContext) {
    return (await context.library.versionedLibrary.listPublishedCandidates())
      .map((item) => ({
        templateId: item.templateId,
        revisionId: item.revisionId,
        contentDigest: item.contentDigest,
        releaseId: item.releaseId,
      }))
      .sort((left, right) => left.templateId.localeCompare(right.templateId));
  }

  async search(context: ProviderContext, request: SearchRequest) {
    const intent = buildSearchIntent(request);
    const scored = (await context.library.versionedLibrary.listPublishedCandidates())
      .filter((item) => matchesLocalFilters(item, request))
      .map((item) => ({
        item,
        evidence: scoreSearchableTemplate(
          {
            templateId: item.templateId,
            title: item.title,
            description: item.description,
            scientificQuestion: item.scientificQuestion,
            application: item.visualProfile,
            dataProfile: item.dataProfile,
            inputFiles: [],
            codeFiles: [],
            packages: item.packages,
            tags: item.tags,
          },
          intent,
        ),
      }))
      .filter(({ evidence }) => evidence.score > 0)
      .sort(
        (left, right) =>
          right.evidence.score - left.evidence.score ||
          left.item.templateId.localeCompare(right.item.templateId),
      );

    return Promise.all(
      scored.map(async ({ item, evidence }): Promise<TemplateCandidate> => {
        const selector = localPublishedExactSelector({
          templateId: item.templateId,
          revisionId: item.revisionId,
          contentDigest: item.contentDigest,
          releaseId: item.releaseId,
        });
        const resolved = await this.resolve(context, selector, "describe");
        if (resolved.value.kind !== "local-published") throw new Error("invalid Local resolution");
        const { content, review } = resolved.value;
        return {
          templateId: item.templateId,
          providerId: this.descriptor.providerId,
          exactSelector: selector,
          sourceLabel: this.descriptor.sourceLabel,
          title: item.title,
          retrievalScore: evidence.score,
          matchedTerms: evidence.matchedTerms.slice(0, 12),
          reasons: evidence.reasons,
          warnings: [...new Set(review.warnings.map((warning) => warning.message))],
          excerpt: item.description.slice(0, 420),
          description: item.description,
          ...(item.scientificQuestion ? { scientificQuestion: item.scientificQuestion } : {}),
          application: item.visualProfile,
          dataProfile: item.dataProfile,
          inputFiles: content.assets
            .filter((asset) => asset.role === "reference")
            .map((asset) => asset.logicalPath),
          codeFiles: content.assets
            .filter((asset) => asset.role === "code")
            .map((asset) => asset.logicalPath),
          packages: item.packages,
          materializable: true,
          previewAvailable: item.previewAvailable,
          ...(item.previewAvailable
            ? {
                previewRef: {
                  schema: "figure-library.provider-preview-ref.v1",
                  providerId: this.descriptor.providerId,
                  exactSelector: selector,
                },
              }
            : {}),
          assetKind: item.assetKind,
          language: item.language,
          plotFamily: item.plotFamily,
          reviewStatus: "approved",
          codeStatus: item.codeStatus,
          executionStatus: item.executionStatus,
          validationState: effectiveValidationState(content),
          ...(content.canonicalPreviewDecision
            ? { canonicalPreviewDecision: content.canonicalPreviewDecision }
            : {}),
          upstreamStatus: "published",
          license: item.license,
          management: {
            templateId: item.templateId,
            canArchive: false,
            canUpdate: true,
            updateVia: "plan-apply",
          },
        };
      }),
    );
  }

  async resolve(
    context: ProviderContext,
    selector: ExactTemplateSelector,
    _purpose: "describe" | "preview" | "materialize" | "replay",
  ): Promise<ResolvedProviderTemplate> {
    this.assertSelector(selector, _purpose);
    const resolved = await resolveLocalPublished(context.library, selector);
    return {
      providerId: this.descriptor.providerId,
      exactSelector: selector,
      templateId: resolved.identity.templateId,
      value: {
        kind: "local-published",
        content: resolved.content,
        release: resolved.release,
        review: resolved.review,
      },
    };
  }

  async describe(_context: ProviderContext, resolved: ResolvedProviderTemplate) {
    if (resolved.value.kind !== "local-published") throw new Error("invalid Local resolution");
    const { content, release, review } = resolved.value;
    const validationState = effectiveValidationState(content);
    return {
      code: "local_published_described" as const,
      summary: `Loaded exact Local Published release ${release.releaseId}.`,
      detail: {
        content,
        release,
        review,
        validationState,
        ...(content.canonicalPreviewDecision
          ? { canonicalPreviewDecision: content.canonicalPreviewDecision }
          : {}),
      },
      lines: [
        `TITLE: ${content.title}`,
        `ASSET_KIND: ${content.assetKind}`,
        `LANGUAGE: ${content.language}`,
        `CODE_STATUS: ${content.codeStatus}`,
        `PLOT_EXECUTION_STATUS: ${validationState.plotExecution.status}`,
        `PLOT_EXECUTION_SCOPE: ${validationState.plotExecution.scope}`,
        `UPSTREAM_WORKFLOW_STATUS: ${validationState.upstreamWorkflow.status}`,
        `UPSTREAM_WORKFLOW_SCOPE: ${validationState.upstreamWorkflow.scope ?? "unspecified"}`,
        `SCIENTIFIC_VALIDATION_STATUS: ${validationState.scientificValidation.status}`,
        `SCIENTIFIC_VALIDATION_SOURCE: ${validationState.scientificValidation.decisionSource ?? "unspecified"}`,
        `CANONICAL_PREVIEW_DECISION: ${
          content.canonicalPreviewDecision
            ? JSON.stringify(content.canonicalPreviewDecision)
            : "legacy_unspecified"
        }`,
        `REVIEW_WARNINGS: ${
          review.warnings.map((warning) => warning.message).join("; ") || "none"
        }`,
        `ASSETS: ${content.assets.map((asset) => `${asset.logicalPath}:${asset.sha256}`).join(", ")}`,
      ],
    };
  }

  async loadPreview(context: ProviderContext, resolved: ResolvedProviderTemplate) {
    if (resolved.value.kind !== "local-published") throw new Error("invalid Local resolution");
    const identity = localIdentity(resolved.exactSelector);
    const loaded = await context.library.versionedLibrary.getPreview(identity.templateId, {
      revisionId: identity.revisionId,
      contentDigest: identity.contentDigest,
    });
    return completePreview(this.descriptor.providerId, resolved, loaded);
  }

  async stageMaterialization(
    context: ProviderContext,
    resolved: ResolvedProviderTemplate,
    stagingDirectory: string,
    _allowNetwork: boolean,
  ) {
    const operation = context.materialization;
    if (!operation) throw new Error("materialization operation binding is required");
    const identity = localIdentity(resolved.exactSelector);
    const applied = await context.library.versionedLibrary.materializeRevision({
      ...identity,
      destination: stagingDirectory,
      operationId: operation.operationId,
      planDigest: operation.planDigest,
    });
    return {
      providerId: this.descriptor.providerId,
      exactSelector: resolved.exactSelector,
      target: applied.target,
      files: applied.files,
      materializationSource: applied.materializationSource,
    };
  }

  async verifyMaterialized(context: ProviderContext, binding: ProviderMaterializedBinding) {
    const identity = localIdentity(binding.plannedSelector);
    if (canonicalJson(binding.plannedSelector) !== canonicalJson(binding.exactSelector)) {
      throw new Error("stale Local Published exact selector changed during materialization");
    }
    if (!sameNativePath(binding.target, path.join(path.dirname(binding.target), identity.templateId))) {
      throw new Error("stale Local Published materialization target name");
    }
    const currentPlan = await context.library.versionedLibrary.planMaterializeRevision({
      ...identity,
      destination: path.dirname(binding.target),
      operationId: binding.operationId,
      planDigest: binding.planDigest,
    });
    const expectedInventory = currentPlan.fileInventory.map(({ relativePath, ...entry }) => ({
      file: relativePath,
      ...entry,
    }));
    if (canonicalJson(expectedInventory) !== canonicalJson(binding.inventory)) {
      throw new Error("target already exists but no longer matches its reachable Local Published Release");
    }
  }

  async status(context: ProviderContext) {
    const library = await context.library.versionedLibrary.status();
    return {
      providerId: this.descriptor.providerId,
      sourceLabel: this.descriptor.sourceLabel,
      health: library.readable ? ("ready" as const) : ("degraded" as const),
      details: {
        providerId: this.descriptor.providerId,
        publishedCount: library.publishedCount,
        workingCount: library.workingCount,
        ordinarySearchScope: "Published only",
      },
    };
  }
}

export class FigureYaProviderAdapter implements ProviderAdapter {
  readonly descriptor: ProviderDescriptor = {
    providerId: FIGUREYA_PROVIDER_ID,
    sourceLabel: "FigureYa",
    kind: "figureya",
    defaultSearchOrder: 20,
    bundled: true,
  };

  assertSelector(
    selector: ExactTemplateSelector,
    purpose: "describe" | "preview" | "materialize" | "replay",
  ) {
    assertExactTemplateSelector(selector);
    if (selector.providerId !== this.descriptor.providerId) {
      throw new Error("providerId does not match exactSelector.providerId");
    }
    if (selector.kind === "figureya-module.v1") {
      assertFigureYaExactSelector(selector);
      return;
    }
    if (selector.kind === "figureya-source-module.v1") {
      if (purpose === "materialize" || purpose === "replay") {
        throw new Error("FigureYa source-only selector is not materializable");
      }
      return;
    }
    throw new Error(`unsupported FigureYa selector kind: ${selector.kind}`);
  }

  async revision(context: ProviderContext) {
    return context.catalog.catalog;
  }

  async search(context: ProviderContext, request: SearchRequest) {
    return (await context.catalog.searchAll(request)).map((candidate) => ({
      ...candidate,
      validationState: legacyValidationStateFromExecutionStatus("not_run"),
    }));
  }

  async resolve(
    context: ProviderContext,
    selector: ExactTemplateSelector,
    purpose: "describe" | "preview" | "materialize" | "replay",
  ): Promise<ResolvedProviderTemplate> {
    this.assertSelector(selector, purpose);
    const moduleId = selector.identity.moduleId;
    if (
      typeof moduleId !== "string" ||
      selector.identity.sourceCommit !== context.catalog.catalog.figureya.commit
    ) {
      throw new Error("stale or invalid FigureYa source selector");
    }
    const module = context.catalog.get(moduleId);
    if (!module) throw new Error(`unknown FigureYa module: ${moduleId}`);
    if (selector.kind === "figureya-module.v1") {
      assertFigureYaExactSelector(selector);
      assertFigureYaSelectorMatches(
        selector,
        context.catalog.catalog,
        module,
        selector.identity.mode,
      );
    } else if (selector.kind === "figureya-source-module.v1") {
      assertFigureYaSourceSelectorMatches(selector, context.catalog.catalog, module);
    } else {
      throw new Error(`unsupported FigureYa selector kind: ${selector.kind}`);
    }
    return {
      providerId: this.descriptor.providerId,
      exactSelector: selector,
      templateId: module.moduleId,
      value: { kind: "figureya", module },
    };
  }

  async describe(context: ProviderContext, resolved: ResolvedProviderTemplate) {
    if (resolved.value.kind !== "figureya") throw new Error("invalid FigureYa resolution");
    const { module } = resolved.value;
    const validationState = legacyValidationStateFromExecutionStatus("not_run");
    return {
      code: "figureya_module_described" as const,
      summary: `Loaded commit-pinned FigureYa metadata for ${module.moduleId}.`,
      detail: {
        templateId: module.moduleId,
        title: module.title,
        description: module.requirement,
        application: module.application,
        dataProfile: module.inputSummary,
        inputFiles: module.inputFiles,
        codeFiles: module.codeFiles,
        packages: module.packages,
        materializable: module.archiveAvailable,
        previewAvailable: await context.catalog.previewAvailable(module),
        reviewStatus: "not_reviewed",
        codeStatus: module.codeFiles.length ? "provided" : "none",
        executionStatus: "not_run",
        validationState,
        upstreamStatus: "published",
        sourceUrl: module.sourceUrl,
        reportUrl: module.reportUrl,
        citation: context.catalog.catalog.citation,
      },
      lines: [
        `TITLE: ${module.title}`,
        "LOCAL_REVIEW_STATUS: not_reviewed",
        `CODE_STATUS: ${module.codeFiles.length ? "provided" : "none"}`,
        `PLOT_EXECUTION_STATUS: ${validationState.plotExecution.status}`,
        `PLOT_EXECUTION_SCOPE: ${validationState.plotExecution.scope}`,
        `UPSTREAM_WORKFLOW_STATUS: ${validationState.upstreamWorkflow.status}`,
        `UPSTREAM_WORKFLOW_SCOPE: ${validationState.upstreamWorkflow.scope ?? "unspecified"}`,
        `SCIENTIFIC_VALIDATION_STATUS: ${validationState.scientificValidation.status}`,
        `SCIENTIFIC_VALIDATION_SOURCE: ${validationState.scientificValidation.decisionSource ?? "unspecified"}`,
        `INPUT_FILES: ${module.inputFiles.join(", ") || "none identified"}`,
        `CODE_FILES: ${module.codeFiles.join(", ") || "none identified"}`,
      ],
    };
  }

  async loadPreview(context: ProviderContext, resolved: ResolvedProviderTemplate) {
    const loaded = await context.catalog.preview(resolved.exactSelector);
    return completePreview(this.descriptor.providerId, resolved, loaded);
  }

  async stageMaterialization(
    context: ProviderContext,
    resolved: ResolvedProviderTemplate,
    stagingDirectory: string,
    allowNetwork: boolean,
  ) {
    const operation = context.materialization;
    if (!operation) throw new Error("materialization operation binding is required");
    if (resolved.value.kind !== "figureya") throw new Error("invalid FigureYa resolution");
    assertFigureYaExactSelector(resolved.exactSelector);
    const applied = await materializeFigureYaTemplate({
      catalog: context.catalog.catalog,
      module: resolved.value.module,
      destination: stagingDirectory,
      mode: resolved.exactSelector.identity.mode,
      exactSelector: resolved.exactSelector,
      sourcePackDir: operation.sourcePackDir,
      allowNetwork,
      operationId: operation.operationId,
      planDigest: operation.planDigest,
    });
    return {
      providerId: this.descriptor.providerId,
      exactSelector: applied.exactSelector,
      target: applied.target,
      files: applied.files,
      materializationSource: applied.archiveSource,
      archiveSha256: applied.sha256,
    };
  }

  async verifyMaterialized(context: ProviderContext, binding: ProviderMaterializedBinding) {
    assertFigureYaExactSelector(binding.plannedSelector);
    assertFigureYaExactSelector(binding.exactSelector);
    const resolved = await this.resolve(context, binding.plannedSelector, "replay");
    if (resolved.value.kind !== "figureya") throw new Error("invalid FigureYa resolution");
    const left = binding.plannedSelector.identity;
    const right = binding.exactSelector.identity;
    if (
      left.moduleId !== right.moduleId ||
      left.sourceCommit !== right.sourceCommit ||
      left.archiveCommit !== right.archiveCommit ||
      left.mode !== right.mode ||
      left.archive.bytes !== right.archive.bytes
    ) {
      throw new Error("stale FigureYa resolved selector does not match its planned selector");
    }
    if (left.archive.algorithm === "sha256") {
      if (canonicalJson(binding.plannedSelector) !== canonicalJson(binding.exactSelector)) {
        throw new Error("stale FigureYa SHA-256 selector changed during materialization");
      }
    } else if (right.archive.algorithm !== "sha256") {
      throw new Error("stale legacy FigureYa selector was not resolved to SHA-256");
    }
    if (
      !sameNativePath(
        binding.target,
        path.join(path.dirname(binding.target), resolved.value.module.moduleId),
      )
    ) {
      throw new Error("stale FigureYa materialization target name");
    }
  }

  async status(context: ProviderContext) {
    const sourcePack = await inspectFigureYaSourcePack(
      context.catalog.catalog,
      context.sourcePackDir,
    );
    return {
      providerId: this.descriptor.providerId,
      sourceLabel: this.descriptor.sourceLabel,
      health: sourcePack.invalidTemplates.length ? ("degraded" as const) : ("ready" as const),
      details: {
        providerId: this.descriptor.providerId,
        catalogTemplates: context.catalog.catalog.modules.length,
        sourceCommit: context.catalog.catalog.figureya.commit,
        archiveCommit: context.catalog.catalog.compressed.commit,
        sourcePack,
      },
    };
  }
}

function moduleCatalogFor(
  context: ProviderContext,
  providerId: string,
  fallback?: ModuleCatalogIndex,
) {
  const index = context.moduleCatalogs?.get(providerId) ?? fallback;
  if (!index) throw new Error(`module Catalog is unavailable for ${providerId}`);
  if (index.catalog.provider.providerId !== providerId) {
    throw new Error(`module Catalog providerId mismatch for ${providerId}`);
  }
  return index;
}

export class ModuleCatalogProviderAdapter implements ProviderAdapter {
  readonly descriptor: ProviderDescriptor;
  readonly moduleCatalog: ModuleCatalogIndex;

  constructor(options: {
    providerId?: string;
    sourceLabel?: string;
    defaultSearchOrder?: number;
    bundled?: boolean;
    enabled?: boolean;
    includeInDefaultSearch?: boolean;
    catalog?: ModuleCatalogIndex;
  } = {}) {
    const catalog = options.catalog ?? ModuleCatalogIndex.empty({
      providerId: options.providerId ?? PERSONAL_MODULE_PROVIDER_ID,
      displayName: options.sourceLabel ?? "Open Figure Modules",
    });
    this.descriptor = {
      providerId: options.providerId ?? catalog.catalog.provider.providerId,
      sourceLabel: options.sourceLabel ?? catalog.catalog.provider.displayName,
      kind: "module-catalog",
      defaultSearchOrder: options.defaultSearchOrder ?? 30,
      bundled: options.bundled ?? true,
      enabled: options.enabled ?? true,
      includeInDefaultSearch: options.includeInDefaultSearch ?? true,
    };
    if (catalog.catalog.provider.providerId !== this.descriptor.providerId) {
      throw new Error("module Catalog providerId differs from the Provider descriptor");
    }
    this.moduleCatalog = catalog;
  }

  assertSelector(
    selector: ExactTemplateSelector,
    _purpose: "describe" | "preview" | "materialize" | "replay",
  ) {
    assertModuleArchiveExactSelector(selector);
    if (selector.providerId !== this.descriptor.providerId) {
      throw new Error("module selector providerId differs from this Provider");
    }
  }

  async revision(context: ProviderContext) {
    const index = moduleCatalogFor(context, this.descriptor.providerId, this.moduleCatalog);
    return {
      providerId: this.descriptor.providerId,
      catalogSha256: index.catalogSha256,
      modules: index.catalog.modules.map((module) => ({
        moduleId: module.moduleId,
        sourceCommit: module.source.commit,
        archiveCommit: module.archive.commit,
        archiveSha256: module.archive.sha256,
        previewSha256: module.preview.sha256,
      })),
    };
  }

  async search(context: ProviderContext, request: SearchRequest) {
    const index = moduleCatalogFor(context, this.descriptor.providerId, this.moduleCatalog);
    return (await index.searchAll(request)).map((candidate) => ({
      ...candidate,
      validationState: legacyValidationStateFromExecutionStatus("not_run"),
    }));
  }

  async resolve(
    context: ProviderContext,
    selector: ExactTemplateSelector,
    purpose: "describe" | "preview" | "materialize" | "replay",
  ): Promise<ResolvedProviderTemplate> {
    this.assertSelector(selector, purpose);
    assertModuleArchiveExactSelector(selector);
    const index = moduleCatalogFor(context, this.descriptor.providerId, this.moduleCatalog);
    const module = index.get(selector.identity.moduleId);
    if (!module) throw new Error(`unknown personal module: ${selector.identity.moduleId}`);
    assertModuleArchiveSelectorMatches(
      selector,
      this.descriptor.providerId,
      module,
      index.catalogSha256,
    );
    return {
      providerId: this.descriptor.providerId,
      exactSelector: selector,
      templateId: module.moduleId,
      value: { kind: "module-catalog", module, catalog: index },
    };
  }

  async describe(_context: ProviderContext, resolved: ResolvedProviderTemplate) {
    if (resolved.value.kind !== "module-catalog") throw new Error("invalid module Catalog resolution");
    const { module, catalog } = resolved.value;
    const validationState = legacyValidationStateFromExecutionStatus("not_run");
    return {
      code: "module_catalog_described" as const,
      summary: `Loaded exact personal module ${module.moduleId} from its pinned source and archive commits.`,
      detail: {
        templateId: module.moduleId,
        title: module.title,
        titleEn: module.titleEn,
        description: module.description,
        application: module.application,
        dataProfile: module.dataProfile,
        inputFiles: module.inputFiles,
        codeFiles: module.codeFiles,
        packages: module.packages,
        requiredFiles: module.requiredFiles,
        fullFiles: module.files,
        materializationModes: ["template", "full"],
        source: module.source,
        archive: module.archive,
        preview: module.preview,
        thumbnail: module.thumbnail,
        licenses: module.licenses,
        publisherReviewStatus: module.publisher.reviewStatus,
        publisherExecutionStatus: module.publisher.executionStatus,
        publisherExecutionScope: module.publisher.executionScope,
        localReviewStatus: "not_reviewed",
        executionStatus: "not_run",
        codeExecutedBySflClient: false,
        validationState,
        catalogSha256: catalog.catalogSha256,
      },
      lines: [
        `TITLE: ${module.title}`,
        `TITLE_EN: ${module.titleEn}`,
        "UPSTREAM_STATUS: personal_published",
        `PUBLISHER_REVIEW_STATUS: ${module.publisher.reviewStatus}`,
        `PUBLISHER_EXECUTION_STATUS: ${module.publisher.executionStatus}`,
        `PUBLISHER_EXECUTION_SCOPE: ${module.publisher.executionScope}`,
        "LOCAL_REVIEW_STATUS: not_reviewed",
        "EXECUTION_STATUS: not_run",
        "CODE_EXECUTED_BY_SFL_CLIENT: false",
        `SOURCE_COMMIT: ${module.source.commit}`,
        `ARCHIVE_COMMIT: ${module.archive.commit}`,
        `ARCHIVE_SHA256: ${module.archive.sha256}`,
        `REQUIRED_FILES: ${module.requiredFiles.join(", ")}`,
      ],
    };
  }

  async loadPreview(_context: ProviderContext, resolved: ResolvedProviderTemplate) {
    if (resolved.value.kind !== "module-catalog") throw new Error("invalid module Catalog resolution");
    let loaded;
    try {
      loaded = await resolved.value.catalog.preview(resolved.value.module, "primary");
    } catch (error) {
      throw new Error(
        `preview_unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return completePreview(this.descriptor.providerId, resolved, loaded);
  }

  async loadSearchPreview(_context: ProviderContext, resolved: ResolvedProviderTemplate) {
    if (resolved.value.kind !== "module-catalog") throw new Error("invalid module Catalog resolution");
    let loaded;
    try {
      loaded = await resolved.value.catalog.preview(resolved.value.module, "thumbnail");
    } catch (error) {
      throw new Error(
        `preview_unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return completePreview(this.descriptor.providerId, resolved, loaded);
  }

  async stageMaterialization(
    context: ProviderContext,
    resolved: ResolvedProviderTemplate,
    destination: string,
    allowNetwork: boolean,
  ) {
    const operation = context.materialization;
    if (!operation) throw new Error("materialization operation binding is required");
    if (resolved.value.kind !== "module-catalog") throw new Error("invalid module Catalog resolution");
    assertModuleArchiveExactSelector(resolved.exactSelector);
    const applied = await materializeModuleTemplate({
      providerId: this.descriptor.providerId,
      index: resolved.value.catalog,
      module: resolved.value.module,
      destination,
      mode: resolved.exactSelector.identity.mode,
      exactSelector: resolved.exactSelector,
      sourcePackDir: operation.sourcePackDir,
      allowNetwork,
      operationId: operation.operationId,
      planDigest: operation.planDigest,
    });
    return {
      providerId: this.descriptor.providerId,
      exactSelector: applied.exactSelector,
      target: applied.target,
      files: applied.files,
      materializationSource: applied.archiveSource,
      archiveSha256: applied.sha256,
    };
  }

  async verifyMaterialized(context: ProviderContext, binding: ProviderMaterializedBinding) {
    assertModuleArchiveExactSelector(binding.plannedSelector);
    assertModuleArchiveExactSelector(binding.exactSelector);
    const resolved = await this.resolve(context, binding.plannedSelector, "replay");
    if (resolved.value.kind !== "module-catalog") throw new Error("invalid module Catalog resolution");
    if (canonicalJson(binding.plannedSelector) !== canonicalJson(binding.exactSelector)) {
      throw new Error("personal module exact selector changed during materialization");
    }
    const lockPath = path.join(binding.target, "template.lock.json");
    let lock: ReturnType<typeof parseModuleTemplateLock>;
    try {
      lock = parseModuleTemplateLock(
        JSON.parse(await fs.readFile(lockPath, "utf8")) as unknown,
      );
    } catch (error) {
      throw new Error(
        `personal module materialization lock is invalid: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (
      lock.providerId !== this.descriptor.providerId ||
      canonicalJson(lock.plannedSelector) !== canonicalJson(binding.plannedSelector) ||
      canonicalJson(lock.exactSelector) !== canonicalJson(binding.exactSelector) ||
      canonicalJson(lock.licenses) !== canonicalJson(resolved.value.module.licenses) ||
      canonicalJson(lock.publisher) !== canonicalJson(resolved.value.module.publisher)
    ) {
      throw new Error("personal module materialization lock metadata is stale");
    }
    const observedPayload = binding.inventory.filter((entry) => entry.file !== "template.lock.json");
    if (canonicalJson(lock.files) !== canonicalJson(observedPayload)) {
      throw new Error("personal module materialization lock inventory is stale");
    }
    const expectedFiles = new Set(
      resolved.value.module.files.map((file) =>
        path.posix.join("upstream", file.path),
      ),
    );
    const requiredFiles = new Set(
      resolved.value.module.requiredFiles.map((file) =>
        path.posix.join("upstream", file),
      ),
    );
    const actualUpstream = binding.inventory
      .map((entry) => entry.file)
      .filter((file) => file.startsWith("upstream/"));
    const expectedUpstream =
      binding.plannedSelector.identity.mode === "full" ? expectedFiles : requiredFiles;
    if (
      actualUpstream.length !== expectedUpstream.size ||
      actualUpstream.some((file) => !expectedUpstream.has(file))
    ) {
      throw new Error("personal module materialization mode inventory is stale");
    }
    if (
      !sameNativePath(
        binding.target,
        path.join(path.dirname(binding.target), resolved.value.module.moduleId),
      )
    ) {
      throw new Error("personal module materialization target name is stale");
    }
  }

  async status(context: ProviderContext) {
    const index = moduleCatalogFor(context, this.descriptor.providerId, this.moduleCatalog);
    const sourcePackDirectory =
      context.moduleSourcePackDir ??
      process.env.PERSONAL_MODULE_SOURCE_PACK_DIR?.trim();
    const sourcePack = await inspectModuleSourcePack(index, sourcePackDirectory);
    const [previewChecks, thumbnailChecks] = await Promise.all([
      Promise.all(index.catalog.modules.map(async (module) => index.primaryPreviewAvailable(module))),
      Promise.all(index.catalog.modules.map(async (module) => index.thumbnailAvailable(module))),
    ]);
    const sourceCommits = [...new Set(index.catalog.modules.map((module) => module.source.commit))].sort();
    const archiveCommits = [...new Set(index.catalog.modules.map((module) => module.archive.commit))].sort();
    const sourcePackHealth = sourcePack.manifestValid
      ? sourcePack.invalidTemplates.length
        ? "degraded"
        : "ready"
      : sourcePack.configured
        ? "corrupt"
        : "not_configured";
    return {
      providerId: this.descriptor.providerId,
      sourceLabel: this.descriptor.sourceLabel,
      health: previewChecks.every(Boolean) &&
        thumbnailChecks.every(Boolean) &&
        sourcePackHealth !== "corrupt"
        ? ("ready" as const)
        : ("degraded" as const),
      details: {
        providerId: this.descriptor.providerId,
        sourceLabel: this.descriptor.sourceLabel,
        bundled: this.descriptor.bundled,
        enabled: this.descriptor.enabled !== false,
        includeInDefaultSearch: this.descriptor.includeInDefaultSearch !== false,
        moduleCount: index.catalog.modules.length,
        templateCount: index.catalog.modules.length,
        previewAvailableCount: previewChecks.filter(Boolean).length,
        thumbnailAvailableCount: thumbnailChecks.filter(Boolean).length,
        archiveAvailableCount: index.catalog.modules.length,
        repository: index.catalog.provider.repository,
        sourceRepository: index.catalog.provider.repository,
        archiveRepository: index.catalog.provider.repository,
        sourceCommits,
        archiveCommits,
        ...(sourceCommits.length === 1 ? { sourceCommit: sourceCommits[0] } : {}),
        ...(archiveCommits.length === 1 ? { archiveCommit: archiveCommits[0] } : {}),
        catalogSha256: index.catalogSha256,
        sourcePack,
        sourcePackConfigured: sourcePack.configured,
        sourcePackHealth,
        startupNetworkAccess: false,
        searchNetworkAccess: false,
        codeExecutedBySflClient: false,
      },
    };
  }
}

async function completePreview(
  providerId: string,
  resolved: ResolvedProviderTemplate,
  loaded:
    | { bytes: Uint8Array; mimeType: string; extension: string }
    | undefined,
): Promise<LoadedProviderPreview> {
  if (!loaded) throw new Error("preview_unavailable: no preview is available");
  if (!DISPLAY_MIME_TYPES.has(loaded.mimeType)) {
    throw new Error(`preview_unavailable: unsupported preview MIME ${loaded.mimeType}`);
  }
  return {
    providerId,
    exactSelector: resolved.exactSelector,
    exactSelectorDigest: exactSelectorDigest(resolved.exactSelector),
    templateId: resolved.templateId,
    bytes: loaded.bytes,
    byteLength: loaded.bytes.byteLength,
    mimeType: loaded.mimeType as LoadedProviderPreview["mimeType"],
    extension: loaded.extension,
    sha256: providerSha256(loaded.bytes),
  };
}

/**
 * Keeps a configured Provider addressable when its immutable local snapshot is
 * corrupt. Default multi-provider search can report and skip this adapter,
 * while an explicit request for only this Provider fails instead of looking
 * like an honest zero-result search.
 */
export class UnavailableProviderAdapter implements ProviderAdapter {
  readonly descriptor: ProviderDescriptor;
  readonly errorCode: string;
  readonly safeMessage: string;

  constructor(options: {
    providerId: string;
    sourceLabel: string;
    enabled: boolean;
    includeInDefaultSearch: boolean;
    kind?: ProviderDescriptor["kind"];
    defaultSearchOrder?: number;
    bundled?: boolean;
    frozen?: boolean;
    errorCode?: string;
    safeMessage: string;
  }) {
    this.descriptor = {
      providerId: options.providerId,
      sourceLabel: options.sourceLabel,
      kind: options.kind ?? "public-catalog",
      defaultSearchOrder: options.defaultSearchOrder ?? 100,
      bundled: options.bundled ?? false,
      enabled: options.enabled,
      includeInDefaultSearch: options.includeInDefaultSearch,
      ...(options.frozen !== undefined ? { frozen: options.frozen } : {}),
    };
    this.errorCode = options.errorCode ?? "provider_snapshot_corrupt";
    this.safeMessage = options.safeMessage;
  }

  #failure(): never {
    throw new Error(`${this.errorCode}: ${this.safeMessage}`);
  }

  assertSelector(selector: ExactTemplateSelector) {
    assertExactTemplateSelector(selector);
    if (selector.providerId !== this.descriptor.providerId) {
      throw new Error("selector providerId differs from the unavailable Provider");
    }
  }

  async revision(_context: ProviderContext) {
    return {
      providerId: this.descriptor.providerId,
      unavailable: true,
      errorCode: this.errorCode,
    };
  }

  async search(_context: ProviderContext, _request: SearchRequest): Promise<TemplateCandidate[]> {
    return this.#failure();
  }

  async resolve(
    _context: ProviderContext,
    _selector: ExactTemplateSelector,
    _purpose: "describe" | "preview" | "materialize" | "replay",
  ): Promise<ResolvedProviderTemplate> {
    return this.#failure();
  }

  async describe(
    _context: ProviderContext,
    _resolved: ResolvedProviderTemplate,
  ): Promise<ProviderDescription> {
    return this.#failure();
  }

  async loadPreview(
    _context: ProviderContext,
    _resolved: ResolvedProviderTemplate,
  ): Promise<LoadedProviderPreview> {
    return this.#failure();
  }

  async loadSearchPreview(
    _context: ProviderContext,
    _resolved: ResolvedProviderTemplate,
  ): Promise<LoadedProviderPreview> {
    return this.#failure();
  }

  async stageMaterialization(
    _context: ProviderContext,
    _resolved: ResolvedProviderTemplate,
    _stagingDirectory: string,
    _allowNetwork: boolean,
  ): Promise<VerifiedProviderPayload> {
    return this.#failure();
  }

  async verifyMaterialized(
    _context: ProviderContext,
    _binding: ProviderMaterializedBinding,
  ): Promise<void> {
    return this.#failure();
  }

  async status(_context: ProviderContext): Promise<ProviderStatus> {
    return {
      providerId: this.descriptor.providerId,
      sourceLabel: this.descriptor.sourceLabel,
      health: "corrupt",
      details: {
        providerId: this.descriptor.providerId,
        sourceLabel: this.descriptor.sourceLabel,
        kind: this.descriptor.kind,
        bundled: this.descriptor.bundled,
        enabled: this.descriptor.enabled !== false,
        includeInDefaultSearch: this.descriptor.includeInDefaultSearch !== false,
        frozen: this.descriptor.frozen === true,
        errorCode: this.errorCode,
        safeMessage: this.safeMessage,
        startupNetworkAccess: false,
        searchNetworkAccess: false,
      },
    };
  }
}

export class DefaultProviderRegistry implements ProviderRegistry {
  readonly #adapters: Map<string, ProviderAdapter>;

  constructor(adapters: ProviderAdapter[]) {
    this.#adapters = new Map();
    for (const adapter of adapters) {
      const { providerId } = adapter.descriptor;
      if (this.#adapters.has(providerId)) throw new Error(`duplicate providerId: ${providerId}`);
      this.#adapters.set(providerId, adapter);
    }
  }

  replaceProviders(providerIdsToRemove: Iterable<string>, adapters: ProviderAdapter[]) {
    for (const providerId of providerIdsToRemove) this.#adapters.delete(providerId);
    for (const adapter of adapters) {
      const { providerId } = adapter.descriptor;
      if (this.#adapters.has(providerId)) throw new Error(`duplicate providerId: ${providerId}`);
      this.#adapters.set(providerId, adapter);
    }
  }

  list() {
    return [...this.#adapters.values()]
      .map((adapter) => ({ ...adapter.descriptor }))
      .sort(
        (left, right) =>
          left.defaultSearchOrder - right.defaultSearchOrder ||
          left.providerId.localeCompare(right.providerId),
      );
  }

  get(providerId: string) {
    const adapter = this.#adapters.get(providerId);
    if (!adapter) throw new Error(`unsupported provider: ${providerId}`);
    return adapter;
  }

  defaultProviderIds() {
    return this.list()
      .filter(
        (descriptor) =>
          descriptor.enabled !== false && descriptor.includeInDefaultSearch !== false,
      )
      .map((descriptor) => descriptor.providerId);
  }

  async catalogRevision(providerIds: string[], context: ProviderContext) {
    const unique = [...new Set(providerIds)].sort();
    const revisions = await Promise.all(
      unique.map(async (providerId) => ({
        providerId,
        revision: await this.get(providerId).revision(context),
      })),
    );
    return providerSha256(
      canonicalJson({
        schema: "figure-library.search-catalog-revision.v1",
        providers: unique,
        libraryBinding: providerLibraryBindingDigest(context.library),
        revisions,
      }),
    );
  }

  async status(context: ProviderContext) {
    return Promise.all(this.list().map(({ providerId }) => this.get(providerId).status(context)));
  }
}

export function createDefaultProviderRegistry() {
  return new DefaultProviderRegistry([
    new LocalPublishedProviderAdapter(),
    new FigureYaProviderAdapter(),
    new ModuleCatalogProviderAdapter(),
  ]);
}

export function createProviderContext(
  library: CurrentLibraryContext,
  catalog: CatalogIndex,
  options: Omit<ProviderContext, "library" | "catalog"> = {},
): ProviderContext {
  return { library, catalog, ...options };
}
