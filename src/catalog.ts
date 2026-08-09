import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  ExactTemplateSelector,
  FigureYaCatalog,
  FigureYaModule,
  SearchRequest,
  TemplateCandidate,
} from "./types.ts";
import {
  FIGUREYA_PROVIDER_ID,
  assertExactTemplateSelector,
  assertFigureYaExactSelector,
  assertFigureYaSelectorMatches,
  assertFigureYaSourceExactSelector,
  assertFigureYaSourceSelectorMatches,
  figureYaArchiveIdentity,
  figureYaCandidateSelector,
  figureYaPreviewIdentity,
} from "./providers.ts";
import { assertMcpImageBytes } from "./image-validation.ts";

export function isMcpImagePath(file: string | undefined) {
  if (!file) return false;
  return [".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(
    path.extname(file).toLocaleLowerCase(),
  );
}

const DEFAULT_ASSETS_DIR = path.resolve(import.meta.dirname, "..", "assets");
const PREVIEW_MANIFEST = "figureya-preview.manifest.json";
const SHA256 = /^[a-f0-9]{64}$/u;

function previewMediaType(file: string) {
  const extension = path.extname(file).toLocaleLowerCase("en-US");
  if (extension === ".png") return "image/png" as const;
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg" as const;
  if (extension === ".gif") return "image/gif" as const;
  if (extension === ".webp") return "image/webp" as const;
  return undefined;
}

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "been",
  "by",
  "for",
  "from",
  "in",
  "include",
  "includes",
  "including",
  "into",
  "is",
  "not",
  "of",
  "on",
  "one",
  "or",
  "per",
  "row",
  "the",
  "then",
  "to",
  "top",
  "typically",
  "use",
  "used",
  "using",
  "versus",
  "with",
  "without",
]);

const GENERIC_TERMS = new Set([
  "analysis",
  "axis",
  "clean",
  "colored",
  "data",
  "expression",
  "feature",
  "features",
  "figure",
  "gene",
  "genes",
  "group",
  "label",
  "labels",
  "line",
  "lines",
  "plot",
  "points",
  "result",
  "results",
  "significant",
  "style",
  "table",
  "theme",
]);

const SHORT_DOMAIN_TERMS = new Set(["hr", "km"]);
const DOMAIN_PHRASES = [
  "adjusted p value",
  "differential expression",
  "fold change",
  "gene expression",
  "hazard ratio",
  "principal component",
  "single cell",
  "time status",
] as const;

const SPECIALIZED_VARIANTS = [
  {
    label: "多组/复合面板",
    idPatterns: ["multi"],
    triggers: ["multi", "multiple", "multi-panel", "multiple groups", "多组", "多层", "复杂"],
  },
  {
    label: "气泡编码",
    idPatterns: ["bubble"],
    triggers: ["bubble", "bubble plot", "point size", "size encoding", "气泡"],
  },
  {
    label: "交互式 Shiny",
    idPatterns: ["shiny"],
    triggers: ["shiny", "interactive", "交互"],
  },
  {
    label: "三维",
    idPatterns: ["3d"],
    triggers: ["3d", "three dimensional", "three-dimensional", "三维"],
  },
] as const;

const CANONICAL_FAMILY_IDS: Partial<Record<string, RegExp>> = {
  volcano: /^figureya\d+volcanov?\d*$/u,
};

