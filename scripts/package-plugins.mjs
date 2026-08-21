#!/usr/bin/env node

import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { unzipSync } from "fflate";
import {
  assertFinalCommunitySnapshot,
  auditPackageContents,
  publishReleaseArtifacts,
  runNpm,
  temporaryDirectory,
} from "./package-release-lib.mjs";

const execFile = promisify(execFileCallback);
const root = path.resolve(import.meta.dirname, "..");
const packageJson = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));

// This gate intentionally precedes build and every release-directory write.
await assertFinalCommunitySnapshot({ repositoryRoot: root });
await runNpm(root, ["run", "build"]);
// Recheck after build to fail closed if a concurrent sync changed the snapshot.
await assertFinalCommunitySnapshot({ repositoryRoot: root });

const temporary = await temporaryDirectory("sfl all plugin release candidates");
try {
  const staging = path.join(temporary, "all verified host artifacts");
  await fs.mkdir(staging, { recursive: true });
  for (const host of ["wisp", "codex", "claude"]) {
    const { stdout, stderr } = await execFile(
      process.execPath,
      [path.join(root, "scripts", `package-${host}.mjs`)],
      {
        cwd: root,
        env: { ...process.env, SFL_RELEASE_STAGING_DIR: staging },
        encoding: "utf8",
        windowsHide: true,
        timeout: 180_000,
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    if (stdout.trim()) console.log(stdout.trim());
    if (stderr.trim()) console.error(stderr.trim());
  }

  const expected = [];
  for (const host of ["wisp", "codex", "claude"]) {
    const zipName = `scientific-figure-library-${host}-${packageJson.version}.zip`;
    expected.push(zipName, `${zipName}.sha256`);
  }
  const observed = (await fs.readdir(staging)).sort();
  if (JSON.stringify(observed) !== JSON.stringify(expected.sort())) {
    throw new Error(
      `staged plugin artifact inventory differs: expected=${expected.join(",")} observed=${observed.join(",")}`,
    );
  }
  const artifacts = new Map();
  for (const relative of observed) artifacts.set(relative, new Uint8Array(await fs.readFile(path.join(staging, relative))));
  for (const host of ["wisp", "codex", "claude"]) {
    const zipName = `scientific-figure-library-${host}-${packageJson.version}.zip`;
    const bytes = artifacts.get(zipName);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const sidecar = Buffer.from(artifacts.get(`${zipName}.sha256`)).toString("utf8").trim();
    if (sidecar !== `${digest}  ${zipName}`) throw new Error(`${zipName} staged SHA-256 sidecar is invalid`);
    auditPackageContents(unzipSync(bytes), { label: zipName, repositoryRoot: root });
  }
  await publishReleaseArtifacts(root, artifacts);
  console.log(`Published all ${observed.length} verified plugin ZIP/SHA artifacts as one rollback-protected transaction.`);
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}
