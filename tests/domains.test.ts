import assert from "node:assert/strict";
import test from "node:test";
import { buildCatalogListing, type CatalogListingSet } from "../src/catalog-listing.ts";
import { candidateDomains, DOMAINS, isDomainId } from "../src/domains.ts";
import { inPlotFamilyGroup, PLOT_FAMILY_GROUPS, plotFamilyGroups } from "../src/plot-family-groups.ts";
import type { TemplateCandidate } from "../src/types.ts";

function candidate(templateId: string, extra: Partial<TemplateCandidate>): TemplateCandidate {
  return {
    templateId,
    providerId: "test",
    exactSelector: { providerId: "test", kind: "test", templateId } as unknown as TemplateCandidate["exactSelector"],
    sourceLabel: "Test",
    title: templateId,
    retrievalScore: 1,
    matchedTerms: [],
    reasons: [],
    warnings: [],
    excerpt: "",
    description: "",
    application: "",
    dataProfile: "",
    inputFiles: [],
    codeFiles: [],
    packages: [],
    materializable: false,
    previewAvailable: false,
    assetKind: "plot_template",
    language: "R",
    plotFamily: "",
    reviewStatus: "not_reviewed",
    codeStatus: "provided",
    executionStatus: "not_run",
    license: "test",
    management: { templateId, canArchive: false, canUpdate: false },
    ...extra,
  };
}

test("domains have unique ids and bilingual labels", () => {
  assert.equal(new Set(DOMAINS.map((domain) => domain.id)).size, DOMAINS.length);
  for (const domain of DOMAINS) assert.ok(domain.label && domain.labelEn);
  assert.ok(isDomainId("single_cell"));
  assert.equal(isDomainId("single-cell"), false);
});

test("declared domains are deduplicated and unknown values are dropped", () => {
  assert.deepEqual(candidateDomains({ domains: ["spatial", "nope", "single_cell", "spatial"] }), ["spatial", "single_cell"]);
  assert.deepEqual(candidateDomains({}), []);
});

test("the four analysis themes are separated from figure forms", () => {
  const themes = PLOT_FAMILY_GROUPS.filter((group) => group.kind === "theme").map((group) => group.id).sort();
  assert.deepEqual(themes, ["enrichment", "genome", "roc", "survival"]);
});

test("explicit groups win over rules, and rule-based grouping keeps every matching group", () => {
  assert.deepEqual(plotFamilyGroups({ plotFamily: "heatmap", familyGroups: ["bubble", "enrichment", "bogus"] }), ["bubble", "enrichment"]);
  assert.deepEqual(plotFamilyGroups({ plotFamily: "enrichment_bar" }), ["enrichment", "bar"]);
  assert.ok(inPlotFamilyGroup({ plotFamily: "volcano_go_combo" }, "enrichment"));
  assert.equal(inPlotFamilyGroup({ plotFamily: "volcano_go_combo" }, "heatmap"), false);
  // Explicit values that are all unknown fall back to the rules.
  assert.deepEqual(plotFamilyGroups({ plotFamily: "sankey", familyGroups: ["bogus"] }), ["flow"]);
});

test("catalog listing counts an entry under each of its groups and domains", () => {
  const set: CatalogListingSet = {
    resultSetId: "rs",
    catalogRevision: "rev",
    sources: [],
    candidates: [
      candidate("a", { familyGroups: ["heatmap", "enrichment"], domains: ["single_cell"] }),
      candidate("b", { plotFamily: "heatmap", domains: ["single_cell", "spatial"] }),
      candidate("c", { plotFamily: "sankey" }),
    ],
  };
  const listing = buildCatalogListing(set, 0, 10, "compact");
  const count = (facet: Array<{ value: string; count: number }>, value: string) => facet.find((item) => item.value === value)?.count ?? 0;
  assert.equal(count(listing.structured.facets.familyGroup, "heatmap"), 2);
  assert.equal(count(listing.structured.facets.familyGroup, "enrichment"), 1);
  assert.equal(count(listing.structured.facets.familyGroup, "flow"), 1);
  assert.equal(count(listing.structured.facets.domain, "single_cell"), 2);
  assert.equal(count(listing.structured.facets.domain, "spatial"), 1);
  assert.deepEqual(listing.structured.entries[0]!.familyGroups, ["heatmap", "enrichment"]);
  assert.equal(listing.structured.entries[0]!.familyGroup, "heatmap");
  assert.deepEqual(listing.structured.entries[2]!.domains, []);
  assert.ok(listing.lines.some((line) => line.startsWith("FACET domain: single_cell=2")));
});
