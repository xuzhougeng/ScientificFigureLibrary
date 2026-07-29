import fs from "node:fs/promises";
import path from "node:path";
import Fuse from "fuse.js";
import type {
  FigureYaCatalog,
  FigureYaModule,
  SearchRequest,
  TemplateCandidate,
} from "./types.ts";

const DEFAULT_ASSETS_DIR = path.resolve(import.meta.dirname, "..", "assets");

const ALIASES = [
  ["volcano", "火山图", "logfc", "fold change", "p value"],
  ["survival", "生存", "kaplan meier", "kaplan-meier", "km curve", "time status"],
  ["heatmap", "热图", "pheatmap", "complexheatmap"],
  ["pca", "principal component", "主成分"],
  ["roc", "auc", "receiver operating characteristic"],
  ["boxplot", "box plot", "箱线图", "箱图"],
  ["violin", "小提琴图"],
  ["scatter", "散点图"],
  ["barplot", "bar chart", "柱状图", "条形图"],
  ["bubble", "气泡图"],
  ["forest plot", "森林图", "hazard ratio", "hr"],
  ["venn", "韦恩图", "overlap"],
  ["circos", "circos plot", "圈图", "环形图"],
  ["sankey", "桑基图"],
  ["correlation", "相关性", "相关图"],
  ["network", "网络图", "interaction"],
  ["gsea", "enrichment", "富集分析", "富集图"],
  ["mutation", "突变", "oncoplot", "oncoprint"],
  ["single cell", "single-cell", "scrna", "单细胞"],
] as const;

export function normalizeSearchText(value: string): string {
  return value.toLocaleLowerCase().replace(/\s+/gu, " ").trim();
}

