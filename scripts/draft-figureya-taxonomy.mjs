#!/usr/bin/env node
/**
 * Draft the FigureYa taxonomy (figure-type groups and research domains) from
 * the plotting calls and packages found in each module's bundled text.
 *
 * The script only reads `assets/catalog.json`; it never downloads or executes
 * template code. Entries already marked `"basis": "manual"` in
 * `assets/figureya-taxonomy.json` are reviewed decisions and are kept as is.
 *
 *   node scripts/draft-figureya-taxonomy.mjs                 # summary only
 *   node scripts/draft-figureya-taxonomy.mjs --report <file> # evidence table (Markdown)
 *   node scripts/draft-figureya-taxonomy.mjs --write         # update the asset
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DOMAIN_IDS } from "../src/domains.ts";
import { PLOT_FAMILY_GROUPS, PLOT_FAMILY_GROUP_IDS, plotFamilyGroups } from "../src/plot-family-groups.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CATALOG = path.join(root, "assets", "catalog.json");
const TAXONOMY = path.join(root, "assets", "figureya-taxonomy.json");
export const TAXONOMY_SCHEMA = "figure-library.figureya-taxonomy.v1";

const THEMES = new Set(PLOT_FAMILY_GROUPS.filter((group) => group.kind === "theme").map((group) => group.id));

/** Plotting calls that identify a figure form or analysis theme. `weight` 3 = specific, 1 = generic. */
const FORM_CALLS = [
  ["heatmap", 3, ["pheatmap", "Heatmap", "heatmap.2", "aheatmap", "DoHeatmap", "ggheatmap", "heatmap", "circos.heatmap", "oncoPrint"]],
  ["heatmap", 2, ["geom_tile", "geom_raster"]],
  ["survival", 3, ["ggsurvplot", "survfit", "coxph", "cph", "nomogram", "ggadjustedcurves", "cuminc", "survdiff", "surv_cutpoint"]],
  ["roc", 3, ["roc", "plot.roc", "ggroc", "timeROC", "survivalROC", "calibrate", "decision_curve", "plot_decision_curve", "dca", "val.prob"]],
  ["forest", 3, ["forestplot", "ggforest", "forest"]],
  ["boxplot", 3, ["geom_boxplot", "ggboxplot", "boxplot"]],
  ["violin", 3, ["geom_violin", "ggviolin", "VlnPlot", "geom_split_violin", "geom_flat_violin", "vioplot", "geom_half_violin"]],
  ["bar", 2, ["geom_bar", "geom_col", "ggbarplot", "barplot", "geom_col_pattern"]],
  ["scatter", 1, ["geom_point", "ggscatter", "geom_jitter"]],
  ["bubble", 3, ["DotPlot", "dotplot", "GOBubble", "geom_scatterpie", "ggballoonplot"]],
  ["line", 2, ["geom_line", "geom_step", "ggline", "matplot", "geom_path"]],
  ["distribution", 3, ["geom_density", "geom_histogram", "hist", "ggdensity", "geom_density_ridges", "RidgePlot", "ridgeplot", "stat_ecdf", "geom_density_2d", "geom_dotplot", "gghistogram"]],
  ["circular", 3, ["circos.initialize", "circos.track", "circos.trackPlotRegion", "circos.link", "circos.rect", "circos.points", "circos.lines", "circos.text", "circos.genomicTrack", "GOCircle", "geom_conn_bundle"]],
  ["network", 3, ["chordDiagram", "ggraph", "plot.igraph", "cnetplot", "emapplot", "visNetwork", "geom_edge_diagonal", "geom_edge_link", "geom_node_point", "netVisual_circle", "netVisual_bubble", "GOChord", "tkplot"]],
  ["genome", 3, ["oncoplot", "oncoPrint", "lollipopPlot", "plotKaryotype", "kpPlotRegions", "kpPlotMarkers", "kpPlotDensity", "plotTracks", "CMplot", "manhattan", "waterfall", "plotmafSummary", "titv", "plotTiTv", "somaticInteractions", "rainfallPlot", "plotSignatures", "ggbio"]],
  ["embedding", 3, ["DimPlot", "FeaturePlot", "UMAPPlot", "TSNEPlot", "Rtsne", "umap", "RunUMAP", "RunTSNE", "prcomp", "PCA", "fviz_pca_ind", "plotPCA", "plot_cells", "geom_ord_ellipse"]],
  ["volcano", 3, ["EnhancedVolcano"]],
  ["set_overlap", 3, ["upset", "venn.diagram", "ggvenn", "venn", "ggVennDiagram", "draw.pairwise.venn", "draw.triple.venn", "venneuler"]],
  ["flow", 3, ["geom_alluvium", "geom_flow", "geom_stratum", "sankeyNetwork", "geom_sankey", "alluvial"]],
  ["tree", 3, ["ggtree", "plot.phylo", "geom_tiplab", "geom_tiplab2", "geom_cladelabel", "ggdendrogram", "treemap", "plotDendroAndColors"]],
  ["enrichment", 3, ["gseaplot", "gseaplot2", "enrichGO", "enrichKEGG", "gseGO", "gseKEGG", "GSEA", "fgsea", "gsva", "enricher", "compareCluster", "plotEnrichment", "enrichplot", "enrichPathway", "gseMKEGG"]],
  ["correlation", 3, ["corrplot", "ggcorrplot", "ggpairs", "corrgram", "chart.Correlation", "stat_cor", "mantel_test", "quickcor", "ggcorr"]],
  ["proportion", 3, ["pie", "coord_polar", "geom_area", "mosaicplot", "geom_mosaic", "position_fill", "pie3D"]],
  ["radar", 3, ["ggradar", "radarchart", "coord_radar"]],
  ["timeline", 3, ["swimmer_plot", "swimmer_lines", "gantt"]],
  ["dot_range", 3, ["geom_dumbbell", "geom_lollipop"]],
  ["table", 2, ["tableGrob", "kable", "flextable", "formattable", "ggtexttable", "datatable"]],
  ["combo", 1, ["plot_grid", "grid.arrange", "wrap_plots", "ggarrange", "insert_left", "insert_right", "insert_top", "insert_bottom", "plot_layout"]],
];
const CALL_INDEX = new Map();
for (const [group, weight, names] of FORM_CALLS) {
  for (const name of names) {
    if (!CALL_INDEX.has(name)) CALL_INDEX.set(name, []);
    CALL_INDEX.get(name).push({ group, weight });
  }
}

