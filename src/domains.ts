/**
 * Research-domain facet for catalog entries.
 *
 * A domain answers "what kind of data or study is this figure for", which is
 * independent of the figure type in `plot-family-groups.ts`: a single-cell
 * heatmap is both `single_cell` and `heatmap`. Domains are explicit metadata
 * (the bundled FigureYa taxonomy, or keywords a Provider entry declares); they are never guessed
 * from free text, so an entry without them simply has no domain.
 */
export const DOMAINS = [
  { id: "single_cell", label: "单细胞", labelEn: "single-cell" },
  { id: "spatial", label: "空间转录组", labelEn: "spatial transcriptomics" },
  { id: "bulk_transcriptome", label: "bulk 转录组", labelEn: "bulk transcriptome" },
  { id: "genomic_variation", label: "基因组变异", labelEn: "genomic variation (mutation/CNV)" },
  { id: "epigenomics", label: "表观组", labelEn: "epigenomics" },
  { id: "immune_microenvironment", label: "免疫微环境", labelEn: "immune microenvironment" },
  { id: "clinical_prognosis", label: "临床预后", labelEn: "clinical outcome and prognosis" },
  { id: "microbiome_evolution", label: "微生物与进化", labelEn: "microbiome and evolution" },
  { id: "other_omics", label: "其他组学", labelEn: "other omics" },
  { id: "general", label: "通用", labelEn: "general purpose" },
] as const;
export type DomainId = (typeof DOMAINS)[number]["id"];
export const DOMAIN_IDS = DOMAINS.map((domain) => domain.id) as [DomainId, ...DomainId[]];

const KNOWN = new Set<string>(DOMAIN_IDS);

export function isDomainId(value: unknown): value is DomainId {
  return typeof value === "string" && KNOWN.has(value);
}

/**
 * Keyword aliases for Providers whose entries carry author tags but no domain
 * field (Open Figure Modules, Local Published). Matching is on whole words of
 * the declared tags, plot family and module ID, never on prose, so `cell` (the
 * journal) is not single-cell and a style `variant` is not genomic variation.
 */
const KEYWORD_DOMAINS: Array<[DomainId, string[]]> = [
  ["single_cell", ["single cell", "sc", "scrna", "scrnaseq", "snrna", "umap", "tsne", "celltype", "cell composition", "cell type", "seurat", "scanpy", "scp", "scpubr", "scib", "hlca", "pseudotime", "单细胞"]],
  ["spatial", ["spatial", "visium", "niche", "stereo seq", "xenium", "merfish", "空间转录组", "空转"]],
  ["genomic_variation", ["mutation", "cnv", "snv", "snp", "oncoplot", "oncoprint", "maf", "gwas", "manhattan", "tmb", "突变", "拷贝数"]],
  ["epigenomics", ["methylation", "atac", "chip", "chipseq", "atacseq", "cut tag", "m6a", "histone", "甲基化", "表观"]],
  ["immune_microenvironment", ["immune", "tme", "infiltration", "tcr", "bcr", "checkpoint", "免疫"]],
  ["clinical_prognosis", ["survival", "km", "kaplan meier", "cox", "prognosis", "nomogram", "forest", "roc", "clinical", "swimmer", "生存", "预后"]],
  ["microbiome_evolution", ["microbiome", "mantel", "phylogeny", "phylogenetic", "phylogenomic", "ggtree", "taxonomy", "16s", "metagenome", "diversity", "菌群", "进化树"]],
  ["other_omics", ["metabolome", "metabolomics", "proteome", "proteomics", "lipidome", "drug", "crispr", "代谢组", "蛋白组"]],
  ["bulk_transcriptome", ["deg", "volcano", "gsea", "go", "kegg", "nes", "hallmark", "enrichment", "rnaseq", "rna seq", "bulk", "wgcna", "transcriptome", "差异表达", "富集"]],
];

function keywordText(values: readonly string[]) {
  return ` ${values.join(" ").normalize("NFKC").toLocaleLowerCase("en-US").replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;
}

/**
 * Domains named by an entry's declared keywords; `general` when none is named.
 * Single-cell and spatial entries reuse differential-expression and enrichment
 * vocabulary, so those keywords alone do not add `bulk_transcriptome` to them.
 */
export function domainsFromKeywords(values: readonly string[]): DomainId[] {
  const text = keywordText(values);
  const matched = KEYWORD_DOMAINS.filter(([, aliases]) => aliases.some((alias) => text.includes(` ${alias} `))).map(([domain]) => domain);
  const cellular = matched.includes("single_cell") || matched.includes("spatial");
  const domains = matched.filter((domain) => domain !== "bulk_transcriptome" || (!cellular || text.includes(" bulk ")));
  return domains.length ? domains.slice(0, 3) : ["general"];
}

/** Declared domains of an entry, in the order its metadata lists them; unknown values are dropped. */
export function candidateDomains(candidate: { domains?: readonly string[] }): DomainId[] {
  return [...new Set((candidate.domains ?? []).filter(isDomainId))];
}
