/**
 * Bilingual search vocabulary shared by keyword search and the catalog facets.
 *
 * A concept is one thing a user may name in several ways ("山峦图", "ridgeline",
 * "joyplot"). When a query names a concept, its other aliases become search
 * terms, and the concept's figure-type group and research domain are matched
 * against the groups and domains an entry declares. Aliases are deliberately
 * specific: a broad word here would make unrelated entries match.
 */
import type { DomainId } from "./domains.ts";
import type { PlotFamilyGroup } from "./plot-family-groups.ts";

export interface SearchConcept {
  aliases: readonly string[];
  group?: PlotFamilyGroup;
  domain?: DomainId;
}

export const SEARCH_CONCEPTS: readonly SearchConcept[] = [
  // Figure forms.
  { group: "embedding", aliases: ["降维图", "降维", "umap", "tsne", "t-sne", "pca", "主成分", "pcoa"] },
  { group: "volcano", aliases: ["火山图", "volcano"] },
  { group: "set_overlap", aliases: ["韦恩图", "维恩图", "venn", "upset", "交集图"] },
  { group: "flow", aliases: ["桑基图", "冲积图", "sankey", "alluvial"] },
  { group: "tree", aliases: ["进化树", "系统发育树", "树状图", "聚类树", "dendrogram", "phylogenetic tree", "ggtree"] },
  { group: "forest", aliases: ["森林图", "forest plot", "forestplot"] },
  { group: "timeline", aliases: ["泳道图", "游泳图", "泳图", "swimmer", "swimmer plot", "甘特图", "gantt"] },
  { group: "dot_range", aliases: ["棒棒糖图", "棒棒糖", "lollipop"] },
  { group: "dot_range", aliases: ["哑铃图", "dumbbell"] },
  { group: "radar", aliases: ["雷达图", "蜘蛛图", "radar", "spider chart"] },
  { group: "distribution", aliases: ["山峦图", "山脊图", "岭图", "峰峦图", "ridgeline", "ridge", "joyplot", "ggridges"] },
  { group: "distribution", aliases: ["云雨图", "raincloud", "rain cloud"] },
  { group: "distribution", aliases: ["密度图", "直方图", "density plot", "histogram"] },
  { group: "proportion", aliases: ["堆叠", "堆积", "stacked"] },
  { group: "proportion", aliases: ["饼图", "扇形图", "玫瑰图", "南丁格尔", "pie chart", "nightingale", "rose chart"] },
  { group: "proportion", aliases: ["比例图", "占比", "构成比", "proportion", "composition"] },
  { group: "heatmap", aliases: ["热图", "heatmap", "pheatmap", "complexheatmap"] },
  { group: "correlation", aliases: ["相关性", "相关图", "correlation", "corrplot"] },
  { group: "network", aliases: ["网络图", "互作网络", "network"] },
  { group: "network", aliases: ["弦图", "chord", "chord diagram"] },
  { group: "circular", aliases: ["圈图", "环形图", "圆圈图", "circos", "circlize"] },
  { group: "violin", aliases: ["小提琴图", "violin"] },
  { group: "boxplot", aliases: ["箱线图", "箱图", "盒须图", "boxplot", "box plot"] },
  { group: "bubble", aliases: ["气泡图", "泡泡图", "bubble", "bubble plot"] },
  { group: "bubble", aliases: ["点图", "dotplot", "dot plot"] },
  { group: "bar", aliases: ["柱状图", "条形图", "柱形图", "barplot", "bar chart"] },
  { group: "scatter", aliases: ["散点图", "scatter", "scatter plot"] },
  { group: "line", aliases: ["折线图", "line chart"] },
  { group: "table", aliases: ["三线表", "表格"] },
  // Analysis themes.
  { group: "survival", aliases: ["生存曲线", "生存分析", "km曲线", "kaplan meier", "kaplan-meier", "survival"] },
  { group: "survival", aliases: ["列线图", "诺莫图", "nomogram"] },
  { group: "roc", aliases: ["roc", "roc曲线", "auc"] },
  { group: "roc", aliases: ["校准曲线", "calibration", "calibration curve"] },
  { group: "roc", aliases: ["决策曲线", "dca", "decision curve"] },
  { group: "genome", aliases: ["瀑布图", "突变景观", "oncoplot", "oncoprint"] },
  { group: "genome", aliases: ["曼哈顿图", "manhattan"] },
  { group: "enrichment", aliases: ["富集分析", "富集图", "富集", "enrichment", "gsea"] },
  // Research domains.
  { domain: "single_cell", aliases: ["单细胞", "single cell", "single-cell", "scrna", "scrna-seq", "scrnaseq"] },
  { domain: "spatial", aliases: ["空转", "空间转录组", "空间组学", "spatial transcriptomics", "spatial", "visium"] },
  { domain: "genomic_variation", aliases: ["突变", "拷贝数", "基因组变异", "mutation", "cnv", "snv"] },
  { domain: "epigenomics", aliases: ["甲基化", "表观", "methylation", "atac-seq", "chip-seq"] },
  { domain: "immune_microenvironment", aliases: ["免疫浸润", "免疫微环境", "immune infiltration", "tumor microenvironment"] },
  { domain: "clinical_prognosis", aliases: ["预后", "prognosis", "prognostic"] },
  { domain: "microbiome_evolution", aliases: ["菌群", "微生物组", "microbiome"] },
  { domain: "other_omics", aliases: ["代谢组", "蛋白组", "药物敏感", "metabolomics", "proteomics", "drug sensitivity"] },
  // Concepts that name both a form and a field.
  { group: "network", domain: "single_cell", aliases: ["细胞通讯", "细胞互作", "细胞沟通", "配体受体", "cell-cell communication", "cell communication", "cellchat", "cellphonedb", "ligand receptor"] },
  { group: "embedding", domain: "single_cell", aliases: ["拟时序", "拟时间", "伪时间", "pseudotime", "trajectory", "monocle", "slingshot"] },
  { group: "proportion", domain: "single_cell", aliases: ["细胞比例", "细胞占比", "细胞组成", "cell proportion", "cell composition", "celltype proportion"] },
];

