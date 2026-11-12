import assert from "node:assert/strict";
import test from "node:test";
import { buildSearchIntent, CatalogIndex, normalizeSearchText, scoreSearchableTemplate } from "../src/catalog.ts";
import { ModuleCatalogIndex } from "../src/module-catalog.ts";
import { correctSearchTypos, SEARCH_CONCEPTS } from "../src/search-vocabulary.ts";
import { DOMAIN_IDS } from "../src/domains.ts";
import { PLOT_FAMILY_GROUP_IDS } from "../src/plot-family-groups.ts";

const figureYa = await CatalogIndex.load();
const modules = await ModuleCatalogIndex.load();

async function topIds(query: string, count: number) {
  const hits = [
    ...(await figureYa.searchAll({ query })).map((hit) => ({ id: hit.templateId, score: hit.retrievalScore })),
    ...(await modules.searchAll({ query })).map((hit) => ({ id: hit.templateId, score: hit.retrievalScore })),
  ];
  return hits.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id)).slice(0, count).map((hit) => hit.id);
}

/**
 * Bilingual queries against the bundled FigureYa and Open Figure catalogs:
 * [query, a pattern at least one of the top-N template IDs must match, N].
 * The set covers plain names, synonyms that appear in no template text,
 * compound Chinese phrases, full-width input and misspellings.
 */
const CASES: Array<[string, RegExp, number]> = [
  ["火山图", /volcano/iu, 3],
  ["生存曲线", /surv/iu, 3],
  ["单细胞热图", /206scHeatmap|232scRankHeatmap|243scMarkerGroupHeatmap|269scMetabolism/u, 5],
  ["空转", /239ST_PDAC|323STpathseq|spatial/iu, 5],
  ["空间转录组", /239ST_PDAC|323STpathseq|spatial/iu, 5],
  ["桑基图", /sankey/iu, 3],
  ["山峦图", /ridge|306slingshot/iu, 5],
  ["棒棒糖图", /lollipop/iu, 3],
  ["韦恩图", /venn/iu, 3],
  ["细胞比例堆叠柱状图", /sc-celltype.*(stacked|proportion)|290BarGraph|224scMarker/iu, 5],
  ["列线图", /nomogram/iu, 3],
  ["瀑布图", /oncoplot|oncoprint|MutLandscape|MutualExclusivity/iu, 5],
  ["相关性热图", /126CorrelationHeatmap|97correlationV3|127HeatmapPie|230immunelandscape|115cofactor/u, 5],
  ["富集分析气泡图", /11bubble|52GOplot|209batchEnrich|go-enrichment|253panGSEA|279panGeneGSEA/iu, 5],
  ["小提琴图", /violin/iu, 3],
  ["弦图", /Chord|circos|37correlation|26circos/iu, 5],
  ["森林图", /forest|6rHRs|90subgroup|216MetaREM|193RiskTable/iu, 3],
  ["ROC曲线", /ROC/u, 3],
  ["曼哈顿图", /Manhattan/iu, 3],
  ["云雨图", /68friends/iu, 5],
  ["泳道图", /swimmer/iu, 3],
  ["雷达图", /radar/iu, 3],
  ["进化树", /ggtree|80GOclustering|88DAVIDkappa|148SimpleDendrogram/iu, 5],
  ["拟时序", /285scRNA_monocle|306slingshot|177RNAvelocity/u, 5],
  ["细胞通讯", /267scCellChat|310CPDBChordGram|178receptorLigand|272scBulkCCCI/u, 5],
  ["校准曲线", /Calibration|30nomogram|225GiViTl/iu, 5],
  ["决策曲线", /33DCA/u, 3],
  ["降维图", /umap|tsne|pca/iu, 3],
  ["ＵＭＡＰ", /umap/iu, 3],
  ["volcano plot", /volcano/iu, 3],
  ["kaplan meier", /surv/iu, 3],
  ["ridgeline", /ridge|306slingshot/iu, 5],
  ["stacked bar cell proportion", /sc-celltype.*(stacked|proportion)|290BarGraph/iu, 5],
  ["oncoprint", /oncoprint|oncoplot|MutLandscape/iu, 3],
  ["spatial transcriptomics", /239ST_PDAC|323STpathseq|spatial/iu, 5],
  ["marker dotplot", /sc-marker-dotplot|317RoeDot|318GenesetDEDotplot|224scMarker/iu, 5],
  ["umap density", /umap-style-density/iu, 3],
  ["volcanoe", /volcano/iu, 3],
  ["heatmpa", /heatmap/iu, 3],
  ["sanky diagram", /sankey/iu, 3],
  ["nomogram", /nomogram/iu, 3],
  ["cell-cell communication", /267scCellChat|310CPDBChordGram|178receptorLigand|272scBulkCCCI/u, 5],
];

