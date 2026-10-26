import assert from "node:assert/strict";
import test from "node:test";
import { familyWords, PLOT_FAMILY_GROUP_IDS, plotFamilyGroup } from "../src/plot-family-groups.ts";

test("family words split camelCase, digits and separators", () => {
  assert.equal(familyWords("FigureYa102multipanelROC"), "figure ya 102 multipanel roc");
  assert.equal(familyWords("FigureYa27tSNE_update"), "figure ya 27 t sne update");
  assert.equal(familyWords("umap_numbered_legend"), "umap numbered legend");
});

test("Open Figure Modules spellings map to canonical groups, most specific form first", () => {
  const cases: Array<[string, string]> = [
    ["umap_numbered_legend", "embedding"], ["circular_umap", "embedding"], ["pca", "embedding"],
    ["volcano_go_combo", "volcano"], ["stacked_upset", "set_overlap"], ["venn", "set_overlap"],
    ["alluvial", "flow"], ["ggtree_genome_locus", "tree"], ["hierarchy", "tree"],
    ["manhattan", "genome"], ["gantt", "timeline"], ["back_to_back_lollipop", "dot_range"],
    ["ridgeline_heatmap", "distribution"], ["stacked_histogram_facets", "distribution"],
    ["polar_bar", "proportion"], ["percent_bar", "proportion"], ["pie", "proportion"],
    ["clustered_heatmap_annotation", "heatmap"], ["benchmark_matrix", "heatmap"],
    ["enrichment_bar_with_genes", "enrichment"], ["ranked_nes_scatter", "enrichment"],
    ["mantel_corrplot", "correlation"], ["marker_dotplot", "bubble"], ["grouped_deg_bar", "bar"],
    ["scatter_errorbar", "scatter"], ["open radial multi-track annotation chart", "circular"],
  ];
  for (const [plotFamily, group] of cases) assert.equal(plotFamilyGroup({ plotFamily }), group, plotFamily);
});

test("FigureYa entries without a chart family fall back to template ID words without substring accidents", () => {
  assert.equal(plotFamilyGroup({ plotFamily: "", templateId: "FigureYa102multipanelROC" }), "roc");
  assert.equal(plotFamilyGroup({ plotFamily: "single-cell", templateId: "FigureYa254scViolin" }), "violin");
  assert.equal(plotFamilyGroup({ plotFamily: "single-cell", templateId: "FigureYa27tSNE_update" }), "embedding");
  assert.equal(plotFamilyGroup({ plotFamily: "", templateId: "FigureYa186swimmerplot" }), "timeline");
  // "km" inside FPKM must not read as Kaplan-Meier.
  assert.equal(plotFamilyGroup({ plotFamily: "", templateId: "FigureYa22FPKM2TPM" }), "unclassified");
  assert.equal(plotFamilyGroup({ plotFamily: "single-cell", templateId: "FigureYa150diversityScore" }), "other");
  assert.equal(plotFamilyGroup({ plotFamily: "survival", templateId: "FigureYa128Prognostic" }), "survival");
});

test("every grouping result is a declared group id", () => {
  for (const value of ["", "anything", "sankey", "table", "combo", "line"]) {
    assert.ok((PLOT_FAMILY_GROUP_IDS as readonly string[]).includes(plotFamilyGroup({ plotFamily: value })));
  }
});
