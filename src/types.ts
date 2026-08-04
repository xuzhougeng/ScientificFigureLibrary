export interface CatalogFile {
  name: string;
  size: number;
}

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
  sourceUrl: string;
  reportUrl?: string;
  fullText: string;
}

export interface FigureYaCatalog {
  schema: "figure-library.figureya-catalog.v1";
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
export type ReviewStatus = "draft" | "approved" | "archived";
export type CodeStatus = "none" | "scaffold" | "reviewed";
export type ImportAdapter = "direct" | "gallery" | "figure-transfer-package";
export type IdentityMode = "stable-source" | "content-addressed";

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
  sourceId: "figureya" | "user";
  sourceLabel: string;
  title: string;
  retrievalScore: number;
  matchedTerms: string[];
  reasons: string[];
  warnings: string[];
  excerpt: string;
  description: string;
  application: string;
  dataProfile: string;
  inputFiles: string[];
  codeFiles: string[];
  packages: string[];
  materializable: boolean;
  previewAvailable: boolean;
  assetKind: AssetKind;
  language: string;
  plotFamily: string;
  reviewStatus: ReviewStatus;
  codeStatus: CodeStatus;
  license: string;
  sourceUrl?: string;
  reportUrl?: string;
  previewDataUrl?: string;
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
