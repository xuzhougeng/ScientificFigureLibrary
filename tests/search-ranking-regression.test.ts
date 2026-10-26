import assert from "node:assert/strict";
import test from "node:test";
import { CatalogIndex } from "../src/catalog.ts";
import { ModuleCatalogIndex } from "../src/module-catalog.ts";
import type { SearchRequest } from "../src/types.ts";

// Named-chart queries from the 2026-10 retrieval sandbox, run against the
// bundled FigureYa and Open Figure Modules catalogs with the shipped scoring.
const figureYa = await CatalogIndex.load();
const modules = await ModuleCatalogIndex.load();

async function ranked(request: SearchRequest) {
  const hits = [
    ...(await figureYa.searchAll(request)).map((hit) => ({ id: hit.templateId, score: hit.retrievalScore })),
    ...(await modules.searchAll(request)).map((hit) => ({ id: hit.templateId, score: hit.retrievalScore })),
  ];
  return hits.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
}

test("a two-letter term such as KM matches whole identifier words, never the inside of FPKM", async () => {
  const top = (await ranked({ query: "KM曲线" })).slice(0, 6).map((hit) => hit.id);
  assert.ok(top.length > 0);
  assert.equal(top.some((id) => /fpkm|count2/iu.test(id)), false, top.join(", "));
});

test("generic words alone are not a match and do not widen a specific query", async () => {
  assert.equal((await ranked({ query: "plot figure gene" })).length, 0);
  const volcano = await ranked({ query: "volcano" });
  const volcanoPlot = await ranked({ query: "volcano plot" });
  assert.ok(volcanoPlot.length <= volcano.length, `${volcanoPlot.length} > ${volcano.length}`);
  assert.match(volcanoPlot[0]!.id, /volcano/iu);
});

test("a requested chart form outranks a template that only shares the data domain", async () => {
  const hits = await ranked({ query: "单细胞UMAP降维图" });
  const firstUmap = hits.findIndex((hit) => /umap/iu.test(hit.id));
  const scCnv = hits.findIndex((hit) => hit.id === "FigureYa166scCNV");
  assert.ok(firstUmap >= 0, "a UMAP module is returned");
  assert.ok(scCnv === -1 || firstUmap < scCnv, `UMAP at ${firstUmap}, scCNV at ${scCnv}`);
  assert.match(hits[0]!.id, /umap/iu);
});
