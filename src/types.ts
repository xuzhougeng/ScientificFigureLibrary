export interface CatalogFile {
  name: string;
  size: number;
}

export type MaterializeMode = "template" | "full";

/**
 * Provider identifiers are deliberately open strings.  A provider owns the
 * interpretation of `kind` and `identity`; consumers must not infer an
 * identity from a display name or a directory name.
 */
export interface ExactTemplateSelector<
  TKind extends string = string,
  TIdentity extends Record<string, unknown> = Record<string, unknown>,
> {
  schema: "figure-library.provider-selector.v1";
  providerId: string;
  kind: TKind;
  identity: TIdentity;
}

export interface Sha256ArchiveIdentity extends Record<string, unknown> {
  algorithm: "sha256";
  digest: string;
  bytes: number;
}

export interface LegacyGitBlobArchiveIdentity extends Record<string, unknown> {
  algorithm: "git-blob-sha1";
  digest: string;
  bytes: number;
  legacy: true;
}

export type FigureYaArchiveIdentity =
  | Sha256ArchiveIdentity
  | LegacyGitBlobArchiveIdentity;

export interface FigureYaPreviewIdentity extends Record<string, unknown> {
  algorithm: "sha256";
  digest: string;
  bytes: number;
  mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
}

export interface FigureYaSelectorIdentity extends Record<string, unknown> {
  moduleId: string;
  sourceCommit: string;
  archiveCommit: string;
  archive: FigureYaArchiveIdentity;
  preview?: FigureYaPreviewIdentity;
  mode: MaterializeMode;
}

export type FigureYaExactSelector = ExactTemplateSelector<
  "figureya-module.v1",
  FigureYaSelectorIdentity
>;

export interface FigureYaSourceSelectorIdentity extends Record<string, unknown> {
  moduleId: string;
  sourceCommit: string;
  preview?: FigureYaPreviewIdentity;
}

export type FigureYaSourceExactSelector = ExactTemplateSelector<
  "figureya-source-module.v1",
  FigureYaSourceSelectorIdentity
>;

export interface ModuleArchiveIdentity extends Record<string, unknown> {
  algorithm: "sha256";
  repository: string;
  commit: string;
  path: string;
  digest: string;
  bytes: number;
}

export interface ModulePreviewIdentity extends Record<string, unknown> {
  algorithm: "sha256";
  digest: string;
  bytes: number;
  mediaType: "image/png" | "image/jpeg" | "image/webp";
}

export interface ModuleArchiveSelectorIdentity extends Record<string, unknown> {
  moduleId: string;
  sourceRepository: string;
  sourceCommit: string;
  sourcePath: string;
  archiveCommit: string;
  archive: ModuleArchiveIdentity;
  preview: ModulePreviewIdentity;
  catalogSha256: string;
  mode: MaterializeMode;
}

export type ModuleArchiveExactSelector = ExactTemplateSelector<
  "module-archive.v1",
  ModuleArchiveSelectorIdentity
>;

export interface ModuleCatalogFile {
  path: string;
  bytes: number;
  sha256: string;
}

export interface ModuleCatalogPreview {
  path: string;
  bytes: number;
  sha256: string;
  mediaType: "image/png" | "image/jpeg" | "image/webp";
}

export interface ModuleCatalogEntry {
  moduleId: string;
  title: string;
  titleEn: string;
  description: string;
  application: string;
  dataProfile: string;
  plotFamily: string;
  language: string;
  tags: string[];
  packages: string[];
  codeFiles: string[];
  inputFiles: string[];
  canonicalCode: string;
  requiredFiles: string[];
  files: ModuleCatalogFile[];
  source: {
    repository: string;
    commit: string;
    path: string;
  };
  archive: {
    repository: string;
    commit: string;
    path: string;
    bytes: number;
    sha256: string;
  };
  preview: ModuleCatalogPreview;
  thumbnail: ModuleCatalogPreview;
  licenses: {
    code: string;
    content: string;
    documentation: string;
  };
  publisher: {
    reviewStatus: "approved";
    executionStatus: "not_run" | "passed" | "failed";
    executionScope: "synthetic_data" | "example_data" | "real_data" | "unknown";
    evidence?: string[];
  };
  provenance?: Record<string, unknown>[];
}

export interface ModuleCatalog {
  schema: "figure-library.module-catalog.v1";
  generatedAt: string;
  provider: {
    providerId: string;
    displayName: string;
    repository: string;
  };
  modules: ModuleCatalogEntry[];
}

export interface ModuleProviderStatusDetails {
  providerId: string;
  sourceLabel: string;
  health: "ready" | "degraded" | "corrupt";
  bundled: boolean;
  enabled: boolean;
  includeInDefaultSearch: boolean;
  moduleCount: number;
  previewAvailableCount: number;
  thumbnailAvailableCount?: number;
  archiveAvailableCount: number;
  sourceRepository: string;
  sourceCommits: string[];
  archiveRepository: string;
  archiveCommits: string[];
  sourcePackConfigured: boolean;
  sourcePackHealth: "ready" | "degraded" | "corrupt" | "not_configured";
  codeExecutedBySflClient: false;
}

