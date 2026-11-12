/**
 * Canonical figure-type groups for catalog facets and filters.
 *
 * Providers keep their own free-text `plotFamily` (Open Figure Modules alone
 * uses 70+ spellings and many FigureYa modules have none). Grouping is a
 * read-only projection: it never rewrites stored metadata, selectors or the
 * keyword search filters, and an unmatched value falls back to `other`.
 *
 * An entry may belong to several groups (a heatmap with an enrichment panel);
 * the first group is its primary one. `kind` separates figure forms from the
 * four analysis themes, whose members draw many different forms.
 */
export const PLOT_FAMILY_GROUPS = [
  { id: "embedding", kind: "form", label: "降维图", labelEn: "embedding (PCA/UMAP/tSNE)" },
  { id: "volcano", kind: "form", label: "火山图", labelEn: "volcano plot" },
  { id: "set_overlap", kind: "form", label: "集合交集图", labelEn: "set overlap (Venn/UpSet)" },
  { id: "flow", kind: "form", label: "流向图", labelEn: "flow (Sankey/alluvial)" },
  { id: "tree", kind: "form", label: "树与层级图", labelEn: "tree and hierarchy" },
  { id: "genome", kind: "theme", label: "基因组与突变图", labelEn: "genome and mutation" },
  { id: "survival", kind: "theme", label: "生存与预后图", labelEn: "survival and prognosis" },
  { id: "roc", kind: "theme", label: "ROC 与诊断图", labelEn: "ROC and diagnostics" },
  { id: "forest", kind: "form", label: "森林图", labelEn: "forest plot" },
  { id: "timeline", kind: "form", label: "时间线图", labelEn: "timeline (Gantt/swimmer)" },
  { id: "dot_range", kind: "form", label: "点距图", labelEn: "dumbbell and lollipop" },
  { id: "radar", kind: "form", label: "雷达图", labelEn: "radar chart" },
  { id: "distribution", kind: "form", label: "分布图", labelEn: "distribution (histogram/density/ridgeline)" },
  { id: "proportion", kind: "form", label: "比例构成图", labelEn: "proportion (stacked/percent/pie)" },
  { id: "heatmap", kind: "form", label: "热图", labelEn: "heatmap" },
  { id: "enrichment", kind: "theme", label: "富集分析图", labelEn: "enrichment" },
  { id: "correlation", kind: "form", label: "相关性图", labelEn: "correlation" },
  { id: "network", kind: "form", label: "网络与互作图", labelEn: "network and interaction" },
  { id: "circular", kind: "form", label: "环形图", labelEn: "circular (Circos/radial)" },
  { id: "violin", kind: "form", label: "小提琴图", labelEn: "violin plot" },
  { id: "boxplot", kind: "form", label: "箱线图", labelEn: "boxplot" },
  { id: "bubble", kind: "form", label: "气泡与点图", labelEn: "bubble and dot plot" },
  { id: "bar", kind: "form", label: "柱状图", labelEn: "bar chart" },
  { id: "scatter", kind: "form", label: "散点图", labelEn: "scatter plot" },
  { id: "line", kind: "form", label: "折线图", labelEn: "line chart" },
  { id: "table", kind: "form", label: "表格", labelEn: "table" },
  { id: "combo", kind: "form", label: "组合图", labelEn: "multi-panel combination" },
  { id: "other", kind: "form", label: "其他", labelEn: "other" },
  { id: "unclassified", kind: "form", label: "未分类", labelEn: "unclassified" },
] as const;
export type PlotFamilyGroup = (typeof PLOT_FAMILY_GROUPS)[number]["id"];
export const PLOT_FAMILY_GROUP_IDS = PLOT_FAMILY_GROUPS.map((group) => group.id) as [PlotFamilyGroup, ...PlotFamilyGroup[]];

