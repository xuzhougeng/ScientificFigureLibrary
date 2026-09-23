import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CustomTagStore, normalizeCustomTags } from "../src/local/custom-tags.ts";
import type { LibraryRuntimeSnapshot } from "../src/library-runtime.ts";

async function setup(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-custom-tags-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const snapshot: LibraryRuntimeSnapshot = { root, directorySource: "FIGURE_LIBRARY_DIR", locatorPath: "", configRevision: null, locatorDigest: null, writesEnabled: true, legacyDefault: false, contextKey: "context-a", libraryId: randomUUID() };
  const store = new CustomTagStore(async () => ({ ...snapshot }), root);
  return { root, snapshot, store };
}
const identity = { providerId: "provider-a", templateId: "same-name" };
const input = (tags: string[], expectedTags: string[] = [], libraryContext = "context-a") => ({ tags, expectedTags, libraryContext });

test("personal tags normalize Unicode, remove blanks/duplicates and enforce limits", () => {
  assert.deepEqual(normalizeCustomTags([" 单细胞 ", "", "单细胞", "e\u0301", "é"]), ["é", "单细胞"]);
  for (const value of [["x".repeat(41)], Array(21).fill("x"), ["a\nb"], ["a,b"], ["a，b"], ["\u0000"]]) assert.throws(() => normalizeCustomTags(value));
});

test("tags survive restart, stay provider/library scoped and can be edited or removed", async t => {
  const { root, snapshot, store } = await setup(t);
  await store.set(identity, input(["单细胞"]));
  await store.set({ ...identity, providerId: "provider-b" }, input(["待使用"]));
  const restarted = new CustomTagStore(async () => ({ ...snapshot }), root);
  assert.equal((await restarted.list()).entries.length, 2);
  await restarted.set(identity, input(["已使用"], ["单细胞"]));
  assert.deepEqual((await store.list()).tags, ["已使用", "待使用"]);
  await store.set(identity, input([], ["已使用"]));
  assert.deepEqual((await store.list()).entries.map(entry => entry.providerId), ["provider-b"]);
  snapshot.libraryId = randomUUID(); snapshot.contextKey = "context-b";
  assert.deepEqual((await store.list()).entries, []);
  await assert.rejects(store.set(identity, input(["x"])), /图库绑定已变化/u);
});

test("serial saves merge different images, stale saves fail, and retry is idempotent", async t => {
  const { store } = await setup(t);
  await Promise.all([store.set(identity, input(["a"])), store.set({ ...identity, templateId: "second" }, input(["b"]))]);
  assert.equal((await store.list()).entries.length, 2);
  await assert.rejects(store.set(identity, input(["c"])), /另一窗口/u);
  await store.set(identity, input(["a"]));
  assert.deepEqual((await store.list()).tags, ["a", "b"]);
});

test("unbound libraries reject writes and a stale binding cannot save", async t => {
  const { snapshot, store } = await setup(t);
  snapshot.writesEnabled = false;
  await assert.rejects(store.set(identity, input(["x"])), /绑定图库/u);
  snapshot.writesEnabled = true;
  snapshot.contextKey = "new-binding";
  await assert.rejects(store.set(identity, input(["x"])), /绑定已变化/u);
});

test("corrupt data and symlinks fail closed without overwriting the original", async t => {
  const { root, snapshot, store } = await setup(t);
  const file = store.file(snapshot.libraryId!);
  await fs.writeFile(file, "broken-json");
  await assert.rejects(store.list(), /原文件已保留/u);
  await assert.rejects(store.set(identity, input(["x"])), /原文件已保留/u);
  assert.equal(await fs.readFile(file, "utf8"), "broken-json");
  await fs.unlink(file);
  const other = path.join(root, "other.json"); await fs.writeFile(other, "untouched");
  await fs.symlink(other, file);
  await assert.rejects(store.list(), /原文件已保留/u);
  await assert.rejects(store.set(identity, input(["x"])), /原文件已保留/u);
  assert.equal(await fs.readFile(other, "utf8"), "untouched");
});
