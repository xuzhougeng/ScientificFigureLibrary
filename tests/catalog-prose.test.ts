import assert from "node:assert/strict";
import test from "node:test";
import { formatCatalogProse, looksStructuredMarkdown } from "../src/catalog-prose.ts";

const requirement =
  "RNA-seq的PCA图，同一组用相同颜色，多次重复（批次）用不同形状。我的分组很多，3次重复，不需要像FigureYa38PCA那样画圈画箭头。 PCA plot of RNA seq, with the same color for the same group and different shapes for multiple repetitions (batches). I have many groups and repeat them three times, so I don’t need to draw circles or arrows like in FigureYa38PCA. From http://genesdev.cshlp.org/content/32/2/96 3";

const application =
  "s 场景一：每个分组内的样品较多，是不同批次获得的。如果能用各种形状来区分批次的话，就能一眼看出哪个批次远离其他批次，有助于判断批次效应的影响。 场景二：每个分组内的样品是2到n次生物学重复获得的。如果能用各种形状来区分不同重复的话，就能一眼看出哪次重复远离其他重复，有助于判断去掉哪个离群样品。 如果想画圈和箭头，或者无法提供重复或批次batch的信息，请使用FigureYa38PCA。 不仅限于RNA-seq，同样适用于其他类型的数据。 Scenario 1: Each group has a large number of samples obtained from different batches. If various shapes can be used to distinguish batches, it can be seen at a glance which batch is far away from other batches, which helps to determine the impact of batch effects. Scenario 2: The samples within each group are obtained from 2 to n biological replicates. If various shapes can be used to distinguish different repetitions, it can be seen at a glance which repetition is far away from other repetitions, which helps to determine which outlier sample to remove. If you want to draw circles and arrows, or cannot provide information on duplicates or batches, please use FigureYa38PCA. Not limited to RNA seq, it also applies to other types of data. 4";

const inputSummary =
  '矩阵，行表示特征，列表示样本 # batch: 批次信息数据框 # batchvar: 批次变量名称，默认为批次数据框的列名 # fig.dir: 图片输出目录 # PCA.fig.title: PCA图的标题 # pos1: 第一个图例的位置，默认为"bottomright" # Parameters: # indata: Input data matrix with features as rows and samples as columns # batch: Data frame containing batch information pca2batch <- function (indata, batch, batchvar = colnames (batch), fig.dir, PCA.fig.title) { # 加载ClassDiscovery包，用于PCA分析 # Lo';

test("keeps already structured Markdown", () => {
  const value = "展示分类流向冲击图。\n\n- 作为该图类型的 R 代码与布局参考。";
  assert.equal(looksStructuredMarkdown(value), true);
  assert.equal(formatCatalogProse(value), value);
});

test("splits FigureYa bilingual requirement and drops the scraped page number", () => {
  const formatted = formatCatalogProse(requirement);
  assert.match(formatted, /画圈画箭头。\n\nPCA plot of RNA seq/u);
  assert.match(formatted, /\[http:\/\/genesdev\.cshlp\.org\/content\/32\/2\/96\]\(http:\/\/genesdev\.cshlp\.org\/content\/32\/2\/96\)/u);
  assert.doesNotMatch(formatted, /96 3$/u);
});

test("turns FigureYa scenarios into a list and drops the leftover section letter", () => {
  const formatted = formatCatalogProse(application);
  assert.doesNotMatch(formatted, /^s 场景一/u);
  assert.match(formatted, /-\s+\*\*场景一：\*\*/u);
  assert.match(formatted, /-\s+\*\*场景二：\*\*/u);
  assert.match(formatted, /-\s+\*\*Scenario 1:\*\*/u);
  assert.doesNotMatch(formatted, /\s4$/u);
});

test("renders FigureYa parameter walls as a list and keeps the function out of the prose", () => {
  const formatted = formatCatalogProse(inputSummary);
  assert.match(formatted, /^矩阵，行表示特征，列表示样本/u);
  assert.match(formatted, /- `batch`: 批次信息数据框/u);
  assert.match(formatted, /- `fig.dir`: 图片输出目录/u);
  assert.doesNotMatch(formatted, /- `Parameters`:/u);
  assert.equal([...formatted.matchAll(/- `batch`:/gu)].length, 1);
  assert.match(formatted, /```r\npca2batch <- function/u);
});
