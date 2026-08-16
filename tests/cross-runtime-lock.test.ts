import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CrossRuntimeWriteLock,
  LIBRARY_WRITE_LOCK_OWNER_SCHEMA,
} from "../src/cross-runtime-lock.ts";

test("failed acquire never removes a replacement writer's canonical lock", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-lock-acquire-failure-"));
  try {
    const lockDirectory = path.join(root, "locks", "write");
    const recoveredDirectory = path.join(root, "recovered-original-lock");
    const replacementLockId = "replacement-writer-lock";
    const lock = new CrossRuntimeWriteLock({
      root,
      libraryId: "test-library",
      operation: "failing-acquire",
      heartbeatIntervalMs: 60_000,
    });

    // Simulate explicit recovery moving this instance's lock after owner.json
    // was written, followed by another writer acquiring the canonical path.
    // The original acquire then fails while initializing its first heartbeat.
    (lock as unknown as { writeHeartbeat: () => Promise<void> }).writeHeartbeat = async () => {
      await fs.rename(lockDirectory, recoveredDirectory);
      await fs.mkdir(lockDirectory);
      await fs.writeFile(
        path.join(lockDirectory, "owner.json"),
        `${JSON.stringify(
          {
            schema: LIBRARY_WRITE_LOCK_OWNER_SCHEMA,
            lockId: replacementLockId,
            libraryId: "test-library",
            operation: "replacement-writer",
            hostname: "replacement-host",
            platform: process.platform,
            runtime: "node",
            processId: process.pid,
            createdAt: new Date().toISOString(),
            heartbeatIntervalMs: 60_000,
          },
          null,
          2,
        )}\n`,
        { flag: "wx" },
      );
      throw new Error("simulated initial heartbeat failure");
    };

    await assert.rejects(lock.acquire(), /simulated initial heartbeat failure/u);

    const replacementOwner = JSON.parse(
      await fs.readFile(path.join(lockDirectory, "owner.json"), "utf8"),
    ) as { lockId: string };
    assert.equal(replacementOwner.lockId, replacementLockId);
    assert.equal(
      (await fs.stat(path.join(recoveredDirectory, "owner.json"))).isFile(),
      true,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
