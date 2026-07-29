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
  limit?: number;
}

export interface TemplateCandidate {
  templateId: string;
  sourceId: "figureya" | "user";
  sourceLabel: string;
  title: string;
  relevance: number;
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
  license: string;
  sourceUrl?: string;
  reportUrl?: string;
  previewDataUrl?: string;
}

export interface StoredFile {
  file: string;
  bytes: number;
  sha256: string;
}

export interface StoredPreview extends StoredFile {
  mediaType: string;
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
  preview?: StoredPreview;
  code: StoredFile[];
}

export interface UserTemplateImport {
  title: string;
  description?: string;
  tags?: string[];
  visualProfile?: string;
  dataProfile?: string;
  packages?: string[];
  license?: string;
  imagePath?: string;
  codePaths?: string[];
}
