import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { cacheStateDatabase } from "../src/local/cache-state-db.ts";

test("cache state database persists per-gallery identity and timestamps", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-cache-state-test-"));
  const first = await cacheStateDatabase(root);
  first.put({
    providerId: "figureya", kind: "source-archive", sourceIdentity: "catalog-a", cacheRoot: path.join(root, "source-packs"),
    declaredCount: 10, cachedCount: 7, missingCount: 3, bytesDeclared: 100, bytesCached: 70,
    lastScannedAt: "2026-09-18T00:00:00.000Z", lastCachedAt: "2026-09-18T00:01:00.000Z",
  });
  assert.equal(first.get("figureya", "source-archive", "catalog-a")?.cachedCount, 7);
  assert.equal(first.get("figureya", "source-archive", "catalog-b"), undefined);
  first.close();

  const second = await cacheStateDatabase(root);
  assert.equal(second.get("figureya", "source-archive", "catalog-a")?.lastCachedAt, "2026-09-18T00:01:00.000Z");
  second.close();
});
