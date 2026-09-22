import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FavoriteStore } from "../src/local/favorites.ts";
import type { ExactTemplateSelector } from "../src/types.ts";

function candidate(providerId = "org.example.first", version = "v1") {
  const exactSelector: ExactTemplateSelector = {
    schema: "figure-library.provider-selector.v1", providerId,
    kind: "test.v1", identity: { templateId: "same-name", version },
  };
  return { providerId, templateId: "same-name", title: "常用热图", sourceLabel: providerId,
    application: "比较基因表达", exactSelector };
}
async function temporary(t: { after(fn: () => Promise<void>): void }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-favorites-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
test("favorites persist, remain provider/version qualified and remove idempotently", async t => {
  const root = await temporary(t); const store = new FavoriteStore(root);
  assert.deepEqual(await store.list(), []);
  await store.add(candidate());
  const first = (await store.list())[0]!;
  await store.add(candidate());
  assert.deepEqual(await store.list(), [first]);
  await Promise.all([new FavoriteStore(root).add(candidate("org.example.second")),
    new FavoriteStore(root).add(candidate("org.example.first", "v2"))]);
  const restarted = new FavoriteStore(root);
  assert.equal((await restarted.list()).length, 3);
  assert.equal(new Set((await restarted.list()).map(x => x.id)).size, 3);
  await restarted.remove(first.id); await restarted.remove(first.id);
  assert.equal((await store.list()).length, 2);
  assert.equal(await store.get(first.id), undefined);
  const disk = await fs.readFile(path.join(root, (await store.list())[0]!.id + ".json"), "utf8");
  assert.doesNotMatch(disk, /resultSetId|previewReceipt|candidateId|previewChallenge/u);
});
test("invalid identities and damaged records are rejected without overwriting preferences", async t => {
  const root = await temporary(t); const store = new FavoriteStore(root);
  await assert.rejects(store.remove("../other"));
  await assert.rejects(store.add({ ...candidate(), providerId: "org.example.wrong" }));
  await store.add(candidate());
  const entry = (await store.list())[0]!;
  const file = path.join(root, `${entry.id}.json`);
  await fs.writeFile(file, "damaged");
  await assert.rejects(store.list());
  await assert.rejects(store.add(candidate()));
  assert.equal(await fs.readFile(file, "utf8"), "damaged");
});