/** Packages (and a few distinctive calls) that identify the research domain. */
const DOMAIN_PACKAGES = {
  single_cell: ["Seurat", "SeuratData", "SeuratObject", "SingleCellExperiment", "monocle", "monocle3", "slingshot", "scater", "scran", "AUCell", "SCENIC", "CellChat", "velocyto.R", "SingleR", "harmony", "Signac", "infercnv", "scMetabolism", "DoubletFinder", "scRNAseq", "celldex", "MuSiC", "Rmagic", "destiny", "cicero"],
  spatial: ["STutility", "spacexr", "Giotto", "SPATA2", "SpatialExperiment", "semla"],
  genomic_variation: ["maftools", "GenVisR", "DNAcopy", "copynumber", "MutationalPatterns", "deconstructSigs", "sigminer", "CMplot", "qqman", "karyoploteR", "trackViewer", "VariantAnnotation", "BSgenome", "SomaticSignatures", "RCircos", "gwasglue", "TwoSampleMR"],
  epigenomics: ["ChAMP", "minfi", "methylKit", "ChIPseeker", "DiffBind", "ChIPpeakAnno", "Gviz", "rtracklayer", "Sushi", "exomePeak", "Guitar", "ELMER", "ATACseqQC", "bsseq", "wateRmelon", "IlluminaHumanMethylation450kanno.ilmn12.hg19", "motifStack", "ggseqlogo", "GenomicRanges"],
  immune_microenvironment: ["estimate", "xCell", "MCPcounter", "immunedeconv", "IOBR", "EPIC", "CIBERSORT", "quanTIseq", "easier"],
  clinical_prognosis: ["survival", "survminer", "rms", "timeROC", "survivalROC", "randomForestSRC", "cmprsk", "ggDCA", "rmda", "dcurves", "pec", "riskRegression", "survcomp", "pROC", "glmnet", "nomogramFormula", "regplot", "meta", "metafor", "MatchIt"],
  microbiome_evolution: ["vegan", "phyloseq", "ape", "ggtree", "phangorn", "treeio", "microbiome", "picante", "msa", "ggmsa", "Biostrings"],
  other_omics: ["pRRophetic", "oncoPredict", "MSstats", "MetaboAnalystR", "PharmacoGx", "cmapR", "DepMap"],
  bulk_transcriptome: ["DESeq2", "edgeR", "limma", "TCGAbiolinks", "GEOquery", "WGCNA", "sva", "GSVA", "clusterProfiler", "ConsensusClusterPlus", "NMF", "CancerSubtypes", "tximport", "pamr", "CMScaller", "genefu", "fgsea", "enrichplot", "org.Hs.eg.db", "msigdbr", "biomaRt", "viper", "Mfuzz", "TCseq"],
};
const DOMAIN_CALLS = {
  single_cell: ["CreateSeuratObject", "FindAllMarkers", "FindClusters", "DimPlot", "FeaturePlot", "VlnPlot", "RunUMAP", "plot_cells"],
  spatial: ["SpatialFeaturePlot", "SpatialDimPlot", "Load10X_Spatial", "SpatialPlot"],
  genomic_variation: ["read.maf", "oncoplot", "oncoPrint", "lollipopPlot"],
  immune_microenvironment: ["estimateScore", "xCellAnalysis", "MCPcounter.estimate", "deconvolute"],
  clinical_prognosis: ["ggsurvplot", "survfit", "coxph", "cph", "nomogram"],
};
/** Module-ID words that name a domain. Deliberately explicit: `STEM` is not spatial, `FPKM` is not KM. */
const DOMAIN_ID_HINTS = [
  ["single_cell", /(?:^|\d)(?:sc[A-Z]|scRNA|sciATAC)|singlecell|RNAvelocity|slingshot|SingleR|MuSiC|MAGIC/u],
  ["spatial", /\dST_|STpathseq|Spatial/u],
  ["genomic_variation", /mut|Mut|CNV|SNV|SNP|TMB|onco[Pp]|Manhattan|chromosome|MutSig|titv|FGA|GDC|armCNV|breakpoint|Lollipop/u],
  ["epigenomics", /Meth|ATAC|ChIP|m6A|phastCons|bw\b|DNAage|IGV|genomeView|motif|cofactor/u],
  ["immune_microenvironment", /[Ii]mmun|TME|TIL|TIDE|ImmGene|stemness/u],
  ["clinical_prognosis", /[Ss]urv|[Cc]ox|HR|nomogram|[Rr]isk|[Pp]rognos|DCA|[Ll]ogrank|Cindex|mortality|Calibration|PSM|BAPC|RMS|biomarker|Logistic|SmoothHaz/u],
  ["microbiome_evolution", /ggtree|Adonis|diversity|lineage|phylo/u],
  ["other_omics", /GDSC|CMap|CMAP|CRISPR|oncoPredict|XSum|[Dd]rug|PMAPscore/u],
  ["bulk_transcriptome", /FPKM|TPM|DESeq|limma|edgeR|WGCNA|GSEA|GSVA|ssGSEA|TCGA|DEG|volcano|pan[A-Z]|PAM50|[Ss]ubtype/u],
];

