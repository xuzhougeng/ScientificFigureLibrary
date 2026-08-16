import assert from "node:assert/strict";
import test from "node:test";
import { buildSearchIntent, scoreSearchableTemplate } from "../src/catalog.ts";

test("scientificQuestion is optional and participates in search ranking", () => {
  const intent = buildSearchIntent({ query: "被激活或抑制" });
  const base = {
    templateId: "gsea-demo",
    title: "GSEA NES scatter",
    description: "Ranked bubble scatter of NES with point size encoding set size.",
    application: "Descending NES scatter, alpha encodes significance.",
    dataProfile: "Pathway-level table with NES and pvalue.",
    inputFiles: [] as string[],
    codeFiles: [] as string[],
    packages: ["ggplot2"],
  };
  const withQuestion = scoreSearchableTemplate(
    {
      ...base,
      scientificQuestion: "哪些生物学通路被激活或抑制，以及这些通路改变的方向和相对强度如何？",
    },
    intent,
  );
  const withoutQuestion = scoreSearchableTemplate(base, intent);
  assert.ok(withQuestion.score > withoutQuestion.score);
  assert.ok(withQuestion.matchedTerms.some((term) => term.includes("激活") || term.includes("抑制")));
});

test("missing scientificQuestion does not break scoring", () => {
  const evidence = scoreSearchableTemplate(
    {
      templateId: "old-template",
      title: "heatmap",
      description: "A compact heatmap of differential expression.",
      application: "Pink up, blue down.",
      dataProfile: "gene by sample matrix",
      inputFiles: [],
      codeFiles: [],
      packages: [],
    },
    buildSearchIntent({ query: "heatmap differential expression" }),
  );
  assert.ok(evidence.score > 0);
});