const FIGURE_FAMILIES = [
  {
    id: "volcano",
    label: "volcano / 火山图",
    triggers: ["volcano", "火山图"],
    idPatterns: ["volcano"],
  },
  {
    id: "survival",
    label: "survival / 生存曲线",
    triggers: ["survival", "survival curve", "kaplan meier", "kaplan-meier", "km curve", "生存曲线", "生存"],
    idPatterns: ["surv", "survival", "kaplan", "km"],
  },
  {
    id: "heatmap",
    label: "heatmap / 热图",
    triggers: ["heatmap", "pheatmap", "complexheatmap", "热图"],
    idPatterns: ["heatmap"],
  },
  {
    id: "pca",
    label: "PCA / 主成分图",
    triggers: ["pca", "principal component", "主成分"],
    idPatterns: ["pca"],
  },
  {
    id: "roc",
    label: "ROC",
    triggers: ["roc", "receiver operating characteristic"],
    idPatterns: ["roc", "auc"],
  },
  {
    id: "boxplot",
    label: "boxplot / 箱线图",
    triggers: ["boxplot", "box plot", "箱线图", "箱图"],
    idPatterns: ["box"],
  },
  {
    id: "violin",
    label: "violin / 小提琴图",
    triggers: ["violin", "小提琴图"],
    idPatterns: ["violin"],
  },
  {
    id: "scatter",
    label: "scatter / 散点图",
    triggers: ["scatter plot", "scatter", "散点图"],
    idPatterns: ["scatter"],
  },
  {
    id: "bar",
    label: "bar chart / 柱状图",
    triggers: ["barplot", "bar chart", "柱状图", "条形图"],
    idPatterns: ["bar"],
  },
  {
    id: "bubble",
    label: "bubble / 气泡图",
    triggers: ["bubble plot", "bubble", "气泡图"],
    idPatterns: ["bubble"],
  },
  {
    id: "forest",
    label: "forest plot / 森林图",
    triggers: ["forest plot", "森林图"],
    idPatterns: ["forest", "hrtable"],
  },
  {
    id: "venn",
    label: "Venn / 韦恩图",
    triggers: ["venn", "韦恩图"],
    idPatterns: ["venn"],
  },
  {
    id: "circos",
    label: "Circos / 圈图",
    triggers: ["circos", "circos plot", "圈图", "环形图"],
    idPatterns: ["circos", "circ"],
  },
  {
    id: "sankey",
    label: "Sankey / 桑基图",
    triggers: ["sankey", "桑基图"],
    idPatterns: ["sankey"],
  },
  {
    id: "correlation",
    label: "correlation / 相关图",
    triggers: ["correlation", "相关性", "相关图"],
    idPatterns: ["correlation", "corrgram", "corplot"],
  },
  {
    id: "network",
    label: "network / 网络图",
    triggers: ["network", "网络图"],
    idPatterns: ["network", "interaction"],
  },
  {
    id: "enrichment",
    label: "enrichment / 富集图",
    triggers: ["gsea", "enrichment", "富集分析", "富集图"],
    idPatterns: ["gsea", "enrich"],
  },
  {
    id: "mutation",
    label: "mutation / 突变图",
    triggers: ["mutation", "oncoplot", "oncoprint", "突变"],
    idPatterns: ["mutation", "oncoplot", "oncoprint", "mutsig"],
  },
  {
    id: "single-cell",
    label: "single-cell / 单细胞",
    triggers: ["single cell", "single-cell", "scrna", "单细胞"],
    idPatterns: [
      "singlecell",
      "scrna",
      "scatac",
      "sccell",
      "sccnv",
      "scenic",
      "scgsva",
      "scheatmap",
      "scmarker",
      "scmetabolism",
      "scscore",
      "scviolin",
    ],
  },
] as const;

export interface SearchIntent {
  families: string[];
  terms: Array<{ value: string; weight: number }>;
}

export interface SearchableTemplate {
  templateId: string;
  title: string;
  description: string;
  application: string;
  dataProfile: string;
  inputFiles: string[];
  codeFiles: string[];
  packages: string[];
  tags?: string[];
}

export interface SearchEvidence {
  score: number;
  matchedTerms: string[];
  familyMatches: string[];
  reasons: string[];
}

export function normalizeSearchText(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/[‐‑‒–—]/gu, "-")
    .replace(/\s+/gu, " ")
    .trim();
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function containsPhrase(text: string, phrase: string) {
  const normalizedPhrase = normalizeSearchText(phrase);
  if (/^[a-z0-9][a-z0-9 ._+-]*$/u.test(normalizedPhrase)) {
    const pattern = escapeRegex(normalizedPhrase).replace(/ /gu, "\\s+");
    return new RegExp(`(?:^|[^a-z0-9])${pattern}(?=$|[^a-z0-9])`, "u").test(text);
  }
  return text.includes(normalizedPhrase);
}