export interface ModulePreviewManifest {
  schema: "figure-library.module-preview-manifest.v1";
  providerId: string;
  entries: Array<{
    moduleId: string;
    role: "primary" | "thumbnail";
    path: string;
    bytes: number;
    sha256: string;
    mediaType: "image/png" | "image/jpeg" | "image/webp";
  }>;
}

export interface ModuleSourcePackManifest {
  schema: "figure-library.module-source-pack.v1";
  providerId: string;
  repository: string;
  entries: Array<{
    moduleId: string;
    sourceRepository: string;
    sourceCommit: string;
    archiveRepository: string;
    archiveCommit: string;
    file: string;
    bytes: number;
    sha256: string;
  }>;
}

export interface LocalPublishedSelectorIdentity extends Record<string, unknown> {
  templateId: string;
  revisionId: string;
  contentDigest: string;
  releaseId: string;
}

export type LocalPublishedExactSelector = ExactTemplateSelector<
  "local-published.v1",
  LocalPublishedSelectorIdentity
>;

export interface ProviderPreviewRef {
  schema: "figure-library.provider-preview-ref.v1";
  providerId: string;
  exactSelector: ExactTemplateSelector;
}

export type PreviewStatus =
  | "ready"
  | "missing"
  | "unreadable"
  | "unsupported"
  | "too_large";

export interface FigureYaModule {
  moduleId: string;
  title: string;
  requirement: string;
  application: string;
  inputSummary: string;
  codeFiles: string[];
  inputFiles: string[];
  packages: string[];
  files: CatalogFile[];
  thumbnail?: string;
  archiveAvailable: boolean;
  archiveBytes?: number;
  archiveGitBlobSha1?: string;
  archiveSha256?: string;
  archiveIdentity?: "sha256" | "legacy-git-blob-sha1";
  primaryPreview?: string;
  previewBytes?: number;
  previewSha256?: string;
  previewMediaType?: FigureYaPreviewIdentity["mediaType"];
  canonicalCode?: string;
  requiredFiles?: string[];
  sourceUrl: string;
  reportUrl?: string;
  fullText: string;
}

export interface FigureYaCatalog {
  schema: "figure-library.figureya-catalog.v1" | "figure-library.figureya-catalog.v2";
  generatedAt: string;
  figureya: {
    repository: string;
    commit: string;
  };
  compressed: {
    repository: string;
    commit: string;
  };
  citation: string;
  modules: FigureYaModule[];
}

export interface SearchRequest {
  query: string;
  dataProfile?: string;
  visualProfile?: string;
  assetKind?: AssetKind;
  language?: string;
  plotFamily?: string;
  reviewStatus?: ReviewStatus;
  codeStatus?: CodeStatus;
  limit?: number;
}

export type AssetKind = "plot_template" | "visual_reference";
export type ReviewStatus = "not_reviewed" | "draft" | "approved" | "archived";
export type CodeStatus = "none" | "scaffold" | "provided" | "reviewed";
export type ExecutionStatus = "not_run" | "passed" | "failed" | "unknown";
export type ImportAdapter = "direct" | "gallery" | "figure-transfer-package";
export type IdentityMode = "stable-source" | "content-addressed";

/**
 * Search-facing projection of the immutable Revision validation state. The
 * stored Revision uses canonical asset paths rather than caller asset ids.
 * This remains optional on TemplateCandidate so older providers and cached
 * search payloads can still be read and conservatively projected by clients.
 */
export interface ValidationStateSummaryV1 {
  schema: "figure-library.validation-state.v1";
  plotExecution: {
    status: "not_run" | "passed" | "failed";
    scope: "synthetic_data" | "example_data" | "real_data" | "unknown";
    evidenceAssetPaths?: string[];
  };
  upstreamWorkflow: {
    status:
      | "unknown"
      | "not_run"
      | "partial"
      | "passed"
      | "failed"
      | "not_applicable";
    scope?: string;
    evidenceAssetPaths?: string[];
  };
  scientificValidation: {
    status:
      | "not_assessed"
      | "limited"
      | "validated"
      | "rejected"
      | "not_applicable";
    decisionSource?: "user" | "external_review";
    assessmentAssetPath?: string;
  };
}

export type CanonicalPreviewDecisionSummary =
  | {
      assetPath: string;
      reason: "default_uploaded_source" | "only_visual_available";
      selectedBy: "policy";
    }
  | {
      assetPath: string;
      reason: "user_selected_source";
      selectedBy: "user";
    }
  | {
      assetPath: string;
      reason: "user_override_rendered";
      selectedBy: "user";
      note: string;
    };