// Ordered: the first match wins, so specific forms precede generic ones
// (ridgeline_heatmap is a distribution, enrichment_bar is enrichment).
const RULES: Array<[Exclude<PlotFamilyGroup, "other" | "unclassified">, RegExp]> = [
  ["embedding", /\b(umap|tsne|t sne|pca|embedding|dimensionality)\b/u],
  ["volcano", /\bvolcano\b/u],
  ["set_overlap", /\b(venn|upset)\b/u],
  ["flow", /\b(sankey|alluvial)\b/u],
  ["tree", /\b(ggtree|phylo\w*|tree|dendrogram|hierarch\w*|sunburst)\b/u],
  ["genome", /\b(manhattan|ideogram|chromosome\w*|oncoplot|waterfall|mut\w*)\b/u],
  ["survival", /\b(survival|surv|km|kaplan|prognos\w*|risk|nomogram)\b/u],
  ["roc", /\b(roc|auc)\b/u],
  ["forest", /\bforest\b/u],
  ["timeline", /\b(gantt|swimmer\w*|timeline)\b/u],
  ["dot_range", /\b(dumbbell|lollipop)\b/u],
  ["radar", /\bradar\b/u],
  ["distribution", /\b(ridgeline|ridge|density|histogram|distribution|raincloud|raindrop)\b/u],
  ["proportion", /\b(polar|rose|pie|stacked|percent|proportion|area|mosaic\w*)\b/u],
  ["heatmap", /\b(heatmap|heatmaps|matrix)\b/u],
  ["enrichment", /\b(enrichment|enrich|gsea|gsva|nes|kegg|go)\b/u],
  ["correlation", /\b(correlation|corr\w*|mantel)\b/u],
  ["network", /\b(network|interaction|chord)\b/u],
  ["circular", /\b(circos|circular|radial|circle)\b/u],
  ["violin", /\bviolin\b/u],
  ["boxplot", /\b(boxplot|box)\b/u],
  ["bubble", /\b(bubble|dotplot)\b/u],
  ["bar", /\b(bar|barplot|barchart)\b/u],
  ["scatter", /\b(scatter|scatterplot)\b/u],
  ["line", /\bline\b/u],
  ["table", /\btable\b/u],
  ["combo", /\b(combo|combination|multipanel)\b/u],
];

/** Split camelCase, digits and separators so `FigureYa102multipanelROC` yields `figure ya 102 multipanel roc`. */
export function familyWords(value: string) {
  return value
    .replace(/([a-z])([A-Z])/gu, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/gu, "$1 $2")
    .replace(/([A-Za-z])(?=\d)|(\d)(?=[A-Za-z])/gu, "$1$2 ")
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/gu, " ")
    .trim();
}

function matchGroups(value: string): PlotFamilyGroup[] {
  const words = familyWords(value);
  if (!words) return [];
  return RULES.filter(([, pattern]) => pattern.test(words)).map(([group]) => group);
}

const KNOWN_GROUPS = new Set<string>(PLOT_FAMILY_GROUP_IDS);

export function isPlotFamilyGroup(value: unknown): value is PlotFamilyGroup {
  return typeof value === "string" && KNOWN_GROUPS.has(value);
}

export interface PlotFamilyGroupSource {
  plotFamily?: string;
  templateId?: string;
  titleEn?: string;
  /** Explicit groups from Provider metadata or a curated taxonomy; they win over every rule. */
  familyGroups?: readonly string[];
}

/**
 * Every group a template belongs to, primary first. Explicit `familyGroups`
 * are authoritative. Otherwise the stored `plotFamily` is matched against the
 * rules; when that is empty or only a domain label (for example FigureYa's
 * `single-cell`), hints in the template ID and English title are used.
 */
export function plotFamilyGroups(candidate: PlotFamilyGroupSource): PlotFamilyGroup[] {
  const explicit = [...new Set((candidate.familyGroups ?? []).filter(isPlotFamilyGroup))];
  if (explicit.length) return explicit;
  const fromFamily = matchGroups(candidate.plotFamily ?? "");
  if (fromFamily.length) return fromFamily;
  const fromHints = matchGroups(`${candidate.templateId ?? ""} ${candidate.titleEn ?? ""}`);
  if (fromHints.length) return fromHints;
  return [candidate.plotFamily?.trim() ? "other" : "unclassified"];
}

/** Primary group of a template; see `plotFamilyGroups`. */
export function plotFamilyGroup(candidate: PlotFamilyGroupSource): PlotFamilyGroup {
  return plotFamilyGroups(candidate)[0]!;
}

export function inPlotFamilyGroup(candidate: PlotFamilyGroupSource, group: PlotFamilyGroup) {
  return plotFamilyGroups(candidate).includes(group);
}