export function searchTerms(request: SearchRequest): string[] {
  const combined = [request.query, request.dataProfile, request.visualProfile]
    .filter(Boolean)
    .join(" ");
  const base = [
    normalizeSearchText(request.query),
    ...combined.match(/[\p{L}\p{N}_.+-]{2,}/gu)?.map(normalizeSearchText) ?? [],
  ].filter(Boolean);
  const expanded = new Set(base);
  const searchable = normalizeSearchText(combined);

  for (const group of ALIASES) {
    if (group.some((alias) => searchable.includes(normalizeSearchText(alias)))) {
      for (const alias of group) expanded.add(normalizeSearchText(alias));
    }
  }
  return [...expanded].slice(0, 80);
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

function evidence(module: FigureYaModule, terms: string[]) {
  const moduleName = normalizeSearchText(module.moduleId);
  const inputs = normalizeSearchText(module.inputFiles.join(" "));
  const packages = normalizeSearchText(module.packages.join(" "));
  const text = normalizeSearchText(module.fullText);
  const matchedTerms = terms.filter((term) =>
    `${moduleName} ${inputs} ${packages} ${text}`.includes(term),
  );
  const reasons = [];

  const nameMatches = matchedTerms.filter((term) => moduleName.includes(term));
  if (nameMatches.length) reasons.push(`模块名匹配：${nameMatches.slice(0, 3).join("、")}`);
  const inputMatches = matchedTerms.filter((term) => inputs.includes(term));
  if (inputMatches.length) reasons.push(`输入示例匹配：${inputMatches.slice(0, 3).join("、")}`);
  const packageMatches = matchedTerms.filter((term) => packages.includes(term));
  if (packageMatches.length) reasons.push(`R/Python 包匹配：${packageMatches.slice(0, 3).join("、")}`);
  if (reasons.length < 2 && matchedTerms.length) {
    reasons.push(`全文说明匹配：${matchedTerms.slice(0, 5).join("、")}`);
  }

  const warnings = [];
  if (module.inputFiles.length === 0) warnings.push("目录中未识别到示例输入文件");
  if (!module.archiveAvailable) warnings.push("固定版本压缩包不可用，将无法自动完整下载");
  return {
    matchedTerms: matchedTerms.slice(0, 12),
    reasons: reasons.slice(0, 3),
    warnings,
  };
}

export class CatalogIndex {
  readonly catalog: FigureYaCatalog;
  readonly assetsDir: string;
  private readonly fuse: Fuse<FigureYaModule>;

  private constructor(catalog: FigureYaCatalog, assetsDir: string) {
    this.catalog = catalog;
    this.assetsDir = assetsDir;
    this.fuse = new Fuse(catalog.modules, {
      includeScore: true,
      ignoreLocation: true,
      minMatchCharLength: 2,
      threshold: 0.48,
      keys: [
        { name: "moduleId", weight: 4 },
        { name: "title", weight: 3 },
        { name: "requirement", weight: 2 },
        { name: "application", weight: 1.5 },
        { name: "inputSummary", weight: 1.5 },
        { name: "inputFiles", weight: 1.5 },
        { name: "packages", weight: 1 },
      ],
    });
  }

  static async load(assetsDir = process.env.FIGUREYA_ASSETS_DIR ?? DEFAULT_ASSETS_DIR) {
    const raw = await fs.readFile(path.join(assetsDir, "catalog.json"), "utf8");
    const catalog = JSON.parse(raw) as FigureYaCatalog;
    if (catalog.schema !== "figure-library.figureya-catalog.v1") {
      throw new Error(`unsupported catalog schema: ${catalog.schema}`);
    }
    return new CatalogIndex(catalog, assetsDir);
  }

  get(moduleId: string) {
    return this.catalog.modules.find((module) => module.moduleId === moduleId);
  }

  search(request: SearchRequest): TemplateCandidate[] {
    const limit = Math.min(Math.max(request.limit ?? 6, 1), 12);
    const terms = searchTerms(request);
    const scores = new Map<string, number>();
    const modules = new Map<string, FigureYaModule>();

    terms.forEach((term, termIndex) => {
      const weight = termIndex === 0 ? 3 : 1;
      this.fuse.search(term, { limit: Math.max(60, limit * 10) }).forEach((result, rank) => {
        const score = (1 - (result.score ?? 1)) * weight / (1 + rank / 20);
        scores.set(result.item.moduleId, (scores.get(result.item.moduleId) ?? 0) + score);
        modules.set(result.item.moduleId, result.item);
      });
    });

    // Exact metadata and report matches should never disappear behind fuzzy ranking.
    for (const module of this.catalog.modules) {
      const direct = normalizeSearchText(
        `${module.moduleId} ${module.title} ${module.inputFiles.join(" ")} ${module.packages.join(" ")}`,
      );
      const exact = terms.filter((term) => direct.includes(term)).length;
      const report = normalizeSearchText(module.fullText);
      const reportExact = terms.filter((term) => report.includes(term)).length;
      if (exact || reportExact) {
        scores.set(
          module.moduleId,
          (scores.get(module.moduleId) ?? 0) + exact * 2 + reportExact * 0.2,
        );
        modules.set(module.moduleId, module);
      }
    }

    const ranked = [...modules.values()]
      .sort(
        (left, right) =>
          (scores.get(right.moduleId) ?? 0) - (scores.get(left.moduleId) ?? 0) ||
          left.moduleId.localeCompare(right.moduleId),
      )
      .slice(0, limit);
    const topScore = Math.max(scores.get(ranked[0]?.moduleId ?? "") ?? 1, 0.0001);

    return ranked.map((module) => {
      const found = evidence(module, terms);
      return {
        templateId: module.moduleId,
        sourceId: "figureya",
        sourceLabel: "FigureYa",
        title: module.title,
        relevance: Math.round(((scores.get(module.moduleId) ?? 0) / topScore) * 100),
        ...found,
        excerpt: excerpt(module, found.matchedTerms),
        description: module.requirement,
        application: module.application,
        dataProfile: module.inputSummary,
        inputFiles: module.inputFiles,
        codeFiles: module.codeFiles,
        packages: module.packages,
        materializable: module.archiveAvailable,
        license: "CC BY-NC-SA 4.0",
        sourceUrl: module.sourceUrl,
        reportUrl: module.reportUrl,
      };
    });
  }

  async withPreviews(candidates: TemplateCandidate[]) {
    return Promise.all(
      candidates.map(async (candidate) => {
        const module = this.get(candidate.templateId);
        if (!module?.thumbnail) return candidate;
        try {
          const bytes = await fs.readFile(path.join(this.assetsDir, module.thumbnail));
          return {
            ...candidate,
            previewDataUrl: `data:image/webp;base64,${bytes.toString("base64")}`,
          };
        } catch {
          return candidate;
        }
      }),
    );
  }
}
