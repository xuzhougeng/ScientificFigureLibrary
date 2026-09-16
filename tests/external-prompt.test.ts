import assert from "node:assert/strict";
import test from "node:test";
import { buildExternalPlotPrompt } from "../app/external-prompt.ts";
import type { Candidate } from "../app/view.ts";

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    candidateId: "candidate-1",
    templateId: "FigureYa101PCA",
    providerId: "org.figureya.module",
    exactSelector: {
      schema: "figure-library.provider-selector.v1",
      providerId: "org.figureya.module",
      kind: "figureya-module.v1",
      identity: { templateId: "FigureYa101PCA" },
    },
    sourceLabel: "FigureYa",
    title: "FigureYa101PCA",
    retrievalScore: 100,
    reasons: ["browse"],
    warnings: [],
    excerpt: "",
    description: "RNA-seq的PCA图。 PCA plot of RNA seq. From http://example.com/paper 3",
    application: "s 场景一：批次效应。 Scenario 1: Batch effect. 4",
    dataProfile: "矩阵，行表示特征 # batch: 批次信息 # batchvar: 变量 # fig.dir: 输出目录",
    inputFiles: ["easy_input.csv"],
    codeFiles: ["FigureYa101PCA.R"],
    packages: ["ggplot2"],
    materializable: true,
    previewAvailable: true,
    assetKind: "plot_template",
    language: "R",
    plotFamily: "pca",
    reviewStatus: "not_reviewed",
    codeStatus: "provided",
    executionStatus: "not_run",
    management: { templateId: "FigureYa101PCA", canArchive: false, canUpdate: false },
    ...overrides,
  };
}

test("external prompt is a complete plotting instruction without MCP JSON", () => {
  const prompt = buildExternalPlotPrompt([candidate()]);
  assert.match(prompt, /不需要安装 Scientific Figure Library、MCP 或 Skill/u);
  assert.match(prompt, /按每个模板的图类型/u);
  assert.match(prompt, /## 1\. FigureYa101PCA/u);
  assert.match(prompt, /来源：FigureYa/u);
  assert.match(prompt, /依赖包：/u);
  assert.match(prompt, /ggplot2/u);
  assert.match(prompt, /场景一/u);
  assert.doesNotMatch(prompt, /exactSelector/u);
  assert.doesNotMatch(prompt, /figure-library\.provider-selector/u);
  assert.equal(buildExternalPlotPrompt([]), "");
});