/** Single ASCII words (six letters or more) that a misspelt query word may be corrected to. */
const CORRECTION_TARGETS = [...new Set(
  SEARCH_CONCEPTS.flatMap((concept) => concept.aliases).filter((alias) => /^[a-z]{6,}$/u.test(alias)),
)];

/** True when the two words differ by one insertion, deletion, substitution or adjacent transposition. */
function oneEditApart(left: string, right: string) {
  if (left === right || Math.abs(left.length - right.length) > 1) return false;
  let start = 0;
  while (start < left.length && start < right.length && left[start] === right[start]) start += 1;
  let endLeft = left.length;
  let endRight = right.length;
  while (endLeft > start && endRight > start && left[endLeft - 1] === right[endRight - 1]) {
    endLeft -= 1;
    endRight -= 1;
  }
  const restLeft = left.slice(start, endLeft);
  const restRight = right.slice(start, endRight);
  if (restLeft.length + restRight.length === 1) return true;
  if (restLeft.length === 1 && restRight.length === 1) return true;
  return restLeft.length === 2 && restRight.length === 2 && restLeft[0] === restRight[1] && restLeft[1] === restRight[0];
}

/**
 * Replace misspelt figure names in an already normalized query ("volcanoe",
 * "heatmpa", "sanky"). A word is corrected only when it is not itself in the
 * vocabulary and exactly one vocabulary word is a single edit away, so an
 * ordinary word is never rewritten into a figure name by coincidence of two
 * candidates, and short words are left alone.
 */
export function correctSearchTypos(normalizedQuery: string) {
  return normalizedQuery.replace(/[a-z]{5,}/gu, (word) => {
    if (CORRECTION_TARGETS.includes(word)) return word;
    // Plurals are handled by ordinary matching; do not "correct" them.
    if (word.endsWith("s") && CORRECTION_TARGETS.includes(word.slice(0, -1))) return word.slice(0, -1);
    const candidates = CORRECTION_TARGETS.filter((target) => oneEditApart(word, target));
    return candidates.length === 1 ? candidates[0]! : word;
  });
}
