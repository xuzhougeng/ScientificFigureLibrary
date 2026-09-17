import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { buildReferencePrompt } from "../src/local/reference-prompt.ts";
import { localPublishedExactSelector } from "../src/providers.ts";

const candidate = {
  title: "PCA reference", sourceLabel: "Local Published", application: "Compare samples", dataProfile: "Expression matrix",
  inputFiles: ["expression.csv"], packages: ["ggplot2"],
  exactSelector: localPublishedExactSelector({ templateId: "pca", revisionId: "r1", releaseId: "release1", contentDigest: "a".repeat(64) }),
};

test("reference prompt uses actual materialized files and explicitly handles inaccessible local paths", () => {
  const target = path.resolve("reference-fixture");
  const prompt = buildReferencePrompt(candidate, target, ["assets/visuals/plot.png", "assets/code/plot.R", "TEMPLATE.md", "template.lock.json"]);
  assert.ok(prompt.includes(path.join(target, "assets/code/plot.R")));
  assert.ok(prompt.includes(path.join(target, "assets/visuals/plot.png")));
  assert.match(prompt, /让我上传/u);
  assert.match(prompt, /拿到文件前不要声称已看图或已复用代码/u);
  assert.match(prompt, /把修改写入项目中的新文件/u);
  assert.match(prompt, /未执行绘图代码/u);
  assert.ok(prompt.includes(JSON.stringify(candidate.exactSelector)));
});

test("image-only reference never promises an original implementation", () => {
  const prompt = buildReferencePrompt(candidate, path.resolve("image-only"), ["assets/visuals/plot.png", "template.lock.json"]);
  assert.match(prompt, /只能作为视觉参考/u);
  assert.match(prompt, /新写代码不能称为复用原始实现/u);
});
