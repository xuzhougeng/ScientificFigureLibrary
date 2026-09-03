#!/usr/bin/env node
import { runPersonalModulesCli } from "./personal-modules-lib.mjs";
try {
  await runPersonalModulesCli("catalog");
} catch (error) {
  console.error(`PERSONAL_MODULES_CATALOG_FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