function tokens(value: string) {
  const matches =
    normalizeSearchText(value).match(/[a-z0-9][a-z0-9_.+-]*|[\p{Script=Han}]{2,}/gu) ?? [];
  return matches
    .map((token) => token.replace(/^[._+-]+|[._+-]+$/gu, ""))
    .filter((token) => {
      if (!token || STOP_WORDS.has(token)) return false;
      if (/^[a-z0-9]/u.test(token) && token.length < 3 && !SHORT_DOMAIN_TERMS.has(token)) {
        return false;
      }
      return true;
    });
}

export function buildSearchIntent(request: SearchRequest): SearchIntent {
  const weighted = new Map<string, number>();
  const add = (value: string, weight: number) => {
    const normalized = normalizeSearchText(value);
    if (!normalized || STOP_WORDS.has(normalized)) return;
    weighted.set(normalized, Math.max(weighted.get(normalized) ?? 0, weight));
  };
  const addText = (value: string | undefined, weight: number) => {
    if (!value) return;
    for (const token of tokens(value).slice(0, 18)) add(token, weight);
    const normalized = normalizeSearchText(value);
    for (const phrase of DOMAIN_PHRASES) {
      if (containsPhrase(normalized, phrase)) add(phrase, weight * 1.5);
    }
  };

  addText(request.query, 5);
  addText(request.visualProfile, 2);
  addText(request.dataProfile, 1);

  const familyText = normalizeSearchText(
    [request.query, request.visualProfile].filter(Boolean).join(" "),
  );
  let families = FIGURE_FAMILIES.filter((family) =>
    family.triggers.some((trigger) => containsPhrase(familyText, trigger)),
  );
  if (families.some((family) => family.id === "volcano")) {
    families = families.filter((family) => family.id !== "scatter");
  }
  for (const family of families) {
    add(family.id, 12);
    for (const trigger of family.triggers) add(trigger, 8);
  }

  return {
    families: families.map((family) => family.id),
    terms: [...weighted.entries()]
      .map(([value, weight]) => ({ value, weight }))
      .sort((left, right) => right.weight - left.weight || right.value.length - left.value.length)
      .slice(0, 48),
  };
}

function includesTerm(field: string, term: string, allowEmbedded = false) {
  return allowEmbedded ? field.includes(term) : containsPhrase(field, term);
}

