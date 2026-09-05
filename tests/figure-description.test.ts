import assert from "node:assert/strict";
import test from "node:test";
import { figureDescriptionMarkdown, markdownPlainText, resolveFigureDescription } from "../src/figure-description.ts";
import { buildSearchIntent, scoreSearchableTemplate } from "../src/catalog.ts";

test("explicit Markdown is preserved without changing the original description", () => {
  const description = "Why this chart\n\n**Context**";
  const application = "### 场景一\n\n- Compare **immune composition**.";
  assert.deepEqual(resolveFigureDescription(description, application), { description, application, applicationOrigin: "explicit" });
  const exported = figureDescriptionMarkdown({ title: "图", description, application, dataProfile: "`sample` × `celltype`" });
  assert.ok(exported.includes(application));
  assert.ok(exported.includes("## 数据特征\n\n`sample` × `celltype`"));
});

test("legacy headings extract scenarios without losing following description sections", () => {
  for (const label of ["使用场景", "适用场景", "Recommended use（使用场景）", "Application", "使用场景（对齐 FigureYa 写法）："]) {
    const result = resolveFigureDescription(`背景\n\n## ${label}\n\n- 比较两个条件。\n\n## 数据特征\nNewick`);
    assert.equal(result.applicationOrigin, "legacy_description");
    assert.equal(result.application, "- 比较两个条件。");
    assert.equal(result.description, "背景\n\n## 数据特征\nNewick");
  }
});

test("legacy plain numbered scenarios work, but mentions and code are not inferred", () => {
  assert.equal(resolveFigureDescription("简介\n场景一：比较细胞组成。场景二：比较干预。\n数据特征\n长表").application, "场景一：比较细胞组成。场景二：比较干预。");
  for (const description of ["仅有视觉编码，未记录使用场景。", "```md\n## 使用场景\nDo not extract\n```", "## Application\n"]) {
    assert.deepEqual(resolveFigureDescription(description), { description, application: "", applicationOrigin: "missing" });
  }
});

test("Markdown produces a separate plain search projection including tables and code", () => {
  const source = "### **免疫细胞**\n\n- 比较 `treatment`\n\n|群体|变化|\n|---|---|\n|T cell|上升|\n\n[paper](https://example.org/private-link)";
  const text = markdownPlainText(source);
  assert.match(text, /免疫细胞/u);
  assert.match(text, /T cell/u);
  assert.match(text, /treatment/u);
  assert.doesNotMatch(text, /###|\*\*|private-link|\|/u);
  const result = scoreSearchableTemplate({ templateId: "x", title: "x", description: "", application: source, visualProfile: "circular heatmap", dataProfile: "", inputFiles: [], codeFiles: [], packages: [] }, buildSearchIntent({ query: "免疫细胞" }));
  assert.ok(result.score > 0);
  assert.ok(result.reasons.some((reason) => reason.includes("应用场景")));
});

test("plain projection preserves words split by emphasis and section boundaries", () => {
  assert.equal(markdownPlainText("免疫**细胞**的差异\n\n**第二段**\n\n- 第一个\n- 第二个"), "免疫细胞的差异 第二段 第一个 第二个");
});
