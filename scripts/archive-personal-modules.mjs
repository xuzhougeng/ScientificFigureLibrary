#!/usr/bin/env node
import { runPersonalModulesCli } from "./personal-modules-lib.mjs";
try {
  await runPersonalModulesCli("archive");
} catch (error) {
  console.error(`PERSONAL_MODULES_ARCHIVE_FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