export function scoreSearchableTemplate(
  template: SearchableTemplate,
  intent: SearchIntent,
): SearchEvidence {
  const fields = [
    {
      name: "标题/标识",
      value: normalizeSearchText(`${template.templateId} ${template.title}`),
      weight: 10,
      embedded: true,
    },
    {
      name: "标签",
      value: normalizeSearchText(template.tags?.join(" ") ?? ""),
      weight: 8,
      embedded: false,
    },
    {
      name: "主要说明",
      value: normalizeSearchText(template.description),
      weight: 5,
      embedded: false,
    },
    {
      name: "视觉特征",
      value: normalizeSearchText(template.application),
      weight: 3,
      embedded: false,
    },
    {
      name: "数据需求",
      value: normalizeSearchText(
        `${template.dataProfile} ${template.inputFiles.join(" ")} ${template.codeFiles.join(" ")}`,
      ),
      weight: 3,
      embedded: false,
    },
    {
      name: "依赖包",
      value: normalizeSearchText(template.packages.join(" ")),
      weight: 1,
      embedded: false,
    },
  ] as const;

  let score = 0;
  const matchedTerms = new Set<string>();
  const fieldMatches = new Map<string, string[]>();
  for (const term of intent.terms) {
    const specificity = GENERIC_TERMS.has(term.value) ? 0.15 : 1;
    for (const field of fields) {
      if (!field.value || !includesTerm(field.value, term.value, field.embedded)) continue;
      score += term.weight * field.weight * specificity;
      matchedTerms.add(term.value);
      const matches = fieldMatches.get(field.name) ?? [];
      matches.push(term.value);
      fieldMatches.set(field.name, matches);
    }
  }

  const identifier = fields[0].value;
  const compactTemplateId = normalizeSearchText(template.templateId).replace(/[^a-z0-9]+/gu, "");
  const description = fields[2].value;
  const application = fields[3].value;
  const familyMatches = [];
  for (const familyId of intent.families) {
    const family = FIGURE_FAMILIES.find((item) => item.id === familyId);
    if (!family) continue;
    if (family.idPatterns.some((pattern) => identifier.includes(pattern))) {
      score += 600;
      familyMatches.push(family.label);
    } else if (family.triggers.some((trigger) => containsPhrase(description, trigger))) {
      score += 120;
      familyMatches.push(family.label);
    } else if (family.triggers.some((trigger) => containsPhrase(application, trigger))) {
      score += 60;
      familyMatches.push(family.label);
    }

    const canonicalPattern = CANONICAL_FAMILY_IDS[family.id];
    if (canonicalPattern?.test(compactTemplateId)) {
      score += 160;
      familyMatches.push(`${family.label}（通用版本）`);
    }
  }

  const intentText = intent.terms.map((term) => term.value).join(" ");
  const variantNotes = [];
  for (const variant of SPECIALIZED_VARIANTS) {
    if (!variant.idPatterns.some((pattern) => compactTemplateId.includes(pattern))) continue;
    const requested = variant.triggers.some((trigger) => containsPhrase(intentText, trigger));
    if (requested) {
      score += 350;
      variantNotes.push(`特化需求匹配：${variant.label}`);
    } else {
      score -= 220;
      variantNotes.push(`未请求的特化形式：${variant.label}`);
    }
  }

  const reasons = [];
  if (familyMatches.length) reasons.push(`图表家族匹配：${familyMatches.join("、")}`);
  reasons.push(...variantNotes);
  for (const field of fields) {
    const matches = fieldMatches.get(field.name);
    if (matches?.length) {
      reasons.push(`${field.name}匹配：${[...new Set(matches)].slice(0, 4).join("、")}`);
    }
  }
  return {
    score: Math.max(score, 0),
    matchedTerms: [...matchedTerms],
    familyMatches,
    reasons: reasons.slice(0, 3),
  };
}

function excerpt(module: FigureYaModule, terms: string[]): string {
  const text = module.fullText;
  const lower = normalizeSearchText(text);
  let matchIndex = -1;
  for (const term of terms) {
    const index = lower.indexOf(term);
    if (index >= 0 && (matchIndex < 0 || index < matchIndex)) matchIndex = index;
  }
  if (matchIndex < 0) return module.requirement.slice(0, 420);
  const start = Math.max(0, matchIndex - 120);
  const end = Math.min(text.length, matchIndex + 320);
  return `${start > 0 ? "…" : ""}${text.slice(start, end).trim()}${end < text.length ? "…" : ""}`;
}

function figureYaLanguages(module: FigureYaModule) {
  const extensions = new Set(module.codeFiles.map((file) => path.extname(file).toLocaleLowerCase()));
  const languages = [];
  if (extensions.has(".r") || extensions.has(".rmd") || extensions.has(".qmd")) languages.push("R");
  if (extensions.has(".py") || extensions.has(".ipynb")) languages.push("Python");
  if (extensions.has(".jl")) languages.push("Julia");
  if (extensions.has(".m")) languages.push("MATLAB");
  if (extensions.has(".sh")) languages.push("Shell");
  return languages.length ? languages : ["none"];
}

function figureYaFamilies(module: FigureYaModule) {
  return buildSearchIntent({
    query: `${module.moduleId} ${module.title} ${module.requirement} ${module.application}`,
  }).families;
}