export interface AssetFingerprintsV1 {
  algorithm: "figure-library.asset-fingerprints.v1";
  previewSha256?: string;
  executableCodeSetSha256?: string;
  dataSetSha256?: string;
  metadataSetSha256?: string;
  fullAssetSha256: string;
}

export interface ManagementReference {
  templateId: string;
  adapter?: ImportAdapter;
  registrySourceId?: string;
  galleryId?: string;
  identityMode?: IdentityMode;
  canArchive: boolean;
  canUpdate: boolean;
  updateVia?: "plan-apply" | "diff-upsert" | "gallery-sync";
}

export interface TemplateCandidate {
  templateId: string;
  providerId: string;
  exactSelector: ExactTemplateSelector;
  materializationModes?: MaterializeMode[];
  materializationSelectors?: Partial<Record<MaterializeMode, ExactTemplateSelector>>;
  sourceLabel: string;
  title: string;
  retrievalScore: number;
  matchedTerms: string[];
  reasons: string[];
  warnings: string[];
  excerpt: string;
  description: string;
  scientificQuestion?: string;
  application: string;
  dataProfile: string;
  inputFiles: string[];
  codeFiles: string[];
  packages: string[];
  materializable: boolean;
  previewAvailable: boolean;
  /** Search-card thumbnail availability; exact preview availability remains `previewAvailable`. */
  searchPreviewAvailable?: boolean;
  /** Search-card thumbnail transport state; `previewStatus` remains the exact-preview state. */
  searchPreviewStatus?: PreviewStatus;
  previewRef?: ProviderPreviewRef;
  previewStatus?: PreviewStatus;
  previewDataUrl?: string;
  previewMimeType?: "image/png" | "image/jpeg" | "image/webp";
  previewByteLength?: number;
  previewSha256?: string;
  assetKind: AssetKind;
  language: string;
  plotFamily: string;
  reviewStatus: ReviewStatus;
  codeStatus: CodeStatus;
  executionStatus: ExecutionStatus;
  publisherReviewStatus?: "approved" | "not_reviewed";
  publisherExecutionStatus?: "not_run" | "passed" | "failed";
  publisherExecutionScope?: "synthetic_data" | "example_data" | "real_data" | "unknown";
  publisherEvidence?: string[];
  codeExecutedBySflClient?: false;
  validationState?: ValidationStateSummaryV1;
  canonicalPreviewDecision?: CanonicalPreviewDecisionSummary;
  upstreamStatus?: "published" | "available" | "unavailable" | "unknown";
  license: string;
  sourceUrl?: string;
  reportUrl?: string;
  management: ManagementReference;
}

export interface StoredFile {
  file: string;
  bytes: number;
  sha256: string;
}

export interface StoredPreview extends StoredFile {
  mediaType: string;
}

export interface StoredReference extends StoredFile {
  role: "data" | "metadata";
}

export interface TemplateProvenance {
  producer?: string;
  producerVersion?: string;
  exportedAt?: string;
  sourceId?: string;
  figureId?: string;
  parentFigureId?: string;
  figureLabel?: string;
  subfigureLabels?: string[];
  caption?: string;
  paperTitle?: string;
  authors?: string[];
  year?: string;
  journal?: string;
  doi?: string;
  page?: string;
  url?: string;
  licenseScope?: string;
  rights?: string;
}

export interface ImportRegistryEntry {
  adapter: ImportAdapter;
  sourceId: string;
  templateId?: string;
  galleryId?: string;
  contentHash: string;
  sourceCommit?: string;
  identityMode?: IdentityMode;
  fingerprints?: AssetFingerprintsV1;
}

export interface UserTemplate {
  schema: "figure-library.template.v1";
  templateId: string;
  sourceId: "user";
  title: string;
  description: string;
  tags: string[];
  visualProfile: string;
  dataProfile: string;
  scientificQuestion?: string;
  packages: string[];
  license: string;
  importedAt: string;
  updatedAt?: string;
  archivedAt?: string;
  assetKind?: AssetKind;
  language?: string;
  plotFamily?: string;
  reviewStatus?: ReviewStatus;
  codeStatus?: CodeStatus;
  provenance?: TemplateProvenance;
  registry?: ImportRegistryEntry;
  preview?: StoredPreview;
  code: StoredFile[];
  references?: StoredReference[];
}

export interface UserTemplateImport {
  title: string;
  description?: string;
  tags?: string[];
  visualProfile?: string;
  dataProfile?: string;
  scientificQuestion?: string;
  packages?: string[];
  license?: string;
  assetKind?: AssetKind;
  language?: string;
  plotFamily?: string;
  reviewStatus?: ReviewStatus;
  codeStatus?: CodeStatus;
  provenance?: TemplateProvenance;
  imagePath?: string;
  codePaths?: string[];
  sourceKey?: string;
}