test("bilingual, synonym and misspelt queries find an expected template near the top", async () => {
  const missed: string[] = [];
  for (const [query, pattern, count] of CASES) {
    const top = await topIds(query, count);
    if (!top.some((id) => pattern.test(id))) missed.push(`${query} -> ${top.join(", ") || "(no hits)"}`);
  }
  assert.deepEqual(missed, []);
});

test("every vocabulary concept names a declared group or domain", () => {
  for (const concept of SEARCH_CONCEPTS) {
    assert.ok(concept.group || concept.domain, concept.aliases[0]);
    if (concept.group) assert.ok((PLOT_FAMILY_GROUP_IDS as readonly string[]).includes(concept.group), concept.group);
    if (concept.domain) assert.ok((DOMAIN_IDS as readonly string[]).includes(concept.domain), concept.domain);
    assert.equal(new Set(concept.aliases).size, concept.aliases.length, concept.aliases[0]);
  }
});

test("a query that names a concept gains its other names, its group and its domain", () => {
  const intent = buildSearchIntent({ query: "细胞通讯" });
  assert.deepEqual(intent.groups, ["network"]);
  assert.deepEqual(intent.domains, ["single_cell"]);
  assert.ok(intent.terms.some((term) => term.value === "cellchat" && !term.weak));
  const spatial = buildSearchIntent({ query: "空转" });
  assert.deepEqual(spatial.domains, ["spatial"]);
  assert.ok(spatial.terms.some((term) => term.value === "spatial transcriptomics"));
  // A volcano plot is drawn with points; naming it must not also ask for scatter plots.
  assert.equal(buildSearchIntent({ query: "volcano scatter" }).groups.includes("scatter"), false);
});

test("full-width input is folded and misspelt figure names are corrected conservatively", () => {
  assert.equal(normalizeSearchText("ＵＭＡＰ　Ｐｌｏｔ"), "umap plot");
  assert.equal(correctSearchTypos("volcanoe plot"), "volcano plot");
  assert.equal(correctSearchTypos("heatmpa"), "heatmap");
  assert.equal(correctSearchTypos("sanky diagram"), "sankey diagram");
  assert.equal(correctSearchTypos("heatmaps"), "heatmap");
  // Ordinary words, short words and words already in the vocabulary are left alone.
  assert.equal(correctSearchTypos("stable gene table"), "stable gene table");
  assert.equal(correctSearchTypos("violin network"), "violin network");
  assert.equal(correctSearchTypos("expression matrix"), "expression matrix");
});

test("two-character slices of a long Chinese phrase count only when at least two of them match", () => {
  const intent = buildSearchIntent({ query: "免疫浸润评分箱线" });
  const weak = intent.terms.filter((term) => term.weak).map((term) => term.value);
  assert.ok(weak.includes("浸润") && weak.includes("评分"), weak.join(","));
  const base = { templateId: "t", title: "t", application: "", dataProfile: "", inputFiles: [], codeFiles: [], packages: [] };
  const plain = buildSearchIntent({ query: "肿瘤纯度评分变化" });
  assert.equal(scoreSearchableTemplate({ ...base, description: "只提到评分这一个词" }, plain).score, 0);
  assert.ok(scoreSearchableTemplate({ ...base, description: "肿瘤样本的纯度评分" }, plain).score > 0);
});

test("a declared group outranks a family word inside an identifier, and a serial number is not a variant", async () => {
  // FigureYa47HRtable matches the forest family by ID only; real forest plots are declared as such.
  const forest = await topIds("森林图", 3);
  assert.ok(forest.indexOf("FigureYa90subgroup") >= 0, forest.join(", "));
  assert.equal(forest.includes("FigureYa47HRtable"), false, forest.join(", "));
  // "33" + "DCA" spells "3d"; the module is not a three-dimensional variant.
  const dca = (await figureYa.searchAll({ query: "DCA" })).find((hit) => hit.templateId === "FigureYa33DCA_update")!;
  assert.equal(dca.reasons.some((reason) => reason.includes("三维")), false, dca.reasons.join(" | "));
  const pca3d = (await figureYa.searchAll({ query: "PCA" })).find((hit) => hit.templateId === "FigureYa164PCA3D")!;
  assert.ok(pca3d.reasons.some((reason) => reason.includes("三维")), pca3d.reasons.join(" | "));
});