function count(map, key, by = 1) {
  map.set(key, (map.get(key) ?? 0) + by);
}

function codeEvidence(module) {
  const text = module.fullText ?? "";
  const calls = new Map();
  for (const match of text.matchAll(/(?<![A-Za-z0-9_.])([A-Za-z][A-Za-z0-9_.]*)\s*\(/gu)) {
    if (CALL_INDEX.has(match[1]) || Object.values(DOMAIN_CALLS).some((names) => names.includes(match[1]))) count(calls, match[1]);
  }
  const packages = new Set(module.packages ?? []);
  for (const match of text.matchAll(/(?:library|require|requireNamespace)\(\s*["']?([A-Za-z][A-Za-z0-9.]*)["']?/gu)) packages.add(match[1]);
  for (const match of text.matchAll(/(?<![A-Za-z0-9_.])([A-Za-z][A-Za-z0-9.]{2,})::/gu)) packages.add(match[1]);
  if (/position\s*=\s*["']fill["']/u.test(text)) count(calls, "position_fill");
  return { calls, packages };
}

function draftGroups(module, evidence) {
  const scores = new Map();
  for (const [name, hits] of evidence.calls) {
    for (const { group, weight } of CALL_INDEX.get(name) ?? []) count(scores, group, weight * Math.min(hits, 3));
  }
  // A scatter layer under a more specific point-based figure is not a separate scatter plot.
  if (["volcano", "embedding", "bubble", "correlation", "survival"].some((group) => (scores.get(group) ?? 0) >= 3)) scores.delete("scatter");
  if ((scores.get("scatter") ?? 0) < 2) scores.delete("scatter");
  if ((scores.get("combo") ?? 0) < 2) scores.delete("combo");
  const ranked = [...scores.entries()].filter(([, score]) => score >= 2).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  const idHints = plotFamilyGroups({ plotFamily: "", templateId: module.moduleId }).filter((group) => group !== "unclassified");
  const forms = ranked.filter(([group]) => !THEMES.has(group) && group !== "combo").map(([group]) => group);
  const themes = ranked.filter(([group]) => THEMES.has(group)).map(([group]) => group);
  const groups = [];
  const add = (group) => { if (group && !groups.includes(group)) groups.push(group); };
  for (const group of idHints) add(group);
  for (const group of forms.slice(0, idHints.length ? 2 : 3)) add(group);
  for (const group of themes.slice(0, 2)) add(group);
  if (scores.has("combo") && groups.length >= 2) add("combo");
  const agree = idHints.length > 0 && idHints.some((group) => scores.has(group));
  const dominant = !idHints.length && ranked.length > 0 && (ranked.length === 1 || ranked[0][1] >= ranked[1][1] * 2) && ranked[0][1] >= 6;
  return {
    groups: groups.slice(0, 5),
    confidence: !groups.length ? "none" : agree || dominant ? "high" : "low",
    ranked,
    idHints,
  };
}

function draftDomains(module, evidence) {
  const scores = new Map();
  for (const [domain, names] of Object.entries(DOMAIN_PACKAGES)) {
    for (const name of names) {
      if ([...evidence.packages].some((pkg) => pkg === name || (name === "BSgenome" && pkg.startsWith("BSgenome")))) count(scores, domain, 2);
    }
  }
  for (const [domain, names] of Object.entries(DOMAIN_CALLS)) {
    for (const name of names) if (evidence.calls.has(name)) count(scores, domain, 2);
  }
  const id = module.moduleId.replace(/^FigureYa\d*/u, (prefix) => prefix.replace("FigureYa", ""));
  for (const [domain, pattern] of DOMAIN_ID_HINTS) if (pattern.test(id)) count(scores, domain, 3);
  // Single-cell and spatial workflows reuse bulk tooling; keep bulk only when the ID says so.
  if ((scores.get("single_cell") ?? 0) >= 3 || (scores.get("spatial") ?? 0) >= 3) {
    if (!/[Bb]ulk/u.test(id)) scores.delete("bulk_transcriptome");
  }
  // glmnet, meta-analysis and matching packages alone do not make a prognosis figure.
  if ((scores.get("clinical_prognosis") ?? 0) < 4) scores.delete("clinical_prognosis");
  if ((scores.get("epigenomics") ?? 0) < 3) scores.delete("epigenomics");
  if ((scores.get("microbiome_evolution") ?? 0) < 3) scores.delete("microbiome_evolution");
  const ranked = [...scores.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  const domains = ranked.filter(([domain, score]) => domain !== "bulk_transcriptome" || score >= 3 || ranked.length === 1).map(([domain]) => domain).slice(0, 3);
  return { domains: domains.length ? domains : ["general"], ranked };
}

export function draftEntry(module) {
  const evidence = codeEvidence(module);
  const groups = draftGroups(module, evidence);
  const domains = draftDomains(module, evidence);
  const analysis = groups.groups.length === 0;
  return {
    entry: {
      groups: analysis ? ["other"] : groups.groups,
      domains: domains.domains,
      ...(analysis ? { kind: "analysis" } : {}),
      basis: "code",
    },
    confidence: groups.confidence,
    evidence: {
      idHints: groups.idHints,
      groupScores: groups.ranked,
      domainScores: domains.ranked,
      calls: [...evidence.calls.entries()].sort((left, right) => right[1] - left[1]),
      packages: [...evidence.packages].sort(),
    },
  };
}

export function validateTaxonomy(taxonomy, moduleIds) {
  const problems = [];
  if (taxonomy?.schema !== TAXONOMY_SCHEMA) problems.push(`schema must be ${TAXONOMY_SCHEMA}`);
  const modules = taxonomy?.modules ?? {};
  for (const moduleId of moduleIds) if (!modules[moduleId]) problems.push(`missing ${moduleId}`);
  for (const [moduleId, entry] of Object.entries(modules)) {
    if (!moduleIds.includes(moduleId)) problems.push(`unknown module ${moduleId}`);
    if (!Array.isArray(entry.groups) || !entry.groups.length) problems.push(`${moduleId}: groups must be non-empty`);
    for (const group of entry.groups ?? []) if (!PLOT_FAMILY_GROUP_IDS.includes(group)) problems.push(`${moduleId}: unknown group ${group}`);
    if (!Array.isArray(entry.domains) || !entry.domains.length) problems.push(`${moduleId}: domains must be non-empty`);
    for (const domain of entry.domains ?? []) if (!DOMAIN_IDS.includes(domain)) problems.push(`${moduleId}: unknown domain ${domain}`);
    if (entry.kind !== undefined && entry.kind !== "analysis") problems.push(`${moduleId}: kind must be "analysis" when present`);
    if (entry.basis !== "code" && entry.basis !== "manual") problems.push(`${moduleId}: basis must be code or manual`);
  }
  return problems;
}

function snippet(module) {
  return (module.requirement || module.title || "")
    .replace(/^\s*(?:Demand description|Requirement description|需求描述)\s*/iu, "")
    .replace(/[|\r\n]+/gu, " ")
    .slice(0, 110);
}

async function main() {
  const args = process.argv.slice(2);
  const reportIndex = args.indexOf("--report");
  const reportFile = reportIndex >= 0 ? args[reportIndex + 1] : undefined;
  const catalog = JSON.parse(await fs.readFile(CATALOG, "utf8"));
  let existing = { modules: {} };
  try {
    existing = JSON.parse(await fs.readFile(TAXONOMY, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const modules = {};
  const rows = [];
  for (const module of [...catalog.modules].sort((left, right) => left.moduleId.localeCompare(right.moduleId, "en", { numeric: true }))) {
    const draft = draftEntry(module);
    const kept = existing.modules?.[module.moduleId]?.basis === "manual" ? existing.modules[module.moduleId] : undefined;
    modules[module.moduleId] = kept ?? draft.entry;
    rows.push({ module, draft, entry: modules[module.moduleId] });
  }
  const taxonomy = { schema: TAXONOMY_SCHEMA, figureya: catalog.figureya, modules };
  const problems = validateTaxonomy(taxonomy, catalog.modules.map((module) => module.moduleId));
  if (problems.length) throw new Error(`Invalid taxonomy:\n${problems.join("\n")}`);

  const tally = (pick) => {
    const counts = new Map();
    for (const row of rows) for (const value of pick(row)) count(counts, value);
    return [...counts.entries()].sort((left, right) => right[1] - left[1]).map(([value, hits]) => `${value}=${hits}`).join(", ");
  };
  console.log(`modules: ${rows.length}`);
  console.log(`basis: ${tally((row) => [row.entry.basis])}`);
  console.log(`draft confidence: ${tally((row) => [row.entry.basis === "manual" ? "manual" : row.draft.confidence])}`);
  console.log(`primary group: ${tally((row) => [row.entry.groups[0]])}`);
  console.log(`any group: ${tally((row) => row.entry.groups)}`);
  console.log(`domains: ${tally((row) => row.entry.domains)}`);
  console.log(`analysis-only: ${rows.filter((row) => row.entry.kind === "analysis").length}`);

  if (reportFile) {
    const lines = [
      "# FigureYa taxonomy draft",
      "",
      "| module | groups | domains | kind | basis/confidence | plotting calls | requirement |",
      "| --- | --- | --- | --- | --- | --- | --- |",
      ...rows.map(({ module, draft, entry }) =>
        `| ${module.moduleId.replace("FigureYa", "")} | ${entry.groups.join(", ")} | ${entry.domains.join(", ")} | ${entry.kind ?? ""} | ${entry.basis === "manual" ? "manual" : draft.confidence} | ${draft.evidence.calls.slice(0, 8).map(([name, hits]) => `${name}×${hits}`).join(" ")} | ${snippet(module)} |`),
    ];
    await fs.mkdir(path.dirname(path.resolve(reportFile)), { recursive: true });
    await fs.writeFile(reportFile, `${lines.join("\n")}\n`);
    console.log(`report: ${reportFile}`);
  }
  if (args.includes("--write")) {
    await fs.writeFile(TAXONOMY, `${JSON.stringify(taxonomy, null, 1)}\n`);
    console.log(`wrote ${path.relative(root, TAXONOMY)}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
