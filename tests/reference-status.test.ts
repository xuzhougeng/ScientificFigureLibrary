import assert from "node:assert/strict";
import test from "node:test";
import type { ReferenceCacheStatus } from "../src/local/reference-cache.ts";
import {
  imageCacheLabel,
  joinReferencePrompts,
  planReferenceCopy,
  referencePackLabel,
  referenceStatusText,
} from "../app/local/reference-status.ts";
import { createTestWindow } from "./helpers/dom.ts";

const candidate = (id: string, extras: Partial<{ title: string; materializable: boolean; codeStatus: "none" | "scaffold" }> = {}) => ({
  candidateId: id,
  title: extras.title ?? id,
  materializable: extras.materializable ?? true,
  codeStatus: extras.codeStatus ?? "scaffold" as const,
});

const status = (id: string, extras: Partial<ReferenceCacheStatus> = {}): ReferenceCacheStatus => ({
  candidateId: id,
  image: extras.image ?? "missing",
  archive: extras.archive ?? "missing",
  ...(extras.pack ? { pack: extras.pack } : {}),
  ...(extras.error ? { error: extras.error } : {}),
});

test("gallery cache labels distinguish preview images from reference packs", () => {
  assert.deepEqual(imageCacheLabel("missing"), { tone: "empty", text: "待缓存" });
  assert.deepEqual(imageCacheLabel("cached"), { tone: "image", text: "已缓存" });
  assert.equal(referencePackLabel({ archive: "missing" }, { codeStatus: "scaffold" }).text, "待缓存");
  assert.equal(referencePackLabel({ archive: "not_applicable" }, { codeStatus: "scaffold" }).text, "不可获取");
  assert.equal(referencePackLabel({ archive: "cached" }, { codeStatus: "scaffold" }).text, "已缓存");
  assert.equal(referencePackLabel({ archive: "missing", pack: { target: "/tmp", files: [], hasCode: true, prompt: "p" } }, { codeStatus: "scaffold" }).text, "已缓存");
  assert.match(referenceStatusText(status("a", { image: "cached", archive: "missing" }), { codeStatus: "scaffold" }), /预览图：已缓存 · 参考包：待缓存/u);
  assert.match(referenceStatusText(status("a", { image: "cached", archive: "cached" }), { codeStatus: "scaffold" }), /预览图：已缓存 · 参考包：已缓存/u);
});

test("copying a reference uses cached pack prompts and caches missing packs first", () => {
  const ready = candidate("ready");
  const missing = candidate("missing");
  const noCode = candidate("nocode");
  const blocked = candidate("blocked", { materializable: false });
  const plan = planReferenceCopy(
    [ready, missing, noCode, blocked],
    [
      status("ready", { image: "cached", archive: "cached", pack: { target: "/r", files: ["code/a.R"], hasCode: true, prompt: "READY" } }),
      status("missing", { image: "missing", archive: "missing" }),
      status("nocode", { image: "cached", archive: "cached", pack: { target: "/n", files: ["plot.png"], hasCode: false, prompt: "NOCODE" } }),
      status("blocked", { image: "missing", archive: "not_applicable" }),
    ],
  );
  assert.deepEqual(plan.ready.map((item) => item.candidate.candidateId), ["ready"]);
  assert.deepEqual(plan.ready.map((item) => item.prompt), ["READY"]);
  assert.deepEqual(plan.needsCache.map((item) => item.candidateId), ["missing"]);
  assert.deepEqual(plan.blocked.map((item) => item.candidate.candidateId), ["nocode", "blocked"]);
  assert.equal(joinReferencePrompts(["A", "B"]), "A\n\n————\n\nB");
});

test("copy planning reports missing status instead of treating it as cacheable", () => {
  const plan = planReferenceCopy([candidate("gone")], []);
  assert.equal(plan.needsCache.length, 0);
  assert.equal(plan.ready.length, 0);
  assert.match(plan.blocked[0]!.reason, /无法读取/u);
});

test("gallery cards render separate preview and reference-pack chips", async () => {
  const window = createTestWindow();
  const previous = globalThis.document;
  Object.defineProperty(globalThis, "document", { configurable: true, value: window.document });
  try {
    const { referenceStatusFacts } = await import("../app/local/reference-cache.ts");
    const facts = referenceStatusFacts(
      status("a", { image: "cached", archive: "missing" }),
      { codeStatus: "scaffold" },
    );
    assert.equal(facts.querySelectorAll(".reference-status-chip").length, 2);
    assert.match(facts.textContent ?? "", /预览图/u);
    assert.match(facts.textContent ?? "", /已缓存/u);
    assert.match(facts.textContent ?? "", /参考包/u);
    assert.match(facts.textContent ?? "", /待缓存/u);
    const cachedPack = referenceStatusFacts(
      status("b", { image: "cached", archive: "cached" }),
      { codeStatus: "scaffold" },
    );
    assert.match(cachedPack.textContent ?? "", /参考包/u);
    assert.match(cachedPack.textContent ?? "", /已缓存/u);
    assert.doesNotMatch(cachedPack.textContent ?? "", /待缓存/u);
    assert.doesNotMatch(cachedPack.textContent ?? "", /可复制/u);
    assert.doesNotMatch(cachedPack.textContent ?? "", /可本地读取/u);
  } finally {
    Object.defineProperty(globalThis, "document", { configurable: true, value: previous });
    window.close();
  }
});
