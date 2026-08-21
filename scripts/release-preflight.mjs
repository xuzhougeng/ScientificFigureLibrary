#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertFinalCommunitySnapshot } from "./package-release-lib.mjs";

export async function main(options = {}) {
  const repositoryRoot = path.resolve(
    options.repositoryRoot ?? path.resolve(import.meta.dirname, ".."),
  );
  const result = await assertFinalCommunitySnapshot({ repositoryRoot });
  if (!options.quiet) {
    console.log(
      `Release Community preflight OK: ${result.releaseCount} releases; ` +
        `required=${result.requiredReleases.join(",")}; catalogCommit=${result.catalogCommit}`,
    );
  }
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`RELEASE_PREFLIGHT_FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
