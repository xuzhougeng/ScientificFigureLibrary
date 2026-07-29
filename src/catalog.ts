import fs from "node:fs/promises";
import path from "node:path";
import type {
  FigureYaCatalog,
  FigureYaModule,
  SearchRequest,
  TemplateCandidate,
} from "./types.ts";

const DEFAULT_ASSETS_DIR = path.resolve(import.meta.dirname, "..", "assets");

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

export class CatalogIndex {
  readonly catalog: FigureYaCatalog;
  readonly assetsDir: string;

  private constructor(catalog: FigureYaCatalog, assetsDir: string) {
    this.catalog = catalog;
    this.assetsDir = assetsDir;
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
    const intent = buildSearchIntent(request);
    return this.catalog.modules
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
      .slice(0, limit)
      .map(({ module, evidence }) => {
        const warnings = [];
        if (module.inputFiles.length === 0) warnings.push("目录中未识别到示例输入文件");
        if (!module.archiveAvailable) warnings.push("固定版本压缩包不可用，将无法自动完整下载");
        return {
          templateId: module.moduleId,
          sourceId: "figureya",
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
          previewAvailable: Boolean(module.thumbnail),
          license: "CC BY-NC-SA 4.0",
          sourceUrl: module.sourceUrl,
          reportUrl: module.reportUrl,
        };
      });
  }

  async preview(templateId: string) {
    const module = this.get(templateId);
    if (!module?.thumbnail) return;
    const file = path.join(this.assetsDir, module.thumbnail);
    return {
      bytes: new Uint8Array(await fs.readFile(file)),
      extension: path.extname(file).toLocaleLowerCase(),
      mimeType: "image/webp",
    };
  }

  async withPreviews(candidates: TemplateCandidate[]) {
    return Promise.all(
      candidates.map(async (candidate) => {
        try {
          const preview = await this.preview(candidate.templateId);
          if (!preview) return candidate;
          return {
            ...candidate,
            previewDataUrl: `data:${preview.mimeType};base64,${Buffer.from(preview.bytes).toString("base64")}`,
          };
        } catch {
          return candidate;
        }
      }),
    );
  }
}
