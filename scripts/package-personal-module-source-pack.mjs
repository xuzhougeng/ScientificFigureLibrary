#!/usr/bin/env node
import { runPersonalModulesCli } from "./personal-modules-lib.mjs";
try {
  await runPersonalModulesCli("source-pack");
} catch (error) {
  console.error(`PERSONAL_MODULES_SOURCE_PACK_FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
