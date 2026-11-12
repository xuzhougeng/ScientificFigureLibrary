import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { CatalogIndex, parseFigureYaTaxonomy } from "../src/catalog.ts";
import { candidateDomains, DOMAIN_IDS } from "../src/domains.ts";
import { inPlotFamilyGroup, plotFamilyGroups } from "../src/plot-family-groups.ts";
// @ts-expect-error -- no declaration file is emitted for scripts/*.mjs.
import { draftEntry, validateTaxonomy } from "../scripts/draft-figureya-taxonomy.mjs";

const assets = path.resolve(import.meta.dirname, "..", "assets");
const catalog = JSON.parse(await fs.readFile(path.join(assets, "catalog.json"), "utf8")) as { modules: Array<{ moduleId: string }> };
const taxonomy = JSON.parse(await fs.readFile(path.join(assets, "figureya-taxonomy.json"), "utf8")) as unknown;
const figureYa = await CatalogIndex.load();
const listed = new Map((await figureYa.searchAll({ query: "", browse: true })).map((candidate) => [candidate.templateId, candidate]));

test("the bundled taxonomy covers every FigureYa module with declared groups and domains", () => {
  assert.deepEqual(validateTaxonomy(taxonomy, catalog.modules.map((module) => module.moduleId)), []);
  assert.equal(parseFigureYaTaxonomy(taxonomy).size, catalog.modules.length);
});

test("a taxonomy with a foreign schema or unknown values degrades instead of failing", () => {
  assert.equal(parseFigureYaTaxonomy({ schema: "something-else", modules: { A: { groups: ["heatmap"], domains: ["general"] } } }).size, 0);
  const parsed = parseFigureYaTaxonomy({
    schema: "figure-library.figureya-taxonomy.v1",
    modules: {
      A: { groups: ["heatmap", "not-a-group", "heatmap"], domains: ["single_cell", "not-a-domain"], kind: "analysis" },
      B: { groups: ["not-a-group"], domains: [] },
    },
  });
  assert.deepEqual(parsed.get("A"), { groups: ["heatmap"], domains: ["single_cell"], kind: "analysis" });
  assert.equal(parsed.has("B"), false);
});

test("FigureYa candidates carry the reviewed groups, so no module is left unclassified", () => {
  assert.equal(listed.size, catalog.modules.length);
  const unclassified = [...listed.values()].filter((candidate) => plotFamilyGroups(candidate)[0] === "unclassified");
  assert.deepEqual(unclassified.map((candidate) => candidate.templateId), []);
});

test("groups follow what the code draws rather than words in the description", () => {
  const primary = (id: string) => plotFamilyGroups(listed.get(id)!)[0];
  assert.equal(primary("FigureYa11bubble"), "bubble");
  assert.equal(primary("FigureYa25Sankey_update"), "flow");
  assert.equal(primary("FigureYa186swimmerplot"), "timeline");
  assert.equal(primary("FigureYa148SimpleDendrogram"), "tree");
  assert.equal(primary("FigureYa76corrgram"), "correlation");
});

test("a module belongs to every group it draws and to its research domains", () => {
  const scHeatmap = listed.get("FigureYa206scHeatmap")!;
  assert.ok(inPlotFamilyGroup(scHeatmap, "heatmap"));
  assert.ok(inPlotFamilyGroup(scHeatmap, "enrichment"));
  assert.deepEqual(candidateDomains(scHeatmap), ["single_cell"]);
  // STEM time-series modules are not spatial transcriptomics.
  assert.equal(candidateDomains(listed.get("FigureYa98STEMheatmapV2")!).includes("spatial"), false);
  assert.ok(candidateDomains(listed.get("FigureYa239ST_PDAC")!).includes("spatial"));
  for (const candidate of listed.values()) {
    assert.ok(candidateDomains(candidate).length > 0, candidate.templateId);
    for (const domain of candidateDomains(candidate)) assert.ok((DOMAIN_IDS as readonly string[]).includes(domain));
  }
});

test("data-preparation modules are marked as analysis instead of joining a figure group", () => {
  const convert = listed.get("FigureYa22FPKM2TPM")!;
  assert.equal(convert.templateKind, "analysis");
  assert.deepEqual(plotFamilyGroups(convert), ["other"]);
  assert.equal(listed.get("FigureYa9heatmap")!.templateKind, undefined);
});

test("the draft reads plotting calls and packages from module text without running it", () => {
  const draft = draftEntry({
    moduleId: "FigureYa999demo",
    packages: ["Seurat"],
    fullText: "library(Seurat)\nobj <- CreateSeuratObject(counts)\nDimPlot(obj)\nDimPlot(obj, group.by = 'x')\npheatmap(mat)",
  });
  assert.equal(draft.entry.groups[0], "embedding");
  assert.ok(draft.entry.groups.includes("heatmap"));
  assert.deepEqual(draft.entry.domains, ["single_cell"]);
  assert.equal(draft.entry.basis, "code");
  const empty = draftEntry({ moduleId: "FigureYa998convert", packages: [], fullText: "x <- read.csv('a.csv'); write.csv(x, 'b.csv')" });
  assert.deepEqual(empty.entry.groups, ["other"]);
  assert.equal(empty.entry.kind, "analysis");
});
