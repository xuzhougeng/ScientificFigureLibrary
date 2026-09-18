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
  image: extras.image ?? "not_cached",
  reference: extras.reference ?? "missing",
  ...(extras.cached ? { cached: extras.cached } : {}),
  ...(extras.error ? { error: extras.error } : {}),
});

test("gallery cache labels distinguish preview cache, bundled files, and exact reference packs", () => {
  assert.deepEqual(imageCacheLabel("not_cached"), { tone: "empty", text: "待缓存" });
  assert.deepEqual(imageCacheLabel("bundled"), { tone: "bundled", text: "可本地读取" });
  assert.deepEqual(imageCacheLabel("preview_cached"), { tone: "image", text: "已缓存" });
  assert.equal(referencePackLabel({ reference: "missing" }, { codeStatus: "scaffold" }).text, "待缓存");
  assert.equal(referencePackLabel({ reference: "missing" }, { codeStatus: "none" }).text, "仅图片 · 待缓存");
  assert.equal(referencePackLabel({ reference: "ready", cached: { target: "/tmp", files: [], hasCode: true, prompt: "p" } }, { codeStatus: "scaffold" }).text, "已缓存 · 含代码");
  assert.match(referenceStatusText(status("a", { image: "preview_cached", reference: "missing" }), { codeStatus: "scaffold" }), /预览图：已缓存 · 参考包：待缓存/u);
});

test("copying a reference uses cached prompts and caches missing packs first", () => {
  const ready = candidate("ready");
  const missing = candidate("missing");
  const invalid = candidate("invalid");
  const noCode = candidate("nocode");
  const blocked = candidate("blocked", { materializable: false });
  const plan = planReferenceCopy(
    [ready, missing, invalid, noCode, blocked],
    [
      status("ready", { image: "preview_cached", reference: "ready", cached: { target: "/r", files: ["code/a.R"], hasCode: true, prompt: "READY" } }),
      status("missing", { image: "not_cached", reference: "missing" }),
      status("invalid", { image: "bundled", reference: "invalid" }),
      status("nocode", { image: "preview_cached", reference: "ready", cached: { target: "/n", files: ["plot.png"], hasCode: false, prompt: "NOCODE" } }),
      status("blocked", { image: "not_cached", reference: "unavailable" }),
    ],
  );
  assert.deepEqual(plan.ready.map((item) => item.candidate.candidateId), ["ready"]);
  assert.deepEqual(plan.ready.map((item) => item.prompt), ["READY"]);
  assert.deepEqual(plan.needsCache.map((item) => item.candidateId), ["missing", "invalid"]);
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
      status("a", { image: "preview_cached", reference: "missing" }),
      { codeStatus: "scaffold" },
    );
    assert.equal(facts.querySelectorAll(".reference-status-chip").length, 2);
    assert.match(facts.textContent ?? "", /预览图/u);
    assert.match(facts.textContent ?? "", /已缓存/u);
    assert.match(facts.textContent ?? "", /参考包/u);
    assert.match(facts.textContent ?? "", /待缓存/u);
  } finally {
    Object.defineProperty(globalThis, "document", { configurable: true, value: previous });
    window.close();
  }
});