function matchesFigureYaFilters(module: FigureYaModule, request: SearchRequest) {
  if (request.assetKind && request.assetKind !== "plot_template") return false;
  if (request.reviewStatus && request.reviewStatus !== "not_reviewed") return false;
  if (request.codeStatus) {
    const status = module.codeFiles.length ? "provided" : "none";
    if (request.codeStatus !== status) return false;
  }
  if (
    request.language &&
    !figureYaLanguages(module).some(
      (language) => language.toLocaleLowerCase() === request.language?.toLocaleLowerCase(),
    )
  ) {
    return false;
  }
  if (request.plotFamily) {
    const requested = buildSearchIntent({ query: request.plotFamily }).families;
    const families = figureYaFamilies(module);
    if (requested.length) return requested.some((family) => families.includes(family));
    return normalizeSearchText(module.fullText).includes(normalizeSearchText(request.plotFamily));
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function catalogPath(value: unknown, field: string): string {
  if (typeof value !== "string" || !value || value.includes("\0")) {
    throw new Error(`${field} must be a non-empty portable path`);
  }
  const normalized = value.replaceAll("\\", "/");
  if (
    normalized.startsWith("/") ||
    /^[A-Za-z]:/u.test(normalized) ||
    normalized.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(`${field} is not a portable relative path: ${value}`);
  }
  return normalized;
}

function stringArray(value: unknown, field: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${field} must be an array of strings`);
  }
}

function validateFigureYaCatalog(value: unknown): asserts value is FigureYaCatalog {
  if (!isRecord(value)) throw new Error("FigureYa catalog must be an object");
  if (
    value.schema !== "figure-library.figureya-catalog.v1" &&
    value.schema !== "figure-library.figureya-catalog.v2"
  ) {
    throw new Error(`unsupported catalog schema: ${String(value.schema)}`);
  }
  if (!isRecord(value.figureya) || !isRecord(value.compressed)) {
    throw new Error("FigureYa catalog repository identities are missing");
  }
  for (const [name, repository] of [
    ["figureya", value.figureya],
    ["compressed", value.compressed],
  ] as const) {
    if (typeof repository.repository !== "string" || !repository.repository) {
      throw new Error(`${name}.repository is missing`);
    }
    if (typeof repository.commit !== "string" || !repository.commit) {
      throw new Error(`${name}.commit is missing`);
    }
  }
  if (!Array.isArray(value.modules)) throw new Error("FigureYa catalog modules are missing");
  const ids = new Set<string>();
  for (const [index, item] of value.modules.entries()) {
    if (!isRecord(item) || typeof item.moduleId !== "string" || !item.moduleId) {
      throw new Error(`modules[${index}].moduleId is missing`);
    }
    if (ids.has(item.moduleId)) throw new Error(`duplicate FigureYa moduleId: ${item.moduleId}`);
    ids.add(item.moduleId);
    for (const field of ["codeFiles", "inputFiles", "packages"] as const) {
      stringArray(item[field], `${item.moduleId}.${field}`);
    }
    if (!Array.isArray(item.files)) throw new Error(`${item.moduleId}.files must be an array`);
    for (const [fileIndex, file] of item.files.entries()) {
      if (!isRecord(file)) throw new Error(`${item.moduleId}.files[${fileIndex}] is invalid`);
      catalogPath(file.name, `${item.moduleId}.files[${fileIndex}].name`);
      if (!Number.isSafeInteger(file.size) || Number(file.size) < 0) {
        throw new Error(`${item.moduleId}.files[${fileIndex}].size is invalid`);
      }
    }
    if (item.thumbnail !== undefined) catalogPath(item.thumbnail, `${item.moduleId}.thumbnail`);
    if (item.primaryPreview !== undefined) {
      catalogPath(item.primaryPreview, `${item.moduleId}.primaryPreview`);
    }
    if (item.canonicalCode !== undefined) {
      catalogPath(item.canonicalCode, `${item.moduleId}.canonicalCode`);
    }
    if (item.requiredFiles !== undefined) {
      stringArray(item.requiredFiles, `${item.moduleId}.requiredFiles`);
      item.requiredFiles.forEach((file, fileIndex) =>
        catalogPath(file, `${item.moduleId}.requiredFiles[${fileIndex}]`),
      );
    }
    if (item.archiveAvailable !== true && item.archiveAvailable !== false) {
      throw new Error(`${item.moduleId}.archiveAvailable must be boolean`);
    }
    if (item.archiveAvailable) {
      figureYaArchiveIdentity(item as unknown as FigureYaModule);
      if (value.schema === "figure-library.figureya-catalog.v2") {
        if (!item.archiveSha256 || item.archiveIdentity !== "sha256") {
          throw new Error(`${item.moduleId} lacks required v2 SHA-256 archive identity`);
        }
        if (!Array.isArray(item.requiredFiles)) {
          throw new Error(`${item.moduleId} lacks required v2 requiredFiles`);
        }
      }
    }
    figureYaPreviewIdentity(item as unknown as FigureYaModule);
  }
}

function applyPreviewManifest(catalog: FigureYaCatalog, value: unknown) {
  if (
    !isRecord(value) ||
    value.schema !== "figure-library.figureya-preview-manifest.v1" ||
    value.providerId !== FIGUREYA_PROVIDER_ID ||
    value.sourceRepository !== catalog.figureya.repository ||
    value.sourceCommit !== catalog.figureya.commit ||
    !Array.isArray(value.previews)
  ) {
    throw new Error("FigureYa preview manifest identity is invalid");
  }
  const modules = new Map(catalog.modules.map((module) => [module.moduleId, module]));
  const seen = new Set<string>();
  let previous = "";
  for (const [index, raw] of value.previews.entries()) {
    if (
      !isRecord(raw) ||
      typeof raw.moduleId !== "string" ||
      !raw.moduleId ||
      typeof raw.file !== "string" ||
      !Number.isSafeInteger(raw.bytes) ||
      Number(raw.bytes) <= 0 ||
      typeof raw.sha256 !== "string" ||
      !SHA256.test(raw.sha256) ||
      typeof raw.mediaType !== "string"
    ) {
      throw new Error(`FigureYa preview manifest entry ${index} is invalid`);
    }
    if (previous && previous >= raw.moduleId) {
      throw new Error("FigureYa preview manifest is not canonically ordered");
    }
    previous = raw.moduleId;
    if (seen.has(raw.moduleId)) throw new Error(`duplicate FigureYa preview: ${raw.moduleId}`);
    seen.add(raw.moduleId);
    const module = modules.get(raw.moduleId);
    if (!module) throw new Error(`preview manifest references unknown module: ${raw.moduleId}`);
    const declared = module.primaryPreview ?? module.thumbnail;
    if (!declared || catalogPath(raw.file, `${raw.moduleId}.preview.file`) !== declared) {
      throw new Error(`preview manifest path disagrees with the Catalog: ${raw.moduleId}`);
    }
    const expectedMediaType = previewMediaType(declared);
    if (!expectedMediaType || raw.mediaType !== expectedMediaType) {
      throw new Error(`preview manifest media type disagrees with its path: ${raw.moduleId}`);
    }
    module.previewBytes = Number(raw.bytes);
    module.previewSha256 = raw.sha256;
    module.previewMediaType = expectedMediaType;
    figureYaPreviewIdentity(module);
  }
  const missing = catalog.modules
    .filter((module) => (module.primaryPreview ?? module.thumbnail) && !seen.has(module.moduleId))
    .map((module) => module.moduleId);
  if (missing.length) {
    throw new Error(`FigureYa preview manifest is incomplete: ${missing.slice(0, 5).join(", ")}`);
  }
}

export class CatalogIndex {
  readonly catalog: FigureYaCatalog;
  readonly assetsDir: string;

  private constructor(catalog: FigureYaCatalog, assetsDir: string) {
    this.catalog = catalog;
    this.assetsDir = assetsDir;
  }

  static async load(assetsDir = process.env.FIGUREYA_ASSETS_DIR ?? DEFAULT_ASSETS_DIR) {
    const raw = await fs.readFile(path.join(assetsDir, "catalog.json"), "utf8");
    const catalog: unknown = JSON.parse(raw);
    validateFigureYaCatalog(catalog);
    try {
      applyPreviewManifest(
        catalog,
        JSON.parse(await fs.readFile(path.join(assetsDir, PREVIEW_MANIFEST), "utf8")) as unknown,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // Legacy/external catalogs remain readable, but their unpinned previews
      // are deliberately unavailable until an identity manifest is supplied.
    }
    return new CatalogIndex(catalog, assetsDir);
  }

  private async loadPreview(module: FigureYaModule) {
    const previewPath = module.primaryPreview ?? module.thumbnail;
    if (!previewPath) return undefined;
    const identity = figureYaPreviewIdentity(module);
    if (!identity) throw new Error(`preview has no pinned SHA-256 identity for ${module.moduleId}`);
    if (!isMcpImagePath(previewPath)) {
      throw new Error(
        `preview format ${path.extname(previewPath) || "unknown"} cannot be returned as an MCP image`,
      );
    }
    const file = path.resolve(this.assetsDir, ...previewPath.split("/"));
    const relative = path.relative(path.resolve(this.assetsDir), file);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`unsafe preview path for ${module.moduleId}`);
    }
    let current = path.resolve(this.assetsDir);
    const parts = previewPath.split("/");
    for (const [index, part] of parts.entries()) {
      current = path.join(current, part);
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) {
        throw new Error(`preview path traverses a symbolic link for ${module.moduleId}`);
      }
      if (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile()) {
        throw new Error(`preview is not a regular file for ${module.moduleId}`);
      }
    }
    const bytes = new Uint8Array(await fs.readFile(file));
    const extension = path.extname(file).toLocaleLowerCase();
    const mimeType = previewMediaType(file);
    if (!mimeType || identity.mediaType !== mimeType) {
      throw new Error(`preview MIME identity disagrees with its path for ${module.moduleId}`);
    }
    if (
      bytes.byteLength !== identity.bytes ||
      createHash("sha256").update(bytes).digest("hex") !== identity.digest
    ) {
      throw new Error(`preview bytes disagree with the pinned SHA-256 identity for ${module.moduleId}`);
    }
    assertMcpImageBytes({ bytes, mimeType, extension });
    return { bytes, extension, mimeType };
  }

  async previewAvailable(module: FigureYaModule) {
    try {
      return Boolean(await this.loadPreview(module));
    } catch {
      return false;
    }
  }

  get(moduleId: string) {
    return this.catalog.modules.find((module) => module.moduleId === moduleId);
  }

  async search(request: SearchRequest): Promise<TemplateCandidate[]> {
    const limit = Math.min(Math.max(request.limit ?? 6, 1), 12);
    const intent = buildSearchIntent(request);
    const matches = this.catalog.modules
      .filter((module) => matchesFigureYaFilters(module, request))
      .map((module) => {
        const evidence = scoreSearchableTemplate(
          {
            templateId: module.moduleId,
            title: module.title,
            description: module.requirement,
            application: module.application,
            dataProfile: module.inputSummary,
            inputFiles: module.inputFiles,
            codeFiles: module.codeFiles,
            packages: module.packages,
          },
          intent,
        );
        return { module, evidence };
      })
      .filter(({ evidence }) => evidence.score > 0)
      .sort(
        (left, right) =>
          right.evidence.score - left.evidence.score ||
          left.module.moduleId.localeCompare(right.module.moduleId),
      )
      .slice(0, limit);
    return Promise.all(
      matches.map(async ({ module, evidence }) => {
        const warnings = [];
        if (module.inputFiles.length === 0) warnings.push("目录中未识别到示例输入文件");
        if (!module.archiveAvailable) warnings.push("固定版本压缩包不可用，将无法自动完整下载");
        if (module.archiveAvailable && !module.archiveSha256) {
          warnings.push("归档使用旧版 Git blob SHA-1 身份；获取后会计算并锁定 SHA-256");
        }
        const previewAvailable = await this.previewAvailable(module);
        if ((module.primaryPreview ?? module.thumbnail) && !previewAvailable) {
          warnings.push("目录声明的预览未通过路径、SHA-256、格式或图像结构完整性校验");
        }
        warnings.push("上游代码尚未经过本地审核，也未由 ScientificFigureLibrary 执行");
        const exactSelector = figureYaCandidateSelector(this.catalog, module, "template");
        return {
          templateId: module.moduleId,
          providerId: FIGUREYA_PROVIDER_ID,
          exactSelector,
          sourceLabel: "FigureYa",
          title: module.title,
          retrievalScore: evidence.score,
          matchedTerms: evidence.matchedTerms.slice(0, 12),
          reasons: evidence.reasons,
          warnings,
          excerpt: excerpt(module, evidence.matchedTerms),
          description: module.requirement,
          application: module.application,
          dataProfile: module.inputSummary,
          inputFiles: module.inputFiles,
          codeFiles: module.codeFiles,
          packages: module.packages,
          materializable: module.archiveAvailable,
          previewAvailable,
          previewRef: previewAvailable
            ? {
                schema: "figure-library.provider-preview-ref.v1" as const,
                providerId: FIGUREYA_PROVIDER_ID,
                exactSelector,
              }
            : undefined,
          assetKind: "plot_template" as const,
          language: figureYaLanguages(module)[0] ?? "none",
          plotFamily: figureYaFamilies(module)[0] ?? "",
          reviewStatus: "not_reviewed" as const,
          codeStatus: module.codeFiles.length ? ("provided" as const) : ("none" as const),
          executionStatus: "not_run" as const,
          upstreamStatus: module.archiveAvailable ? ("published" as const) : ("available" as const),
          license: "CC BY-NC-SA 4.0",
          sourceUrl: module.sourceUrl,
          reportUrl: module.reportUrl,
          management: {
            templateId: module.moduleId,
            canArchive: false,
            canUpdate: false,
          },
        };
      }),
    );
  }

  async preview(templateIdOrSelector: string | ExactTemplateSelector) {
    let templateId: string;
    if (typeof templateIdOrSelector === "string") {
      templateId = templateIdOrSelector;
    } else {
      assertExactTemplateSelector(templateIdOrSelector);
      if (templateIdOrSelector.providerId !== FIGUREYA_PROVIDER_ID) return;
      if (
        templateIdOrSelector.kind !== "figureya-module.v1" &&
        templateIdOrSelector.kind !== "figureya-source-module.v1"
      ) {
        return;
      }
      if (templateIdOrSelector.kind === "figureya-module.v1") {
        assertFigureYaExactSelector(templateIdOrSelector);
      } else {
        assertFigureYaSourceExactSelector(templateIdOrSelector);
      }
      const moduleId = templateIdOrSelector.identity.moduleId;
      const sourceCommit = templateIdOrSelector.identity.sourceCommit;
      if (typeof moduleId !== "string" || sourceCommit !== this.catalog.figureya.commit) return;
      templateId = moduleId;
      const selectedModule = this.get(templateId);
      if (!selectedModule) return;
      if (templateIdOrSelector.kind === "figureya-module.v1") {
        assertFigureYaSelectorMatches(
          templateIdOrSelector,
          this.catalog,
          selectedModule,
          templateIdOrSelector.identity.mode,
        );
      } else {
        assertFigureYaSourceSelectorMatches(
          templateIdOrSelector,
          this.catalog,
          selectedModule,
        );
      }
    }
    const module = this.get(templateId);
    if (!module) return;
    return this.loadPreview(module);
  }

  /**
   * Compatibility shim for older hosts.  It intentionally does not inline
   * image bytes; callers must preview one selected candidate explicitly.
   */
  async withPreviews(candidates: TemplateCandidate[]) {
    return candidates;
  }

}
